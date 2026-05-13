/*
ISWEEP COMPONENT: Extension Background Service Worker

Role: Bridges content scripts and the Flask backend. Receives captions from
youtube_captions.js, calls /event, and returns playback decisions. Also handles
auth, prefs sync, and icon state.

System flow:
  youtube_captions.js -> chrome.runtime.sendMessage('caption') -> handleCaptionDecision
  handleCaptionDecision -> POST /event -> decision -> content script applies action
*/

// Storage Keys
const STORAGE_KEYS = {
  AUTH: 'isweepAuth',
  ENABLED: 'isweepEnabled',
  TOKEN: 'isweep_auth_token',
  USER_ID: 'isweepUserId',
  PREFS: 'isweepPreferences',
  BACKEND_URL: 'isweepBackendUrl',
  DEV_LOCAL_AUTH: 'devLocalAuthEnabled'
};

const TOKEN_KEY = 'isweep_auth_token'; // Shared with site_token_bridge and frontend localStorage

const LOG_PREFIX = '[ISWEEP][BG]';
const CAPTION_LOG_PREFIX = '[ISWEEP][CAPTIONS]';
const MARKER_LOG_PREFIX = '[ISWEEP][MARKERS]';

const DEFAULT_BACKEND = 'http://127.0.0.1:5000';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

const markerCacheByVideoId = new Map();
const AUDIO_CAPTION_DEDUPE_WINDOW_MS = 1600;
const recentCaptionByText = new Map();
const tabCaptureSessionByTabId = new Map();
let activeTabAudioCapture = null;

function normalizeCaptionTextForDedupe(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function shouldSuppressDuplicateCaption(text, source, windowMs = AUDIO_CAPTION_DEDUPE_WINDOW_MS) {
  const normalized = normalizeCaptionTextForDedupe(text);
  if (!normalized) return false;

  const now = Date.now();
  const existing = recentCaptionByText.get(normalized);
  recentCaptionByText.set(normalized, { source, seenAt: now });

  if (!existing) return false;
  if (existing.source === source) return false;
  return (now - existing.seenAt) <= windowMs;
}

// Normalize preferences into a stable shape with blocklist.items always present.
function normalizePreferences(raw) {
  const prefs = raw && typeof raw === 'object' ? raw : {};
  const categories = prefs.categories && typeof prefs.categories === 'object' ? prefs.categories : {};
  const lang = categories.language && typeof categories.language === 'object' ? categories.language : {};

  const candidates = [];
  if (Array.isArray(prefs?.blocklist?.items)) candidates.push(...prefs.blocklist.items);
  if (Array.isArray(prefs?.customWords)) candidates.push(...prefs.customWords);
  if (Array.isArray(lang.items)) candidates.push(...lang.items);
  if (Array.isArray(lang.words)) candidates.push(...lang.words);
  if (Array.isArray(lang.customWords)) candidates.push(...lang.customWords);

  const cleaned = Array.from(
    new Set(
      candidates
        .map((w) => (typeof w === 'string' ? w.trim().toLowerCase() : ''))
        .filter(Boolean)
    )
  );

  const languageDuration = lang.duration || 4;
  const blocklist = {
    enabled: prefs?.blocklist?.enabled !== false,
    mode: prefs?.blocklist?.mode || 'whole_word',
    action: prefs?.blocklist?.action || 'mute',
    duration: prefs?.blocklist?.duration || languageDuration,
    items: cleaned,
  };

  return {
    enabled: prefs.enabled !== false,
    sensitivity: typeof prefs.sensitivity === 'number' ? prefs.sensitivity : 0.9,
    categories: {
      language: {
        enabled: lang.enabled !== false,
        action: lang.action || 'mute',
        duration: languageDuration,
        items: cleaned,
      },
      sexual: {
        enabled: categories.sexual?.enabled !== false,
        action: categories.sexual?.action || 'skip',
        duration: categories.sexual?.duration || 12,
      },
      violence: {
        enabled: categories.violence?.enabled !== false,
        action: categories.violence?.action || 'fast_forward',
        duration: categories.violence?.duration || 8,
      },
    },
    blocklist,
  };
}

// Auth/debug helpers (never log full token)
let didLogBackendHealth = false;

async function logBackendHealthOnce() {
  if (didLogBackendHealth) return;
  didLogBackendHealth = true;
  const backendUrl = await getBackendUrl();
  try {
    const res = await fetch(`${backendUrl}/health`);
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body && body.status === 'ok') {
        console.log('[ISWEEP][BG][AUTH] Backend reachable', { backendUrl, status: res.status });
        return;
      }
    }
    console.log('[ISWEEP][BG][AUTH] Backend unreachable', { backendUrl, status: res.status });
  } catch (err) {
    console.log('[ISWEEP][BG][AUTH] Backend unreachable', { backendUrl, error: err?.message || String(err) });
  }
}

async function getCaptionBackendStatus() {
  const backendUrl = await getBackendUrl();
  try {
    const res = await fetch(`${backendUrl}/health`);
    if (!res.ok) {
      return { state: 'backend_offline', ok: false };
    }
    const body = await res.json().catch(() => ({}));
    const sttEnabled = body?.stt_enabled === true;
    return {
      state: sttEnabled ? 'ready' : 'stt_disabled',
      ok: true,
      sttEnabled,
    };
  } catch (err) {
    return { state: 'backend_offline', ok: false, error: err?.message || String(err) };
  }
}

async function getActiveTabCaptionRuntimeStatus() {
  if (!chrome.tabs?.query) return null;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(activeTab.id, { type: 'isweep_get_caption_runtime_status' });
  } catch (_) {
    return null;
  }
}

async function handleCaptionRuntimeStatus() {
  const backend = await getCaptionBackendStatus();
  const tabStatus = await getActiveTabCaptionRuntimeStatus();

  let state = backend.state || 'backend_offline';
  let label = 'Audio captions: Backend offline';

  if (tabStatus?.usingAudioStt) {
    state = 'ready';
    label = 'Audio captions: Ready';
  } else if (tabStatus?.usingYoutubeFallback) {
    state = 'youtube_fallback';
    label = 'Captions: YouTube fallback';
  } else if (backend.state === 'ready') {
    state = 'ready';
    label = 'Audio captions: Ready';
  } else if (backend.state === 'stt_disabled') {
    state = 'stt_disabled';
    label = 'Audio captions: STT disabled';
  }

  const response = { state, label, backend, tabStatus };
  console.log(CAPTION_LOG_PREFIX, 'popup runtime status', response);
  return response;
}

async function getActiveYouTubeTab() {
  if (!chrome.tabs?.query) return null;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return null;
  const url = String(activeTab.url || '');
  if (!/youtube\.com\/watch/i.test(url)) return null;
  return activeTab;
}

function getYouTubeVideoIdFromUrl(url) {
  try {
    const value = new URL(String(url || ''));
    return String(value.searchParams.get('v') || '').trim();
  } catch (_) {
    return '';
  }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) return false;
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl],
    });
    if (Array.isArray(existing) && existing.length > 0) return true;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture active tab audio for ISweep clean captions',
  });
  return true;
}

async function postTabCaptureStatusToTab(tabId, state, failureReason = null) {
  if (!Number.isFinite(Number(tabId))) return;
  try {
    await chrome.tabs.sendMessage(Number(tabId), {
      type: 'isweep_tab_audio_capture_status',
      state,
      failure_reason: failureReason,
    });
  } catch (_) {
    // Best effort status fanout.
  }
}

function classifyTabCaptureError(error) {
  const name = String(error?.name || '').trim();
  const message = String(error?.message || error || '').trim();
  if (name === 'NotAllowedError' || /denied|permission|not allowed/i.test(message)) {
    return 'audio_capture_permission_denied';
  }
  return 'audio_capture_unavailable';
}

async function requestTabCaptureStreamId(tabId) {
  console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture start requested', { tabId });
  if (!chrome.tabCapture?.getMediaStreamId) {
    console.warn('[ISWEEP][AUDIO_CAPTIONS] audio_capture_unavailable', {
      tabId,
      reason: 'tabCapture API unavailable',
    });
    return { ok: false, failure_reason: 'audio_capture_unavailable' };
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    tabCaptureSessionByTabId.set(tabId, { streamId, startedAt: Date.now() });
    console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture stream ready', { tabId });
    return { ok: true, streamId };
  } catch (error) {
    const failureReason = classifyTabCaptureError(error);
    console.warn(`[ISWEEP][AUDIO_CAPTIONS] ${failureReason}`, {
      tabId,
      error: error?.message || String(error),
    });
    return { ok: false, failure_reason: failureReason };
  }
}

async function startTabAudioCapture(tabId, videoId) {
  console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture start requested', { tabId, videoId });
  const stream = await requestTabCaptureStreamId(tabId);
  if (!stream?.ok || !stream.streamId) {
    return { ok: false, failure_reason: stream?.failure_reason || 'audio_capture_unavailable' };
  }

  const offscreenReady = await ensureOffscreenDocument();
  if (!offscreenReady) {
    return { ok: false, failure_reason: 'audio_capture_unavailable' };
  }

  const response = await chrome.runtime.sendMessage({
    type: 'isweep_offscreen_start_tab_capture',
    tab_id: tabId,
    video_id: videoId,
    stream_id: stream.streamId,
  });

  if (!response?.ok) {
    const failureReason = response?.failure_reason || 'audio_capture_unavailable';
    releaseTabCaptureSession(tabId, 'offscreen_start_failed');
    return { ok: false, failure_reason: failureReason };
  }

  activeTabAudioCapture = {
    tabId,
    videoId,
    startedAt: Date.now(),
  };
  console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture stream ready', { tabId, videoId });
  return { ok: true, tabId, videoId };
}

async function stopTabAudioCapture(reason = 'captions_disabled') {
  const active = activeTabAudioCapture;
  activeTabAudioCapture = null;
  if (!active) {
    console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture stopped', { reason, active: false });
    return { ok: true };
  }
  try {
    await chrome.runtime.sendMessage({
      type: 'isweep_offscreen_stop_tab_capture',
      reason,
      tab_id: active.tabId,
    });
  } catch (_) {
    // Best effort stop signal.
  }
  releaseTabCaptureSession(active.tabId, reason);
  await postTabCaptureStatusToTab(active.tabId, 'stopped', null);
  console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture stopped', { reason, tabId: active.tabId, videoId: active.videoId });
  return { ok: true };
}

async function relayAudioCaptionResultToTab(result) {
  const tabId = Number(activeTabAudioCapture?.tabId);
  if (!Number.isFinite(tabId)) return false;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'isweep_audio_caption_text',
      text: result?.text || result?.clean_text || result?.cleaned_text || '',
      source: result?.source || 'audio_stt',
      confidence: Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : 0,
      status: result?.status || 'error',
      failure_reason: result?.failure_reason || null,
      start_seconds: result?.start_seconds,
      end_seconds: result?.end_seconds,
      events: Array.isArray(result?.events) ? result.events : [],
      cleaned_captions: Array.isArray(result?.cleaned_captions) ? result.cleaned_captions : [],
      clean_captions: Array.isArray(result?.clean_captions) ? result.clean_captions : [],
      clean_text: result?.clean_text || null,
      cleaned_text: result?.cleaned_text || null,
      words: Array.isArray(result?.words) ? result.words : [],
      cached: result?.cached === true,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function releaseTabCaptureSession(tabId, reason = 'released') {
  if (!Number.isFinite(Number(tabId))) return;
  if (tabCaptureSessionByTabId.has(tabId)) {
    tabCaptureSessionByTabId.delete(tabId);
    console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture session released', { tabId, reason });
  }
}

async function handleCaptionCaptureControl(enabled) {
  if (enabled) return handleStartTabAudioCaptions();
  return handleStopTabAudioCaptions();
}

async function handleStartTabAudioCaptions() {
  const activeTab = await getActiveYouTubeTab();
  if (!activeTab?.id) {
    return { ok: false, failure_reason: 'youtube_tab_not_found' };
  }
  const tabId = Number(activeTab.id);
  const videoId = getYouTubeVideoIdFromUrl(activeTab.url);
  await postTabCaptureStatusToTab(tabId, 'starting', null);

  const start = await startTabAudioCapture(tabId, videoId);
  if (!start.ok) {
    await postTabCaptureStatusToTab(tabId, 'unavailable', start.failure_reason || 'audio_capture_unavailable');
    return start;
  }
  await postTabCaptureStatusToTab(tabId, 'ready', null);
  return { ok: true, tabId, video_id: videoId, source: 'tab_capture' };
}

async function handleStopTabAudioCaptions() {
  await stopTabAudioCapture('captions_disabled');
  return { ok: true };
}

async function getBackendUrl() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]);
  return store[STORAGE_KEYS.BACKEND_URL] || DEFAULT_BACKEND;
}

function isLocalBackendUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return value.startsWith('http://127.0.0.1') || value.startsWith('http://localhost');
}

async function getDevLocalAuthContext() {
  const backendUrl = await getBackendUrl();
  const store = await chrome.storage.local.get([STORAGE_KEYS.DEV_LOCAL_AUTH, STORAGE_KEYS.PREFS]);
  const devFlag = store[STORAGE_KEYS.DEV_LOCAL_AUTH] === true;
  const enabled = devFlag && isLocalBackendUrl(backendUrl);
  if (enabled) {
    console.log('[ISWEEP][AUTH] dev local auth enabled');
  }
  const prefs = normalizePreferences(store[STORAGE_KEYS.PREFS] || {});
  return { enabled, backendUrl, prefs };
}

function escapeRegexWord(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeLocalDecisionFromPreferences(text, prefs) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    return { action: 'none', reason: 'No text provided', duration_seconds: 0, matched_category: null };
  }
  if (!prefs || prefs.enabled === false) {
    return { action: 'none', reason: 'No match', duration_seconds: 0, matched_category: null };
  }

  const blocklistEnabled = prefs?.blocklist?.enabled !== false;
  const blocklistItems = Array.isArray(prefs?.blocklist?.items) ? prefs.blocklist.items : [];
  if (blocklistEnabled && blocklistItems.length) {
    for (const item of blocklistItems) {
      const candidate = String(item || '').trim();
      if (!candidate) continue;
      const pattern = new RegExp(`\\b${escapeRegexWord(candidate).replace(/\s+/g, '\\s+')}\\b`, 'i');
      if (pattern.test(normalizedText)) {
        return {
          action: prefs?.blocklist?.action || prefs?.categories?.language?.action || 'mute',
          reason: `local prefs blocklist match: ${candidate}`,
          duration_seconds: Number(prefs?.blocklist?.duration || prefs?.categories?.language?.duration || 4) || 4,
          matched_category: 'blocklist',
        };
      }
    }
  }

  return { action: 'none', reason: 'No match', duration_seconds: 0, matched_category: null };
}

async function getAuthToken() {
  const store = await chrome.storage.local.get([TOKEN_KEY]);
  const token = store[TOKEN_KEY] || null;
  console.log('[ISWEEP][BG][AUTH] token lookup', {
    source: token ? TOKEN_KEY : null,
    hasToken: Boolean(token),
    length: token ? String(token).length : 0,
  });
  return token;
}

async function fetchPreferences(token, backendUrl) {
  const res = await fetch(`${backendUrl}/preferences`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`status ${res.status} ${body}`);
  }
  const prefs = await res.json();
  const normalized = normalizePreferences(prefs); // Ensure blocklist/items always present
  await chrome.storage.local.set({ [STORAGE_KEYS.PREFS]: normalized });
  return { prefs: normalized, status: res.status };
}

// Icon paths (will use emoji/text as fallback if actual icons don't exist)
const ICON_ENABLED = {
  16: 'icons/icon-16.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png'
};

const ICON_DISABLED = {
  16: 'icons/icon-disabled-16.png',
  48: 'icons/icon-disabled-48.png',
  128: 'icons/icon-disabled-128.png'
};

/**
 * Initialize background service worker
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(LOG_PREFIX, 'installed/updated:', details.reason);
  
  // Set default values if not already set
  const result = await chrome.storage.local.get([STORAGE_KEYS.ENABLED]);
  
  if (result[STORAGE_KEYS.ENABLED] === undefined) {
    // Default to enabled on first install
    await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: true });
    console.log(LOG_PREFIX, 'set default enabled state to true');
  }
  
  // Update icon based on current state
  updateIcon(result[STORAGE_KEYS.ENABLED] !== false);
  logBackendHealthOnce();
});

/**
 * Listen for storage changes and update icon accordingly
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  
  // Check if enabled state changed
  if (changes[STORAGE_KEYS.ENABLED]) {
    const newValue = changes[STORAGE_KEYS.ENABLED].newValue;
    console.log(LOG_PREFIX, 'enabled state changed to:', newValue);
    updateIcon(newValue !== false);
  }
});

if (chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    releaseTabCaptureSession(tabId, 'tab_removed');
    if (activeTabAudioCapture && Number(activeTabAudioCapture.tabId) === Number(tabId)) {
      stopTabAudioCapture('tab_removed').catch(() => {});
    }
  });
}

/**
 * Update extension icon based on enabled state
 * @param {boolean} isEnabled - Whether ISweep is enabled
 */
async function updateIcon(isEnabled) {
  try {
    // Set icon path based on enabled state
    const iconPath = isEnabled ? ICON_ENABLED : ICON_DISABLED;
    
    // Try to set icon (will fail gracefully if icon files don't exist)
    try {
      await chrome.action.setIcon({ path: iconPath });
      console.log(LOG_PREFIX, 'icon updated to:', isEnabled ? 'enabled' : 'disabled');
    } catch (iconError) {
      // If icon files don't exist, set badge text as fallback
      console.log(LOG_PREFIX, 'icon files not found, using badge fallback');
      await chrome.action.setBadgeText({ text: isEnabled ? '✓' : '⏸' });
      await chrome.action.setBadgeBackgroundColor({ 
        color: isEnabled ? '#10b981' : '#6b7280' 
      });
    }
    
    // Set tooltip to indicate current state
    const title = isEnabled ? 'ISweep - Active' : 'ISweep - Paused';
    await chrome.action.setTitle({ title });
    
  } catch (error) {
    console.error(LOG_PREFIX, 'error updating icon:', error);
  }
}

/**
 * Handle messages from content scripts or popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, 'received message:', message);

  if (message.action === 'updateIcon') {
    updateIcon(message.enabled !== false);
    sendResponse({ success: true });
    return; // respond synchronously
  } else if (message.type === 'caption') {
    handleCaptionDecision(message.text, message.caption_duration_seconds).then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_login') {
    handleLogin(message.email, message.password).then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_sync_prefs') {
    handleSyncPrefs().then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_markers_analyze') {
    handleMarkerAnalyze(message.video_id, message.force_refresh === true).then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_audio_chunk') {
    handleAudioAhead(
      message.video_id,
      message.audio_chunk,
      message.mime_type,
      message.start_seconds,
      message.end_seconds,
      message.audio,
      message.sampleRate,
      message.channels
    ).then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_get_caption_runtime_status') {
    handleCaptionRuntimeStatus().then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_start_tab_audio_captions') {
    handleStartTabAudioCaptions().then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_stop_tab_audio_captions') {
    handleStopTabAudioCaptions().then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_caption_capture_control') {
    handleCaptionCaptureControl(message.enabled === true).then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_request_tab_capture_stream') {
    const senderTabId = sender?.tab?.id;
    if (!Number.isFinite(Number(senderTabId))) {
      sendResponse({ ok: false, failure_reason: 'missing_sender_tab' });
      return;
    }
    requestTabCaptureStreamId(Number(senderTabId)).then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_release_tab_capture_stream') {
    const senderTabId = sender?.tab?.id;
    releaseTabCaptureSession(Number(senderTabId), message.reason || 'content_release');
    sendResponse({ ok: true });
    return;
  } else if (message.type === 'isweep_audio_caption_chunk') {
    const targetVideoId = String(message.video_id || activeTabAudioCapture?.videoId || '').trim();
    handleAudioAhead(
      targetVideoId,
      message.audio_chunk,
      message.mime_type,
      message.start_seconds,
      message.end_seconds,
      message.audio,
      message.sampleRate,
      message.channels
    ).then(async (result) => {
      await relayAudioCaptionResultToTab(result);
      sendResponse(result);
    });
    return true; // async
  }

  sendResponse({ ok: false, error: 'unknown message' });
  return; // unknown message handled
});

// Initial icon update on service worker startup
chrome.storage.local.get([STORAGE_KEYS.ENABLED]).then((result) => {
  const isEnabled = result[STORAGE_KEYS.ENABLED] !== false;
  console.log('[ISWEEP][BG] service worker started');
  console.log(LOG_PREFIX, 'service worker started, enabled state:', isEnabled);
  updateIcon(isEnabled);
  logBackendHealthOnce();
});

// Receives caption text from content script, forwards to backend /event, and returns decision.
async function handleCaptionDecision(text, captionDurationSeconds, options = {}) {
  const source = typeof options.source === 'string' ? options.source : 'youtube_dom';
  const dedupeWindowMs = Number.isFinite(Number(options.dedupeWindowMs)) ? Number(options.dedupeWindowMs) : AUDIO_CAPTION_DEDUPE_WINDOW_MS;
  if (shouldSuppressDuplicateCaption(text, source, dedupeWindowMs)) {
    console.log('[ISWEEP][AUDIO_CAPTIONS] duplicate caption suppressed', { source });
    return { action: 'none', reason: 'duplicate caption suppressed', duration_seconds: 0, matched_category: null };
  }

  const backendUrl = await getBackendUrl();
  const token = await getAuthToken();
  if (!token) {
    const devLocal = await getDevLocalAuthContext();
    if (devLocal.enabled) {
      console.log('[ISWEEP][AUTH] using local preferences fallback');
      return makeLocalDecisionFromPreferences(text, devLocal.prefs);
    }
    console.warn('[ISWEEP][BG][AUTH] missing token affected /event', { backendUrl });
    return { action: 'none', reason: 'missing token', duration_seconds: 0, matched_category: null };
  }

  let res;
  let responseBody = '';
  try {
    console.log('[ISWEEP][BG][/event] sending caption', {
      backendUrl,
      textPreview: text ? text.slice(0, 60) : '',
      captionDurationSeconds,
    });
    console.log('[ISWEEP][BG][/event] calling /event', { backendUrl });
    res = await fetch(`${backendUrl}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text, caption_duration_seconds: captionDurationSeconds }),
    });

    responseBody = await res.text();
    if (res.status === 401) {
      console.warn('[ISWEEP][BG][/event] unauthorized; clearing session');
      await chrome.storage.local.remove([TOKEN_KEY, STORAGE_KEYS.USER_ID, STORAGE_KEYS.AUTH, STORAGE_KEYS.PREFS]);
      return { action: 'none', reason: 'unauthorized', duration_seconds: 0, matched_category: null };
    }

    if (!res.ok) {
      const devLocal = await getDevLocalAuthContext();
      if (devLocal.enabled) {
        console.log('[ISWEEP][AUTH] using local preferences fallback');
        return makeLocalDecisionFromPreferences(text, devLocal.prefs);
      }
      const meta = {
        backendUrl,
        status: res.status,
        body: (responseBody || '').slice(0, 200),
        error: `status ${res.status}`,
      };
      // Chrome “Extensions > Errors” stringifies objects as [object Object]; include JSON string for readability.
      console.error(`${LOG_PREFIX} /event failed ${JSON.stringify(meta)}`, meta);
      return { action: 'none', reason: 'Backend unavailable', duration_seconds: 0, matched_category: null };
    }
    let decision = {};
    if (responseBody) {
      try {
        decision = JSON.parse(responseBody);
      } catch (parseErr) {
        console.error(LOG_PREFIX, 'failed to parse /event response', {
          backendUrl,
          body: (responseBody || '').slice(0, 200),
          error: parseErr?.message || parseErr,
        });
        throw new Error('invalid JSON from backend');
      }
    }
    // Expected keys: action, duration_seconds, matched_category, reason
    console.log('[ISWEEP][BG][/event] decision received', decision);
    return decision;
  } catch (err) {
    const devLocal = await getDevLocalAuthContext();
    if (devLocal.enabled) {
      console.log('[ISWEEP][AUTH] using local preferences fallback');
      return makeLocalDecisionFromPreferences(text, devLocal.prefs);
    }
    const meta = {
      backendUrl,
      status: res?.status,
      body: (responseBody || '').slice(0, 200),
      error: err?.message || String(err),
    };
    console.error(`${LOG_PREFIX} /event failed ${JSON.stringify(meta)}`, meta);
    return { action: 'none', reason: 'Backend unavailable', duration_seconds: 0, matched_category: null };
  }
}

async function handleMarkerAnalyze(videoId, forceRefresh = false) {
  const cleanVideoId = (videoId || '').trim();
  if (!cleanVideoId) {
    return { status: 'error', source: null, events: [], failure_reason: 'missing_video_id' };
  }

  if (!forceRefresh && markerCacheByVideoId.has(cleanVideoId)) {
    const cached = markerCacheByVideoId.get(cleanVideoId);
    console.log(MARKER_LOG_PREFIX, 'cache hit', { videoId: cleanVideoId, status: cached.status, events: cached.events?.length || 0 });
    return { ...cached, cached: true };
  }

  const backendUrl = await getBackendUrl();
  const token = await getAuthToken();
  if (!token) {
    console.warn('[ISWEEP][BG][AUTH] missing token affected /videos/analyze', {
      backendUrl,
      videoId: cleanVideoId,
    });
    return { status: 'unavailable', source: null, events: [], failure_reason: 'missing_token' };
  }

  let res;
  let responseBody = '';
  try {
    console.log(MARKER_LOG_PREFIX, 'analyze start', { videoId: cleanVideoId });
    res = await fetch(`${backendUrl}/videos/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ video_id: cleanVideoId }),
    });

    responseBody = await res.text();
    if (res.status === 401) {
      console.warn(MARKER_LOG_PREFIX, 'unauthorized; clearing session');
      await chrome.storage.local.remove([TOKEN_KEY, STORAGE_KEYS.USER_ID, STORAGE_KEYS.AUTH, STORAGE_KEYS.PREFS]);
      return { status: 'error', source: null, events: [], failure_reason: 'unauthorized' };
    }

    if (!res.ok) {
      const failureReason = res.status === 404 ? 'videos_analyze_missing' : 'backend_http_error';
      console.warn(MARKER_LOG_PREFIX, 'analyze failed', {
        videoId: cleanVideoId,
        status: res.status,
        failureReason,
        body: (responseBody || '').slice(0, 200),
      });
      return { status: 'error', source: null, events: [], failure_reason: failureReason };
    }

    const payload = responseBody ? JSON.parse(responseBody) : {};
    const normalizedCleanedCaptions = Array.isArray(payload.cleaned_captions)
      ? payload.cleaned_captions
      : (Array.isArray(payload.clean_captions) ? payload.clean_captions : []);
    const normalized = {
      status: payload.status || 'error',
      source: payload.source || null,
      events: Array.isArray(payload.events) ? payload.events : [],
      cleaned_captions: normalizedCleanedCaptions,
      failure_reason: payload.failure_reason || null,
    };

    if (normalized.status === 'unavailable' && !normalized.failure_reason) {
      normalized.failure_reason = 'transcript_unavailable';
    }
    if (normalized.status === 'ready' && normalized.events.length === 0 && !normalized.failure_reason) {
      normalized.failure_reason = 'marker_list_empty';
    }

    markerCacheByVideoId.set(cleanVideoId, normalized);
    console.log(MARKER_LOG_PREFIX, 'analyze result', {
      videoId: cleanVideoId,
      status: normalized.status,
      source: normalized.source,
      events: normalized.events.length,
      failure_reason: normalized.failure_reason,
    });
    return normalized;
  } catch (err) {
    const errorText = err?.message || String(err);
    const failureReason = /Failed to fetch|NetworkError|fetch/i.test(errorText)
      ? 'backend_not_running'
      : 'analyze_exception';
    console.error(MARKER_LOG_PREFIX, 'analyze exception', {
      videoId: cleanVideoId,
      status: res?.status,
      body: (responseBody || '').slice(0, 200),
      failureReason,
      error: errorText,
    });
    return { status: 'error', source: null, events: [], failure_reason: failureReason };
  }
}

// Receives a real-time audio chunk from youtube_captions.js, forwards to /captions/transcribe,
// and returns { status, source, events, cleaned_captions, failure_reason, cached }.
async function handleAudioAhead(videoId, audioChunk, mimeType, startSeconds, endSeconds, audioSamples = null, sampleRate = null, channels = null) {
  const AUDIO_LOG = '[ISWEEP][AUDIO_AHEAD]';
  const AUDIO_CAPTIONS_LOG = '[ISWEEP][AUDIO_CAPTIONS]';
  const cleanVideoId = (videoId || '').trim();

  if (!cleanVideoId) {
    return { status: 'error', events: [], failure_reason: 'missing_video_id' };
  }
  const hasSampleArray = Array.isArray(audioSamples) && audioSamples.length > 0;
  if (!audioChunk && !hasSampleArray) {
    return { status: 'error', events: [], failure_reason: 'analyze_exception' };
  }

  const normalizedStart = Number.isFinite(Number(startSeconds)) ? Number(startSeconds) : 0;
  const normalizedEnd = Number.isFinite(Number(endSeconds))
    ? Math.max(Number(endSeconds), normalizedStart)
    : normalizedStart;

  const backendUrl = await getBackendUrl();
  const token = await getAuthToken();
  if (!token) {
    console.warn('[ISWEEP][BG][AUTH] missing token affected /captions/transcribe', {
      backendUrl,
      videoId: cleanVideoId,
    });
    return { status: 'unavailable', events: [], failure_reason: 'missing_token' };
  }

  let res;
  let responseBody = '';
  try {
    console.log(AUDIO_LOG, 'sending chunk', {
      videoId: cleanVideoId,
      startSeconds: normalizedStart,
      endSeconds: normalizedEnd,
      mimeType,
      chunkBytes: audioChunk ? audioChunk.length : 0,
      sampleCount: hasSampleArray ? audioSamples.length : 0,
    });
    console.log(AUDIO_CAPTIONS_LOG, 'chunk sent', {
      videoId: cleanVideoId,
      startSeconds: normalizedStart,
      endSeconds: normalizedEnd,
    });
    res = await fetch(`${backendUrl}/captions/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        video_id: cleanVideoId,
        audio_base64: audioChunk,
        start_time: normalizedStart,
        preferences: normalizePreferences((await chrome.storage.local.get([STORAGE_KEYS.PREFS]))[STORAGE_KEYS.PREFS] || {}),
        audio_chunk: audioChunk,
        mime_type: mimeType || 'audio/wav',
        chunk_start_seconds: normalizedStart,
        chunk_end_seconds: normalizedEnd,
        start_seconds: normalizedStart,
        end_seconds: normalizedEnd,
        audio: hasSampleArray ? audioSamples : undefined,
        sampleRate: Number.isFinite(Number(sampleRate)) ? Number(sampleRate) : undefined,
        channels: Number.isFinite(Number(channels)) ? Number(channels) : undefined,
      }),
    });

    responseBody = await res.text();
    if (res.status === 401) {
      await chrome.storage.local.remove([TOKEN_KEY, STORAGE_KEYS.USER_ID, STORAGE_KEYS.AUTH, STORAGE_KEYS.PREFS]);
      return { status: 'error', events: [], failure_reason: 'unauthorized' };
    }
    if (!res.ok) {
      let backendFailureReason = null;
      try {
        const parsed = responseBody ? JSON.parse(responseBody) : null;
        if (parsed && typeof parsed === 'object') {
          backendFailureReason = typeof parsed.failure_reason === 'string'
            ? parsed.failure_reason
            : (typeof parsed.error === 'string' ? parsed.error : null);
        }
      } catch (_) {}
      const failureReason = 'analyze_exception';
      const meta = {
        videoId: cleanVideoId,
        status: res.status,
        failureReason,
        backend_failure_reason: backendFailureReason,
        body: (responseBody || '').slice(0, 200),
      };
      console.error(`${AUDIO_LOG} chunk failed ${JSON.stringify(meta)}`, meta);
      return {
        status: 'error',
        events: [],
        failure_reason: backendFailureReason || failureReason,
        backend_status: res.status,
        backend_body: (responseBody || '').slice(0, 500),
      };
    }

    const payload = responseBody ? JSON.parse(responseBody) : {};
    const normalizedCleanedCaptions = Array.isArray(payload.cleaned_captions)
      ? payload.cleaned_captions
      : (Array.isArray(payload.clean_captions) ? payload.clean_captions : []);
    const hasDisplayPayload = Boolean(
      (Array.isArray(normalizedCleanedCaptions) && normalizedCleanedCaptions.length)
      || typeof payload.clean_text === 'string'
      || typeof payload.cleaned_text === 'string'
      || typeof payload.caption_text === 'string'
      || typeof payload.text === 'string'
      || (Array.isArray(payload.words) && payload.words.length)
    );
    const normalizedStatus = payload.status || ((Array.isArray(payload.events) || hasDisplayPayload) ? 'ready' : 'error');
    const result = {
      status: normalizedStatus,
      source: payload.source || 'audio',
      start_seconds: normalizedStart,
      end_seconds: normalizedEnd,
      events: Array.isArray(payload.events) ? payload.events : [],
      cleaned_captions: normalizedCleanedCaptions,
      clean_captions: normalizedCleanedCaptions,
      text: typeof payload.text === 'string' ? payload.text : null,
      clean_text: typeof payload.clean_text === 'string' ? payload.clean_text : null,
      cleaned_text: typeof payload.cleaned_text === 'string' ? payload.cleaned_text : null,
      caption_text: typeof payload.caption_text === 'string' ? payload.caption_text : null,
      words: Array.isArray(payload.words) ? payload.words : [],
      failure_reason: payload.failure_reason || payload.reason || null,
      cached: payload.cached === true,
    };
    if (result.source === 'audio_stt_disabled' || result.failure_reason === 'stt_disabled') {
      console.warn(AUDIO_CAPTIONS_LOG, 'STT disabled', {
        videoId: cleanVideoId,
        failure_reason: result.failure_reason,
      });
    }
    if (result.status === 'ready' && typeof result.text === 'string' && result.text.trim()) {
      console.log(AUDIO_CAPTIONS_LOG, 'transcript received', {
        videoId: cleanVideoId,
        textPreview: result.text.slice(0, 80),
      });
    }

    if (
      result.status === 'ready'
      && result.source !== 'audio_stt'
      && result.events.length === 0
      && typeof result.text === 'string'
      && result.text.trim()
    ) {
      const captionDurationSeconds = Math.max(normalizedEnd - normalizedStart, 0);
      const decision = await handleCaptionDecision(result.text, captionDurationSeconds, {
        source: 'audio_stt',
        dedupeWindowMs: AUDIO_CAPTION_DEDUPE_WINDOW_MS,
      });
      if (decision && decision.action && decision.action !== 'none') {
        result.events = [{
          id: `audio-stt-${cleanVideoId}-${normalizedStart}-${decision.action}`,
          action: decision.action,
          start_seconds: normalizedStart,
          end_seconds: normalizedEnd,
          duration_seconds: captionDurationSeconds,
          matched_category: decision.matched_category || null,
          reason: decision.reason || 'audio stt /event decision',
          source: 'audio_stt',
        }];
      }
    }
    console.log(AUDIO_LOG, 'chunk result', {
      videoId: cleanVideoId,
      startSeconds: normalizedStart,
      endSeconds: normalizedEnd,
      status: result.status,
      events: result.events.length,
      failure_reason: result.failure_reason,
    });
    if (result.status !== 'ready') {
      console.warn(AUDIO_LOG, 'chunk unavailable', {
        videoId: cleanVideoId,
        startSeconds: normalizedStart,
        endSeconds: normalizedEnd,
        status: result.status,
        failure_reason: result.failure_reason,
      });
    }
    return result;
  } catch (err) {
    const errorText = err?.message || String(err);
    const failureReason = /Failed to fetch|NetworkError|fetch/i.test(errorText)
      ? 'backend_not_running'
      : 'analyze_exception';
    if (failureReason === 'backend_not_running') {
      console.warn(AUDIO_CAPTIONS_LOG, 'backend offline', { videoId: cleanVideoId });
    }
    console.error(AUDIO_LOG, 'chunk exception', {
      videoId: cleanVideoId,
      failureReason,
      error: errorText,
    });
    return { status: 'error', events: [], failure_reason: failureReason };
  }
}

async function handleLogin(email, password) {
  const backendUrl = await getBackendUrl();
  console.log('[ISWEEP][BG][AUTH] login start', backendUrl);
  try {
    const res = await fetch(`${backendUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status !== 200 && res.status !== 201) {
      const msg = await res.text();
      console.warn('[ISWEEP][BG][AUTH] login failed', res.status, msg || '');
      return { ok: false, error: msg || `status ${res.status}` };
    }
    const data = await res.json();
    const token = data.token;
    const userId = data.user_id;
    await chrome.storage.local.set({
      [TOKEN_KEY]: token,
      [STORAGE_KEYS.USER_ID]: userId,
      [STORAGE_KEYS.AUTH]: { email, loggedInAt: new Date().toISOString() },
    });
    try {
      await fetchPreferences(token, backendUrl);
    } catch (prefErr) {
      console.warn('[ISWEEP][BG][AUTH] prefs sync failed after login', prefErr?.message || prefErr);
    }
    console.log('[ISWEEP][BG][AUTH] login success', res.status);
    return { ok: true, status: res.status };
  } catch (err) {
    console.error('[ISWEEP][BG][AUTH] login failed', err?.message || err);
    return { ok: false, error: err?.message || 'login failed' };
  }
}

async function handleSyncPrefs() {
  const backendUrl = await getBackendUrl();
  const token = await getAuthToken();
  if (!token) {
    const devLocal = await getDevLocalAuthContext();
    if (devLocal.enabled) {
      console.log('[ISWEEP][AUTH] using local preferences fallback');
      return { ok: true, status: 'local_prefs_fallback' };
    }
    console.warn(LOG_PREFIX, 'sync prefs missing token');
    return { ok: false, error: 'missing token' };
  }
  console.log(LOG_PREFIX, 'prefs sync start');
  try {
    const result = await fetchPreferences(token, backendUrl);
    console.log(LOG_PREFIX, 'prefs sync success', result.status);
    return { ok: true, status: result.status };
  } catch (err) {
    console.warn(LOG_PREFIX, 'prefs sync failed', err?.message || err);
    return { ok: false, error: err?.message || 'sync failed' };
  }
}
