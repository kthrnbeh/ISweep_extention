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
  CLEAN_CAPTION_SETTINGS: 'isweepCleanCaptionSettings',
  DEV_LOCAL_AUTH: 'devLocalAuthEnabled',
  LOCAL_REFERENCES: 'isweepLocalReferences'
};

const TOKEN_KEY = 'isweep_auth_token'; // Shared with site_token_bridge and frontend localStorage

const LOG_PREFIX = '[ISWEEP][BG]';
const CAPTION_LOG_PREFIX = '[ISWEEP][CAPTIONS]';
const MARKER_LOG_PREFIX = '[ISWEEP][MARKERS]';
const AUDIO_CAPTIONS_BG_LOG = '[ISWEEP][AUDIO_CAPTIONS][BG]';
const CAPTION_LATENCY_LOG = '[ISWEEP][CAPTION_LATENCY]';

const DEFAULT_BACKEND = 'http://127.0.0.1:5000';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const LOCAL_DEV_CAPTION_EMAIL = 'local-captions@isweep.dev';
const LOCAL_DEV_CAPTION_PASSWORD = 'LocalCaption1089!';
const CAPTION_HEALTH_TIMEOUT_MS = 2500;

const CLEAN_CAPTION_DEFAULTS = {
  cleanCaptionsEnabled: true,
  cleanCaptionWordMuteMode: 'captions_only',
};

const captionReadinessState = {
  lastCaptionAt: null,
  lastCaptionLatencyMs: null,
  lastError: null,
  lastFailureReason: null,
  lastSttStatus: 'unknown',
  lastSttError: null,
};

const markerCacheByVideoId = new Map();
const AUDIO_CAPTION_DEDUPE_WINDOW_MS = 1600;
const AUDIO_CAPTION_FILTER_ACTIONS_ENABLED = false; // Caption-only mode: keep false until filtering is intentionally re-enabled
const recentCaptionByText = new Map();
const recentRelayByTabId = new Map();
const tabCaptureSessionByTabId = new Map();
const captionTranscribeQueueByTabId = new Map();
let activeTabAudioCapture = null;
let didLogBackendUrl = false;
const CAPTION_TRANSCRIBE_INTERVAL_MS = 750;
const AUDIO_RELAY_DEDUPE_WINDOW_MS = 1200;
const CAPTION_RESULT_ID_CACHE_LIMIT = 160;
const CAPTION_RESULT_ID_CACHE_TTL_MS = 2 * 60 * 1000;

const AUDIO_DIAG_LOG = '[ISWEEP][AUDIO_DIAG]';
const CAPTION_STATE_LOG = '[ISWEEP][CAPTION_STATE]';

const captionTimelineByTabId = new Map();
const referenceProviderRegistry = [];
const referenceLookupCacheByVideoId = new Map();
const REFERENCE_CACHE_TTL_MS = 10 * 60 * 1000;

function getCaptionTimelineState(tabId) {
  const key = Number(tabId);
  if (!Number.isFinite(key)) return null;
  if (!captionTimelineByTabId.has(key)) {
    captionTimelineByTabId.set(key, {
      tabId: key,
      sessionId: null,
      videoId: null,
      lastSequenceNumber: 0,
      lastAudioWindowEndMs: -1,
      lastChunkId: null,
      lastDroppedReason: null,
      recentRelayResultIds: new Map(),
      updatedAt: Date.now(),
    });
  }
  return captionTimelineByTabId.get(key);
}

function buildCaptionResultId(payload = {}) {
  const tabId = Number.isFinite(Number(payload.tab_id)) ? Number(payload.tab_id) : 0;
  const sessionId = String(payload.session_id || '').trim() || 'no_session';
  const chunkId = String(payload.chunk_id || '').trim() || 'no_chunk';
  const windowEndMs = Number.isFinite(Number(payload.audio_window_end_ms))
    ? Number(payload.audio_window_end_ms)
    : -1;
  return `${tabId}|${sessionId}|${chunkId}|${windowEndMs}`;
}

function trimRecentCaptionResultIds(cacheMap) {
  if (!(cacheMap instanceof Map)) return;
  const now = Date.now();
  for (const [key, seenAt] of cacheMap.entries()) {
    if ((now - Number(seenAt || 0)) > CAPTION_RESULT_ID_CACHE_TTL_MS) {
      cacheMap.delete(key);
    }
  }
  while (cacheMap.size > CAPTION_RESULT_ID_CACHE_LIMIT) {
    const oldestKey = cacheMap.keys().next().value;
    if (typeof oldestKey === 'undefined') break;
    cacheMap.delete(oldestKey);
  }
}

function shouldDropDuplicateRelayByResultId(tabId, relayMsg) {
  const timeline = getCaptionTimelineState(tabId);
  if (!timeline) return false;
  const cache = timeline.recentRelayResultIds instanceof Map
    ? timeline.recentRelayResultIds
    : new Map();
  timeline.recentRelayResultIds = cache;
  trimRecentCaptionResultIds(cache);
  const resultId = buildCaptionResultId(relayMsg);
  if (cache.has(resultId)) {
    timeline.lastDroppedReason = 'duplicate_relay_result_id';
    timeline.updatedAt = Date.now();
    console.log(CAPTION_STATE_LOG, 'duplicate relay dropped', {
      tab_id: Number(tabId),
      result_id: resultId,
      chunk_id: relayMsg?.chunk_id || null,
      audio_window_end_ms: relayMsg?.audio_window_end_ms ?? null,
    });
    return true;
  }
  cache.set(resultId, Date.now());
  trimRecentCaptionResultIds(cache);
  return false;
}

function normalizeReferenceLineText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeLocalReferenceInput(payload = {}) {
  const videoId = String(payload.video_id || '').trim();
  if (!videoId) {
    return { ok: false, error: 'missing_video_id' };
  }
  const rawTitle = String(payload.title || '').trim();
  const rawType = String(payload.reference_type || '').trim();
  const referenceType = rawType || 'user_provided_lyrics';
  const linesInput = Array.isArray(payload.lines) ? payload.lines : [];
  const pastedLyrics = String(payload.pasted_lyrics || payload.lyrics_text || '').trim();

  const parsedLines = linesInput.length
    ? linesInput
      .map((entry, index) => ({
        id: String(entry?.id || `line_${String(index + 1).padStart(3, '0')}`),
        text: normalizeReferenceLineText(entry?.text || ''),
      }))
      .filter((entry) => entry.text)
    : pastedLyrics
      .split(/\r?\n/)
      .map((line) => normalizeReferenceLineText(line))
      .filter(Boolean)
      .map((line, index) => ({
        id: `line_${String(index + 1).padStart(3, '0')}`,
        text: line,
      }));

  if (!parsedLines.length) {
    return { ok: false, error: 'empty_reference_lines' };
  }

  return {
    ok: true,
    reference: {
      video_id: videoId,
      title: rawTitle,
      reference_type: referenceType,
      provenance: 'user_supplied',
      approval_status: 'local_user_approved',
      lines: parsedLines,
      imported_at: Date.now(),
    },
  };
}

async function importLocalReference(payload = {}) {
  const normalized = normalizeLocalReferenceInput(payload);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  const store = await chrome.storage.local.get([STORAGE_KEYS.LOCAL_REFERENCES]);
  const existing = store && typeof store[STORAGE_KEYS.LOCAL_REFERENCES] === 'object' && store[STORAGE_KEYS.LOCAL_REFERENCES]
    ? store[STORAGE_KEYS.LOCAL_REFERENCES]
    : {};
  const merged = {
    ...existing,
    [normalized.reference.video_id]: normalized.reference,
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.LOCAL_REFERENCES]: merged,
  });
  return {
    ok: true,
    video_id: normalized.reference.video_id,
    line_count: normalized.reference.lines.length,
    approval_status: normalized.reference.approval_status,
  };
}

function resetCaptionTimelineForTab(tabId, reason = 'reset') {
  const key = Number(tabId);
  if (!Number.isFinite(key)) return;
  captionTimelineByTabId.delete(key);
  recentRelayByTabId.delete(key);
  console.log(CAPTION_STATE_LOG, 'timeline reset', { tabId: key, reason });
  if (chrome.tabs?.sendMessage) {
    chrome.tabs.sendMessage(key, {
      type: 'isweep_caption_state_reset',
      reason,
    }).catch(() => {});
  }
}

function registerReferenceProvider(provider) {
  if (!provider || typeof provider.lookup !== 'function') return;
  const name = String(provider.name || '').trim() || 'unnamed_provider';
  referenceProviderRegistry.push({
    name,
    lookup: provider.lookup,
  });
}

function normalizeReferenceCandidate(raw, sourceName) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    source_name: String(data.source_name || sourceName || 'unknown_source'),
    source_url: String(data.source_url || '').trim(),
    title_match_score: Number.isFinite(Number(data.title_match_score)) ? Number(data.title_match_score) : 0,
    duration_match_score: Number.isFinite(Number(data.duration_match_score)) ? Number(data.duration_match_score) : 0,
    text: String(data.text || '').trim(),
    license_or_permission_status: String(data.license_or_permission_status || 'unknown'),
    timing_available: data.timing_available === true,
    candidate_confidence: Number.isFinite(Number(data.candidate_confidence)) ? Number(data.candidate_confidence) : 0,
  };
}

function getReferenceLookupCache(videoId) {
  const key = String(videoId || '').trim();
  if (!key) return null;
  const cached = referenceLookupCacheByVideoId.get(key);
  if (!cached) return null;
  if ((Date.now() - Number(cached.cachedAt || 0)) > REFERENCE_CACHE_TTL_MS) {
    referenceLookupCacheByVideoId.delete(key);
    return null;
  }
  return cached;
}

async function lookupReferenceCandidatesOnce(videoMeta = {}) {
  const stableVideoId = String(videoMeta.video_id || '').trim();
  if (!stableVideoId) {
    return { video_id: '', cached: false, candidates: [] };
  }

  const cached = getReferenceLookupCache(stableVideoId);
  if (cached) {
    return {
      video_id: stableVideoId,
      cached: true,
      candidates: Array.isArray(cached.candidates) ? cached.candidates : [],
      looked_up_at: Number(cached.cachedAt || Date.now()),
    };
  }

  const candidates = [];
  for (const provider of referenceProviderRegistry) {
    try {
      const result = await provider.lookup({
        video_id: stableVideoId,
        title: String(videoMeta.title || '').trim(),
        channel: String(videoMeta.channel || '').trim(),
        duration_seconds: Number.isFinite(Number(videoMeta.duration_seconds)) ? Number(videoMeta.duration_seconds) : null,
      });
      const entries = Array.isArray(result) ? result : [];
      entries.forEach((candidate) => {
        candidates.push(normalizeReferenceCandidate(candidate, provider.name));
      });
    } catch (err) {
      console.warn('[ISWEEP][EVIDENCE] reference provider failed', {
        provider: provider.name,
        error: String(err?.message || err).slice(0, 120),
      });
    }
  }

  const payload = {
    cachedAt: Date.now(),
    candidates: candidates.map((item) => ({
      source_name: item.source_name,
      source_url: item.source_url,
      title_match_score: item.title_match_score,
      duration_match_score: item.duration_match_score,
      license_or_permission_status: item.license_or_permission_status,
      timing_available: item.timing_available,
      candidate_confidence: item.candidate_confidence,
      // Keep only short-lived metadata by default; raw third-party text is not persisted.
      text_preview: item.text.slice(0, 120),
    })),
  };
  referenceLookupCacheByVideoId.set(stableVideoId, payload);
  return {
    video_id: stableVideoId,
    cached: false,
    candidates,
    looked_up_at: payload.cachedAt,
  };
}

// In-memory diagnostic counters covering every stage of the audio caption pipeline.
// Reset each time [CC] starts. Query via isweep_get_audio_caption_debug message.
const audioCaptionDebug = {
  ccStartCount: 0,
  offscreenStartCount: 0,
  offscreenStreamReadyCount: 0,
  offscreenWorkletLoadedCount: 0,
  offscreenChunkCount: 0,
  bgChunkReceivedCount: 0,
  transcribePostCount: 0,
  transcribeOkCount: 0,
  transcribeEmptyCount: 0,
  transcribeErrorCount: 0,
  relayAttemptCount: 0,
  relaySuccessCount: 0,
  relayFailureCount: 0,
  lastBackendUrl: null,
  lastTabId: null,
  lastVideoId: null,
  lastChunkBytes: 0,
  lastTranscribeStatus: null,
  lastTranscribeSource: null,
  lastTextLength: 0,
  lastTextPreview: '',
  lastError: null,
  captureStartedAt: null,
  chunkStartedAt: null,
  chunkFlushedAt: null,
  chunkEmittedAt: null,
  backendReceivedAt: null,
  transcribeStartedAt: null,
  transcribeFinishedAt: null,
  relaySentAt: null,
  contentScriptReceivedAt: null,
  overlayRenderedAt: null,
  totalLatencyMs: null,
  chunkWindowSec: null,
  updatedAt: Date.now(),
};

function normalizeCaptionTextForDedupe(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeCleanCaptionSettings(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const wordMuteMode = (data.cleanCaptionWordMuteMode === 'captions_word_mute'
    || data.cleanCaptionWordMuteMode === 'captions_selected_word_mute')
    ? 'captions_word_mute'
    : 'captions_only';
  return {
    cleanCaptionsEnabled: data.cleanCaptionsEnabled !== false,
    cleanCaptionWordMuteMode: wordMuteMode,
  };
}

function sanitizeBodyPreview(rawBody, maxLen = 300) {
  const body = String(rawBody || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  return body.slice(0, maxLen);
}

function buildHealthCheckUrl(backendUrl) {
  return `${String(backendUrl || '').replace(/\/+$/, '')}/health`;
}

function classifyFetchFailure(error) {
  const name = String(error?.name || 'Error');
  const message = String(error?.message || error || 'unknown error');
  const lower = `${name} ${message}`.toLowerCase();
  if (name === 'AbortError') {
    return {
      reasonCode: 'backend_unreachable',
      category: 'timeout',
      name,
      message,
    };
  }
  if (lower.includes('cors')) {
    return {
      reasonCode: 'CORS_error',
      category: 'cors',
      name,
      message,
    };
  }
  return {
    reasonCode: 'backend_unreachable',
    category: 'network',
    name,
    message,
  };
}

function summarizeLaunchDiagnostic(body) {
  const startup = body && typeof body.startup_diagnostic === 'object' ? body.startup_diagnostic : {};
  return {
    launchSource: String(startup.launch_source || 'unknown'),
    expectedWindowsAutostartSource: String(startup.expected_windows_autostart_source || 'windows_startup'),
    matchesExpected: startup.matches_expected === true,
  };
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
  const healthUrl = buildHealthCheckUrl(backendUrl);
  const stored = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]);
  const configuredBackendUrl = String(stored[STORAGE_KEYS.BACKEND_URL] || '').trim() || backendUrl;

  try {
    // Validate configured URL separately so popup can report invalid settings directly.
    // The backend URL getter still normalizes to local default for runtime safety.
    new URL(configuredBackendUrl);
  } catch (error) {
    const info = classifyFetchFailure(error);
    return {
      state: 'backend_offline',
      ok: false,
      ready: false,
      backendOnline: false,
      sttEnabled: false,
      stt_enabled: false,
      backendUrl,
      healthUrl,
      timeoutMs: CAPTION_HEALTH_TIMEOUT_MS,
      reasonCode: 'invalid_backend_url',
      failure_reason: 'invalid_backend_url',
      errorName: info.name,
      errorMessage: info.message,
      sttStatus: 'unknown',
      launchDiagnostic: summarizeLaunchDiagnostic(null),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAPTION_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    const bodyText = await res.text().catch(() => '');
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch (_) {
      body = {};
    }

    const launchDiagnostic = summarizeLaunchDiagnostic(body);

    if (res.status === 401 || res.status === 403) {
      return {
        state: 'backend_offline',
        ok: false,
        ready: false,
        backendOnline: false,
        sttEnabled: false,
        stt_enabled: false,
        backendUrl,
        healthUrl,
        timeoutMs: CAPTION_HEALTH_TIMEOUT_MS,
        httpStatus: res.status,
        responseBodyPreview: sanitizeBodyPreview(bodyText),
        reasonCode: 'authentication_required',
        failure_reason: 'authentication_required',
        sttStatus: 'unknown',
        launchDiagnostic,
      };
    }

    if (!res.ok) {
      return {
        state: 'backend_offline',
        ok: false,
        ready: false,
        backendOnline: false,
        sttEnabled: false,
        stt_enabled: false,
        backendUrl,
        healthUrl,
        timeoutMs: CAPTION_HEALTH_TIMEOUT_MS,
        httpStatus: res.status,
        responseBodyPreview: sanitizeBodyPreview(bodyText),
        reasonCode: 'health_failed',
        failure_reason: 'health_failed',
        sttStatus: 'unknown',
        launchDiagnostic,
      };
    }

    if (body?.authentication_required === true) {
      return {
        state: 'backend_offline',
        ok: false,
        ready: false,
        backendOnline: false,
        sttEnabled: false,
        stt_enabled: false,
        backendUrl,
        healthUrl,
        timeoutMs: CAPTION_HEALTH_TIMEOUT_MS,
        httpStatus: res.status,
        responseBodyPreview: sanitizeBodyPreview(bodyText),
        reasonCode: 'authentication_required',
        failure_reason: 'authentication_required',
        sttStatus: 'unknown',
        launchDiagnostic,
      };
    }

    const sttStatus = String(body?.stt_status || '').trim().toLowerCase();
    if (sttStatus === 'model_unavailable') {
      return {
        state: 'stt_disabled',
        ok: true,
        ready: false,
        backendOnline: true,
        sttEnabled: false,
        stt_enabled: false,
        backendUrl,
        healthUrl,
        timeoutMs: CAPTION_HEALTH_TIMEOUT_MS,
        httpStatus: res.status,
        responseBodyPreview: sanitizeBodyPreview(bodyText),
        reasonCode: 'model_unavailable',
        failure_reason: 'model_unavailable',
        sttStatus: 'model_unavailable',
        launchDiagnostic,
      };
    }

    const sttEnabled = body?.stt_enabled === true;
    return {
      state: sttEnabled ? 'ready' : 'stt_disabled',
      ok: true,
      ready: sttEnabled,
      backendOnline: true,
      sttEnabled,
      stt_enabled: sttEnabled,
      backendUrl,
      healthUrl,
      timeoutMs: CAPTION_HEALTH_TIMEOUT_MS,
      httpStatus: res.status,
      responseBodyPreview: sanitizeBodyPreview(bodyText),
      reasonCode: sttEnabled ? null : 'STT_disabled',
      failure_reason: sttEnabled ? null : 'STT_disabled',
      sttStatus: sttEnabled ? 'ok' : 'disabled',
      launchDiagnostic,
    };
  } catch (err) {
    clearTimeout(timeout);
    const info = classifyFetchFailure(err);
    return {
      state: 'backend_offline',
      ok: false,
      ready: false,
      backendOnline: false,
      sttEnabled: false,
      stt_enabled: false,
      backendUrl,
      healthUrl,
      timeoutMs: CAPTION_HEALTH_TIMEOUT_MS,
      reasonCode: info.reasonCode,
      failure_reason: info.reasonCode,
      error: info.message,
      errorName: info.name,
      errorMessage: info.message,
      sttStatus: 'unknown',
      launchDiagnostic: summarizeLaunchDiagnostic(null),
    };
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

async function getCaptionModeSnapshot() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.CLEAN_CAPTION_SETTINGS, STORAGE_KEYS.PREFS]);
  const settings = normalizeCleanCaptionSettings(store[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS] || CLEAN_CAPTION_DEFAULTS);
  const prefs = normalizePreferences(store[STORAGE_KEYS.PREFS] || {});
  const words = Array.isArray(prefs?.blocklist?.items) ? prefs.blocklist.items : [];
  const token = await getAuthToken();
  const selectedWordSource = words.length > 0
    ? (token ? 'synced' : 'cached')
    : 'missing';
  return {
    cleanCaptionsEnabled: settings.cleanCaptionsEnabled === true,
    mode: settings.cleanCaptionWordMuteMode,
    modeLabel: settings.cleanCaptionWordMuteMode === 'captions_word_mute'
      ? 'Captions + Selected Word Mute'
      : 'Captions Only',
    selectedWordCount: words.length,
    selectedWordPreview: words.slice(0, 10),
    selectedWordSource,
  };
}

async function getSignedInSnapshot() {
  const token = await getAuthToken();
  const devContext = await getDevLocalAuthContext();
  return {
    signedIn: Boolean(token) || devContext.enabled === true,
    hasToken: Boolean(token),
    devLocalAuthEnabled: devContext.enabled === true,
  };
}

async function buildCaptionReadinessStatus() {
  const [backend, tabStatus, modeSnapshot, authSnapshot] = await Promise.all([
    getCaptionBackendStatus(),
    getActiveTabCaptionRuntimeStatus(),
    getCaptionModeSnapshot(),
    getSignedInSnapshot(),
  ]);

  const tabSelectedWordCount = Number.isFinite(Number(tabStatus?.selectedWordCount))
    ? Number(tabStatus.selectedWordCount)
    : null;
  const selectedWordCount = tabSelectedWordCount !== null
    ? tabSelectedWordCount
    : modeSnapshot.selectedWordCount;
  const selectedWordPreview = Array.isArray(tabStatus?.selectedWordPreview)
    ? tabStatus.selectedWordPreview
    : modeSnapshot.selectedWordPreview;
  const selectedWordSource = String(
    tabStatus?.selectedWordSource
    || modeSnapshot.selectedWordSource
    || (selectedWordCount > 0 ? 'cached' : 'missing')
  );

  return {
    backend,
    tabStatus,
    auth: authSnapshot,
    captionMode: modeSnapshot.mode,
    captionModeLabel: modeSnapshot.modeLabel,
    selectedWordCount,
    selectedWordPreview,
    selectedWordSource,
    cleanCaptionsEnabled: modeSnapshot.cleanCaptionsEnabled,
    sttStatus: captionReadinessState.lastSttStatus,
    sttError: captionReadinessState.lastSttError,
    lastFailureReason: captionReadinessState.lastFailureReason,
    lastError: captionReadinessState.lastError,
    lastSuccessfulCaptionAt: captionReadinessState.lastCaptionAt,
    lastCaptionLatencyMs: captionReadinessState.lastCaptionLatencyMs,
  };
}

async function handleCaptionRuntimeStatus() {
  const readiness = await buildCaptionReadinessStatus();
  const backend = readiness.backend;
  const tabStatus = readiness.tabStatus;

  let state = backend.state || 'backend_offline';
  let label = 'Audio captions: Backend offline';
  let sourceLabel = 'Backend Offline';
  let source = 'backend_offline';
  let primaryCaptionSource = 'Waiting for audio';

  const youtubeFallbackEnabled = tabStatus?.youtubeDomFallbackEnabled === true;
  const backendReady = backend?.ready === true;

  const hasRenderableAudioText = tabStatus?.hasAudioCaptionText === true;
  if (tabStatus?.usingAudioStt && hasRenderableAudioText && backendReady) {
    state = 'ready';
    const overlaySource = String(tabStatus?.overlaySource || '').trim().toLowerCase();
    if (overlaySource.startsWith('audio_stt_plus_reference')) {
      source = 'audio_stt_plus_reference';
      label = 'Audio captions: Audio STT + Local Reference';
      sourceLabel = 'Audio STT + Local Reference';
    } else if (overlaySource.startsWith('audio_stt_plus_page_evidence')) {
      source = 'audio_stt_plus_page_evidence';
      label = 'Audio captions: Audio STT + Page Evidence';
      sourceLabel = 'Audio STT + Page Evidence';
    } else {
      source = overlaySource === 'audio_stt_cached' ? 'audio_stt_cached' : 'audio_stt';
      label = source === 'audio_stt_cached' ? 'Audio captions: Audio STT Cached' : 'Audio captions: Audio STT';
      sourceLabel = source === 'audio_stt_cached' ? 'Audio STT Cached' : 'Audio STT';
    }
    primaryCaptionSource = 'Live Audio STT';
  } else if (youtubeFallbackEnabled && tabStatus?.usingYoutubeFallback) {
    state = 'youtube_fallback';
    source = 'youtube_fallback';
    label = 'Captions: YouTube fallback';
    sourceLabel = 'YouTube Fallback';
  } else if (backend.state === 'ready') {
    state = 'ready';
    source = 'listening';
    label = 'Audio captions: Listening';
    sourceLabel = 'Listening';
    primaryCaptionSource = String(tabStatus?.captionState || '').toLowerCase() === 'speech ended'
      ? 'Speech ended'
      : 'Waiting for audio';
  } else if (backend.state === 'stt_disabled') {
    state = 'stt_disabled';
    source = 'stt_disabled';
    label = 'Audio captions: STT disabled';
    sourceLabel = 'STT Disabled';
    primaryCaptionSource = 'STT error';
  } else if (String(tabStatus?.captionState || '').toLowerCase() === 'speech ended') {
    primaryCaptionSource = 'Speech ended';
  }

  const response = {
    state,
    label,
    source,
    sourceLabel,
    reasonCode: backend?.reasonCode || null,
    backend,
    backendOnline: backend?.backendOnline === true,
    sttEnabled: backend?.sttEnabled === true,
    tabStatus,
    readiness,
    captionMode: readiness.captionMode,
    captionModeLabel: readiness.captionModeLabel,
    selectedWordCount: readiness.selectedWordCount,
    selectedWordPreview: readiness.selectedWordPreview,
    selectedWordSource: readiness.selectedWordSource,
    signedIn: readiness.auth?.signedIn === true,
    sttStatus: readiness.sttStatus,
    sttError: readiness.sttError,
    lastFailureReason: readiness.lastFailureReason,
    lastError: readiness.lastError,
    lastSuccessfulCaptionAt: readiness.lastSuccessfulCaptionAt,
    lastCaptionLatencyMs: readiness.lastCaptionLatencyMs,
    captionState: String(tabStatus?.captionState || 'Listening'),
    currentChunkId: tabStatus?.currentChunkId || null,
    lastAcceptedWindowEndMs: Number.isFinite(Number(tabStatus?.lastAcceptedWindowEndMs))
      ? Number(tabStatus.lastAcceptedWindowEndMs)
      : null,
    lastDroppedReason: tabStatus?.lastDroppedReason || null,
    pageTextAssistSource: String(tabStatus?.pageTextAssistSource || 'none'),
    pageTextAssistState: String(tabStatus?.pageTextAssistState || 'unavailable'),
    sttPageAgreement: String(tabStatus?.sttPageAgreement || 'unavailable'),
    evidenceAssist: tabStatus?.evidenceAssist && typeof tabStatus.evidenceAssist === 'object'
      ? tabStatus.evidenceAssist
      : null,
    sourceHierarchy: Array.isArray(tabStatus?.sourceHierarchy) ? tabStatus.sourceHierarchy : [],
    currentVadState: String(tabStatus?.currentVadState || 'unknown'),
    primaryCaptionSource,
  };
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
  console.log('[ISWEEP][AUDIO_CAPTIONS] offscreen document created');
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
  audioCaptionDebug.offscreenStartCount += 1;
  audioCaptionDebug.lastTabId = tabId;
  audioCaptionDebug.lastVideoId = videoId || null;
  audioCaptionDebug.updatedAt = Date.now();
  console.log(AUDIO_DIAG_LOG, 'offscreen start sent', { tabId, videoId });
  console.log(AUDIO_CAPTIONS_BG_LOG, 'start requested', { tabId, videoId });
  console.log('[ISWEEP][AUDIO_CAPTIONS] start requested', { tabId, videoId });
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
  resetCaptionTimelineForTab(tabId, 'capture_started');
  console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture stream ready', { tabId, videoId });
  return { ok: true, tabId, videoId };
}

async function stopTabAudioCapture(reason = 'captions_disabled') {
  const active = activeTabAudioCapture;
  activeTabAudioCapture = null;
  if (!active) {
    console.log('[ISWEEP][AUDIO_CAPTIONS] stopped', { reason, active: false });
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
  console.log('[ISWEEP][AUDIO_CAPTIONS] stopped', { reason, tabId: active.tabId, videoId: active.videoId });
  console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture stopped', { reason, tabId: active.tabId, videoId: active.videoId });
  return { ok: true };
}

function getCaptionTranscribeQueueState(tabId) {
  const key = Number(tabId);
  if (!captionTranscribeQueueByTabId.has(key)) {
    captionTranscribeQueueByTabId.set(key, {
      busy: false,
      pending: null,
      lastStartedAt: 0,
      replacedCount: 0,
    });
  }
  return captionTranscribeQueueByTabId.get(key);
}

function clearCaptionTranscribeQueue(tabId) {
  const key = Number(tabId);
  captionTranscribeQueueByTabId.delete(key);
  recentRelayByTabId.delete(key);
  resetCaptionTimelineForTab(key, 'queue_cleared');
}

function shouldSuppressDuplicateRelay(tabId, relayMsg, windowMs = AUDIO_RELAY_DEDUPE_WINDOW_MS) {
  const key = Number(tabId);
  if (!Number.isFinite(key)) return false;
  const now = Date.now();
  const textCandidate = String(
    relayMsg?.stable_text
    || relayMsg?.clean_text
    || relayMsg?.cleaned_text
    || relayMsg?.text
    || ''
  ).trim();
  const normalizedText = normalizeCaptionTextForDedupe(textCandidate);
  const source = String(relayMsg?.source || 'unknown').trim().toLowerCase();
  const status = String(relayMsg?.status || 'unknown').trim().toLowerCase();
  const isPartial = relayMsg?.is_partial === true;
  const windowIdentity = Number.isFinite(Number(relayMsg?.audio_window_end_ms))
    ? `w:${Number(relayMsg.audio_window_end_ms)}`
    : `c:${String(relayMsg?.chunk_id || '').trim() || 'unknown_chunk'}`;
  const signature = `${source}|${status}|${isPartial ? 'partial' : 'final'}|${windowIdentity}|${normalizedText}`;
  const previous = recentRelayByTabId.get(key);

  if (!normalizedText) {
    // Guard against empty/silence payloads clearing a recently-rendered valid caption.
    if (previous && previous.hasText && (now - previous.seenAt) <= windowMs) {
      return true;
    }
    recentRelayByTabId.set(key, {
      seenAt: now,
      hasText: false,
      signature,
    });
    return false;
  }

  recentRelayByTabId.set(key, {
    seenAt: now,
    hasText: true,
    signature,
  });

  if (!previous || !previous.hasText) return false;
  return previous.signature === signature && (now - previous.seenAt) <= windowMs;
}

async function processCaptionTranscribeQueueForTab(tabId) {
  const state = getCaptionTranscribeQueueState(tabId);
  if (state.busy) return;
  state.busy = true;
  try {
    while (state.pending) {
      const job = state.pending;
      state.pending = null;

      const waitMs = Math.max((state.lastStartedAt + CAPTION_TRANSCRIBE_INTERVAL_MS) - Date.now(), 0);
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      state.lastStartedAt = Date.now();

      const result = await handleAudioCaptionChunk(
        job.videoId,
        job.audioChunk,
        job.mimeType,
        job.startSeconds,
        job.endSeconds,
        job.audioSamples,
        job.sampleRate,
        job.channels,
        job.chunkMeta,
        job.tabId,
      );
      await relayAudioCaptionResultToTab(result);
    }
  } finally {
    state.busy = false;
  }
}

function enqueueCaptionTranscribeJob(tabId, job) {
  const state = getCaptionTranscribeQueueState(tabId);
  if (state.pending) {
    state.replacedCount += 1;
    console.log(AUDIO_DIAG_LOG, 'replaced stale pending transcription chunk', {
      tabId,
      replacedCount: state.replacedCount,
      oldStartSeconds: state.pending.startSeconds,
      oldEndSeconds: state.pending.endSeconds,
      newStartSeconds: job.startSeconds,
      newEndSeconds: job.endSeconds,
    });
  }
  state.pending = job;
  processCaptionTranscribeQueueForTab(tabId).catch((err) => {
    console.warn(AUDIO_DIAG_LOG, 'caption transcribe queue failure', {
      tabId,
      error: String(err?.message || err).slice(0, 120),
    });
    state.busy = false;
  });
}

async function relayAudioCaptionResultToTab(result) {
  let tabId = Number(activeTabAudioCapture?.tabId);
  // If the service worker restarted and lost in-memory state, the tabId will be
  // NaN. Fall back to querying for any YouTube watch tab so the relay still works.
  if (!Number.isFinite(tabId)) {
    try {
      const [ytTab] = await chrome.tabs.query({ url: '*://www.youtube.com/watch*' });
      tabId = Number(ytTab?.id);
      if (Number.isFinite(tabId)) {
        console.log(AUDIO_CAPTIONS_BG_LOG, 'relay tabId recovered from tab query after SW restart', { tabId });
      }
    } catch (_) {}
  }
  if (!Number.isFinite(tabId)) {
    audioCaptionDebug.relayAttemptCount += 1;
    audioCaptionDebug.relayFailureCount += 1;
    audioCaptionDebug.lastError = 'relay_no_tab_id';
    audioCaptionDebug.updatedAt = Date.now();
    console.warn(AUDIO_DIAG_LOG, 'relay failed', { reason: 'no_tab_id' });
    return false;
  }

  const relayMsg = {
    type: 'isweep_audio_caption_text',
    tab_id: Number.isFinite(Number(result?.tab_id)) ? Number(result.tab_id) : tabId,
    video_id: String(result?.video_id || activeTabAudioCapture?.videoId || '').trim() || null,
    session_id: String(result?.session_id || '').trim() || null,
    chunk_id: String(result?.chunk_id || '').trim() || null,
    sequence_number: Number.isFinite(Number(result?.sequence_number)) ? Number(result.sequence_number) : null,
    chunk_started_at: Number.isFinite(Number(result?.latency?.chunkStartedAt || result?.latency?.chunk_started_at))
      ? Number(result?.latency?.chunkStartedAt || result?.latency?.chunk_started_at)
      : null,
    chunk_flushed_at: Number.isFinite(Number(result?.latency?.chunkFlushedAt || result?.latency?.chunk_flushed_at))
      ? Number(result?.latency?.chunkFlushedAt || result?.latency?.chunk_flushed_at)
      : null,
    audio_window_start_ms: Number.isFinite(Number(result?.audio_window_start_ms)) ? Number(result.audio_window_start_ms) : null,
    audio_window_end_ms: Number.isFinite(Number(result?.audio_window_end_ms)) ? Number(result.audio_window_end_ms) : null,
    text: result?.text || result?.clean_text || result?.cleaned_text || '',
source: result?.source === 'audio_stt_disabled'
  ? 'audio_stt_disabled'
  : (result?.source === 'silence'
    ? 'silence'
    : (result?.source === 'waiting_audio_context'
      ? 'waiting_audio_context'
      : (result?.cached === true ? 'audio_stt_cached' : 'audio_stt_live'))),
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
    is_partial: result?.is_partial === true,
    stable_text: typeof result?.stable_text === 'string' ? result.stable_text : '',
    words: Array.isArray(result?.words)
      ? result.words
      : (Array.isArray(result?.word_timestamps) ? result.word_timestamps : []),
    word_timestamps: Array.isArray(result?.word_timestamps)
      ? result.word_timestamps
      : (Array.isArray(result?.words) ? result.words : []),
    cached: result?.cached === true,
    latency: result?.latency && typeof result.latency === 'object' ? result.latency : null,
  };

  const timeline = getCaptionTimelineState(tabId);
  if (shouldDropDuplicateRelayByResultId(tabId, relayMsg)) {
    return true;
  }
  if (timeline) {
    const incomingWindowEnd = Number.isFinite(Number(relayMsg.audio_window_end_ms))
      ? Number(relayMsg.audio_window_end_ms)
      : -1;
    if (incomingWindowEnd >= 0 && incomingWindowEnd < Number(timeline.lastAudioWindowEndMs || -1)) {
      timeline.lastDroppedReason = 'old_audio_window';
      timeline.updatedAt = Date.now();
      console.log(CAPTION_STATE_LOG, 'stale result dropped', {
        tab_id: tabId,
        chunk_id: relayMsg.chunk_id,
        audio_window_end_ms: incomingWindowEnd,
        latest_audio_window_end_ms: timeline.lastAudioWindowEndMs,
      });
      return true;
    }
    const isSilence = String(relayMsg.source || '').toLowerCase() === 'silence';
    if (isSilence && incomingWindowEnd >= 0 && timeline.lastAudioWindowEndMs >= incomingWindowEnd) {
      timeline.lastDroppedReason = 'silence_older_than_latest';
      timeline.updatedAt = Date.now();
      console.log(CAPTION_STATE_LOG, 'stale result dropped', {
        tab_id: tabId,
        chunk_id: relayMsg.chunk_id,
        reason: 'silence_older_than_latest',
      });
      return true;
    }
  }

  if (shouldSuppressDuplicateRelay(tabId, relayMsg)) {
    const state = getCaptionTimelineState(tabId);
    if (state) {
      state.lastDroppedReason = 'duplicate_suppressed';
      state.updatedAt = Date.now();
    }
    console.log(CAPTION_STATE_LOG, 'duplicate relay dropped', {
      tab_id: tabId,
      chunk_id: relayMsg.chunk_id,
      audio_window_end_ms: relayMsg.audio_window_end_ms,
    });
    console.log(AUDIO_DIAG_LOG, 'relay duplicate suppressed', {
      tabId,
      source: relayMsg.source,
      status: relayMsg.status,
      textPreview: String(relayMsg.text || '').slice(0, 60),
    });
    return true;
  }

  console.log('[ISWEEP][WORD_MUTE] relay words', {
    count: Array.isArray(relayMsg.words) ? relayMsg.words.length : 0,
    preview: Array.isArray(relayMsg.words)
      ? relayMsg.words.slice(0, 5).map((entry) => ({
        word: String(entry?.word || '').trim().toLowerCase(),
        start: entry?.start,
        end: entry?.end,
      }))
      : [],
    source: relayMsg.source,
  });

  audioCaptionDebug.relayAttemptCount += 1;
  console.log(AUDIO_DIAG_LOG, 'relay attempt', {
    tabId,
    source: relayMsg.source,
    textLength: relayMsg.text.length,
    textPreview: relayMsg.text.slice(0, 60),
  });

  const trySend = async (tid) => {
    await chrome.tabs.sendMessage(tid, relayMsg);
  };

  try {
    await trySend(tabId);
    if (timeline) {
      timeline.sessionId = relayMsg.session_id || timeline.sessionId;
      timeline.videoId = relayMsg.video_id || timeline.videoId;
      timeline.lastChunkId = relayMsg.chunk_id || timeline.lastChunkId;
      if (Number.isFinite(Number(relayMsg.sequence_number))) {
        timeline.lastSequenceNumber = Math.max(timeline.lastSequenceNumber || 0, Number(relayMsg.sequence_number));
      }
      if (Number.isFinite(Number(relayMsg.audio_window_end_ms))) {
        timeline.lastAudioWindowEndMs = Math.max(Number(timeline.lastAudioWindowEndMs || -1), Number(relayMsg.audio_window_end_ms));
      }
      timeline.lastDroppedReason = null;
      timeline.updatedAt = Date.now();
    }
    audioCaptionDebug.relaySentAt = Date.now();
    audioCaptionDebug.contentScriptReceivedAt = audioCaptionDebug.relaySentAt;
    if (result?.latency && typeof result.latency === 'object') {
      result.latency.relaySentAt = audioCaptionDebug.relaySentAt;
      result.latency.contentScriptReceivedAt = audioCaptionDebug.relaySentAt;
      result.latency.content_script_received_at = audioCaptionDebug.relaySentAt;
      result.latency.totalLatencyMs = Number.isFinite(Number(result.latency.captureStartedAt))
        ? Math.max(audioCaptionDebug.relaySentAt - Number(result.latency.captureStartedAt), 0)
        : result.latency.totalLatencyMs;
      result.latency.total_latency_ms = Number.isFinite(Number(result.latency.capture_started_at))
        ? Math.max(audioCaptionDebug.relaySentAt - Number(result.latency.capture_started_at), 0)
        : result.latency.total_latency_ms;
    }
    audioCaptionDebug.relaySuccessCount += 1;
    audioCaptionDebug.updatedAt = Date.now();
    console.log(AUDIO_DIAG_LOG, 'relay success', { tabId });
    return true;
  } catch (err) {
    const errText = String(err?.message || err || '');
    const isNoReceiver = /receiving end does not exist|could not establish connection/i.test(errText);
    if (isNoReceiver && chrome.scripting?.executeScript) {
      // Content script not loaded — try to inject youtube_captions.js, then retry once.
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['youtube_captions.js'],
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        await trySend(tabId);
        audioCaptionDebug.relaySuccessCount += 1;
        audioCaptionDebug.updatedAt = Date.now();
        console.log(AUDIO_DIAG_LOG, 'relay success after inject', { tabId });
        return true;
      } catch (retryErr) {
        audioCaptionDebug.relayFailureCount += 1;
        audioCaptionDebug.lastError = `relay_inject_failed: ${String(retryErr?.message || retryErr).slice(0, 80)}`;
        audioCaptionDebug.updatedAt = Date.now();
        console.warn(AUDIO_DIAG_LOG, 'relay failed', { reason: 'inject_and_retry_failed', tabId, err: audioCaptionDebug.lastError });
        return false;
      }
    }
    audioCaptionDebug.relayFailureCount += 1;
    audioCaptionDebug.lastError = `relay_send_failed: ${errText.slice(0, 80)}`;
    audioCaptionDebug.updatedAt = Date.now();
    console.warn(AUDIO_DIAG_LOG, 'relay failed', { reason: errText.slice(0, 80), tabId });
    return false;
  }
}

function releaseTabCaptureSession(tabId, reason = 'released') {
  if (!Number.isFinite(Number(tabId))) return;
  if (tabCaptureSessionByTabId.has(tabId)) {
    tabCaptureSessionByTabId.delete(tabId);
    recentRelayByTabId.delete(Number(tabId));
    resetCaptionTimelineForTab(Number(tabId), reason || 'tab_capture_session_released');
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
  clearCaptionTranscribeQueue(tabId);
  await postTabCaptureStatusToTab(tabId, 'starting', null);

  const start = await startTabAudioCapture(tabId, videoId);
  if (!start.ok) {
    await postTabCaptureStatusToTab(tabId, 'unavailable', start.failure_reason || 'audio_capture_unavailable');
    return start;
  }
  await postTabCaptureStatusToTab(tabId, 'ready', null);
  console.log('[ISWEEP][AUDIO_CAPTIONS] captions started without muting playback', { tabId, videoId });
  return { ok: true, tabId, video_id: videoId, source: 'tab_capture' };
}

async function handleStopTabAudioCaptions() {
  if (Number.isFinite(Number(activeTabAudioCapture?.tabId))) {
    clearCaptionTranscribeQueue(Number(activeTabAudioCapture.tabId));
  }
  await stopTabAudioCapture('captions_disabled');
  return { ok: true };
}

function normalizeBackendUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return DEFAULT_BACKEND;
  try {
    const parsed = new URL(value);
    const port = parsed.port || '80';
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && port === '5000') {
      return DEFAULT_BACKEND;
    }
  } catch (_) {
    return DEFAULT_BACKEND;
  }
  return DEFAULT_BACKEND;
}

async function getBackendUrl() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]);
  const stored = store[STORAGE_KEYS.BACKEND_URL];
  const normalized = normalizeBackendUrl(stored);
  if (stored !== normalized) {
    await chrome.storage.local.set({ [STORAGE_KEYS.BACKEND_URL]: normalized });
  }
  if (!didLogBackendUrl) {
    didLogBackendUrl = true;
    console.log('[ISWEEP][BG] backend URL http://127.0.0.1:5000');
  }
  return normalized;
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

async function ensureLocalDevCaptionToken(backendUrl) {
  if (!isLocalBackendUrl(backendUrl)) return null;

  const store = await chrome.storage.local.get(['isweepLocalCaptionToken']);
  const cachedToken = store.isweepLocalCaptionToken;
  if (cachedToken) return cachedToken;

  const payload = {
    email: LOCAL_DEV_CAPTION_EMAIL,
    password: LOCAL_DEV_CAPTION_PASSWORD,
  };

  const signupResponse = await fetch(`${backendUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (signupResponse.ok) {
    const signupBody = await signupResponse.json().catch(() => ({}));
    const token = signupBody?.token || null;
    if (token) {
      await chrome.storage.local.set({ isweepLocalCaptionToken: token });
      console.log('[ISWEEP][AUTH] local dev caption token created');
      return token;
    }
  }

  if (signupResponse.status === 409) {
    const loginResponse = await fetch(`${backendUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (loginResponse.ok) {
      const loginBody = await loginResponse.json().catch(() => ({}));
      const token = loginBody?.token || null;
      if (token) {
        await chrome.storage.local.set({ isweepLocalCaptionToken: token });
        console.log('[ISWEEP][AUTH] local dev caption token reused');
        return token;
      }
    }
  }

  return null;
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
    resetCaptionTimelineForTab(tabId, 'tab_closed');
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
  } else if (message.type === 'isweep_get_caption_readiness_status') {
    buildCaptionReadinessStatus().then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_start_audio_captions') {
    audioCaptionDebug.ccStartCount += 1;
    audioCaptionDebug.captureStartedAt = null;
    audioCaptionDebug.chunkStartedAt = null;
    audioCaptionDebug.chunkFlushedAt = null;
    audioCaptionDebug.chunkEmittedAt = null;
    audioCaptionDebug.backendReceivedAt = null;
    audioCaptionDebug.transcribeStartedAt = null;
    audioCaptionDebug.transcribeFinishedAt = null;
    audioCaptionDebug.relaySentAt = null;
    audioCaptionDebug.contentScriptReceivedAt = null;
    audioCaptionDebug.overlayRenderedAt = null;
    audioCaptionDebug.totalLatencyMs = null;
    audioCaptionDebug.updatedAt = Date.now();
    console.log(AUDIO_DIAG_LOG, 'cc start requested', { count: audioCaptionDebug.ccStartCount });
    handleStartTabAudioCaptions().then(sendResponse);
    return true; // async
  } else if (message.type === 'isweep_stop_audio_captions') {
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
    const tabId = Number(activeTabAudioCapture?.tabId || sender?.tab?.id);
    const bgChunkVideoId = String(message.video_id || activeTabAudioCapture?.videoId || '').trim();
    const chunkStartedAt = Number.isFinite(Number(message.chunk_started_at)) ? Number(message.chunk_started_at) : null;
    const chunkFlushedAt = Number.isFinite(Number(message.chunk_flushed_at)) ? Number(message.chunk_flushed_at) : null;
    const sessionId = String(message.session_id || '').trim() || null;
    const sequenceNumber = Number.isFinite(Number(message.sequence_number)) ? Number(message.sequence_number) : 0;
    const chunkId = String(message.chunk_id || '').trim() || null;
    const audioWindowStartMs = Number.isFinite(Number(message.audio_window_start_ms))
      ? Number(message.audio_window_start_ms)
      : (Number.isFinite(Number(message.start_seconds)) ? Math.max(Math.round(Number(message.start_seconds) * 1000), 0) : null);
    const audioWindowEndMs = Number.isFinite(Number(message.audio_window_end_ms))
      ? Number(message.audio_window_end_ms)
      : (Number.isFinite(Number(message.end_seconds)) ? Math.max(Math.round(Number(message.end_seconds) * 1000), Number(audioWindowStartMs || 0)) : null);
    const captureStartedAt = Number.isFinite(Number(chunkStartedAt))
      ? Number(chunkStartedAt)
      : (Number.isFinite(Number(message.capture_started_at)) ? Number(message.capture_started_at) : null);
    const chunkEmittedAt = Number.isFinite(Number(message.chunk_emitted_at)) ? Number(message.chunk_emitted_at) : chunkFlushedAt;
    const backendReceivedAt = Date.now();
    audioCaptionDebug.bgChunkReceivedCount += 1;
    audioCaptionDebug.lastVideoId = bgChunkVideoId || audioCaptionDebug.lastVideoId;
    audioCaptionDebug.captureStartedAt = captureStartedAt;
    audioCaptionDebug.chunkStartedAt = chunkStartedAt;
    audioCaptionDebug.chunkFlushedAt = chunkFlushedAt;
    audioCaptionDebug.chunkEmittedAt = chunkEmittedAt;
    audioCaptionDebug.backendReceivedAt = backendReceivedAt;
    audioCaptionDebug.chunkWindowSec = Number.isFinite(Number(message.chunk_window_sec)) ? Number(message.chunk_window_sec) : audioCaptionDebug.chunkWindowSec;
    audioCaptionDebug.lastChunkBytes = typeof message.audio_chunk === 'string' ? message.audio_chunk.length : 0;
    audioCaptionDebug.updatedAt = Date.now();
    console.log(AUDIO_DIAG_LOG, 'background chunk received', {
      videoId: bgChunkVideoId,
      startSeconds: message.start_seconds,
      endSeconds: message.end_seconds,
      bgChunkReceivedCount: audioCaptionDebug.bgChunkReceivedCount,
    });
    console.log(AUDIO_CAPTIONS_BG_LOG, 'chunk received from offscreen', {
      videoId: bgChunkVideoId,
      startSeconds: message.start_seconds,
      endSeconds: message.end_seconds,
    });

    if (!Number.isFinite(tabId)) {
      sendResponse({ status: 'error', events: [], failure_reason: 'missing_tab_id' });
      return;
    }

    const timeline = getCaptionTimelineState(tabId);
    if (timeline) {
      const incomingVideoId = String(bgChunkVideoId || '').trim() || null;
      if (timeline.videoId && incomingVideoId && timeline.videoId !== incomingVideoId) {
        resetCaptionTimelineForTab(tabId, 'video_changed');
      }
      const refreshed = getCaptionTimelineState(tabId);
      if (refreshed && refreshed.sessionId && sessionId && refreshed.sessionId !== sessionId) {
        resetCaptionTimelineForTab(tabId, 'session_changed');
      }
      const active = getCaptionTimelineState(tabId);
      if (active) {
        active.sessionId = sessionId || active.sessionId;
        active.videoId = incomingVideoId || active.videoId;
        active.lastSequenceNumber = Math.max(active.lastSequenceNumber || 0, sequenceNumber || 0);
        active.lastChunkId = chunkId || active.lastChunkId;
        active.updatedAt = Date.now();
      }
    }

    enqueueCaptionTranscribeJob(tabId, {
      tabId,
      videoId: bgChunkVideoId,
      audioChunk: message.audio_chunk,
      mimeType: message.mime_type,
      startSeconds: message.start_seconds,
      endSeconds: message.end_seconds,
      audioSamples: message.audio,
      sampleRate: message.sampleRate,
      channels: message.channels,
      chunkMeta: {
        captureStartedAt,
        chunkStartedAt,
        chunkFlushedAt,
        chunkEmittedAt,
        sessionId,
        sequenceNumber,
        chunkId,
        audioWindowStartMs,
        audioWindowEndMs,
        backendReceivedAt,
        chunkWindowSec: audioCaptionDebug.chunkWindowSec,
      },
    });
    sendResponse({ ok: true, queued: true });
    return true; // async
  } else if (message.type === 'isweep_audio_diag') {
    // Lifecycle updates from offscreen.js
    const stage = message.stage || '';
    if (stage === 'offscreen_loaded') {
      console.log(AUDIO_DIAG_LOG, 'offscreen loaded');
    } else if (stage === 'offscreen_start_received') {
      console.log(AUDIO_DIAG_LOG, 'offscreen start sent', { videoId: message.videoId });
    } else if (stage === 'offscreen_stream_ready') {
      audioCaptionDebug.offscreenStreamReadyCount += 1;
      audioCaptionDebug.updatedAt = Date.now();
      console.log(AUDIO_DIAG_LOG, 'offscreen stream ready', { videoId: message.videoId });
    } else if (stage === 'offscreen_worklet_loaded') {
      audioCaptionDebug.offscreenWorkletLoadedCount += 1;
      audioCaptionDebug.updatedAt = Date.now();
      console.log(AUDIO_DIAG_LOG, 'offscreen worklet loaded');
    } else if (stage === 'offscreen_chunk_emitted') {
      audioCaptionDebug.offscreenChunkCount += 1;
      audioCaptionDebug.chunkStartedAt = Number.isFinite(Number(message.chunkStartedAt))
        ? Number(message.chunkStartedAt)
        : audioCaptionDebug.chunkStartedAt;
      audioCaptionDebug.chunkFlushedAt = Number.isFinite(Number(message.chunkFlushedAt))
        ? Number(message.chunkFlushedAt)
        : audioCaptionDebug.chunkFlushedAt;
      audioCaptionDebug.chunkWindowSec = Number.isFinite(Number(message.chunkWindowSec))
        ? Number(message.chunkWindowSec)
        : audioCaptionDebug.chunkWindowSec;
      audioCaptionDebug.updatedAt = Date.now();
      console.log(AUDIO_DIAG_LOG, 'offscreen chunk emitted', {
        chunkCount: message.chunkCount,
        sampleCount: message.sampleCount,
      });
    } else if (stage === 'overlay_rendered') {
      audioCaptionDebug.overlayRenderedAt = Number.isFinite(Number(message.overlayRenderedAt))
        ? Number(message.overlayRenderedAt)
        : Date.now();
      audioCaptionDebug.contentScriptReceivedAt = Number.isFinite(Number(message.contentScriptReceivedAt))
        ? Number(message.contentScriptReceivedAt)
        : audioCaptionDebug.contentScriptReceivedAt;
      audioCaptionDebug.totalLatencyMs = Number.isFinite(Number(message.totalLatencyMs))
        ? Number(message.totalLatencyMs)
        : (Number.isFinite(Number(audioCaptionDebug.captureStartedAt))
          ? Math.max(audioCaptionDebug.overlayRenderedAt - Number(audioCaptionDebug.captureStartedAt), 0)
          : null);
      audioCaptionDebug.updatedAt = Date.now();
    }
    sendResponse({ ok: true });
    return;
  } else if (message.type === 'isweep_audio_vad_state') {
    const tabId = Number.isFinite(Number(message.tab_id))
      ? Number(message.tab_id)
      : Number(activeTabAudioCapture?.tabId);
    if (Number.isFinite(tabId)) {
      chrome.tabs.sendMessage(tabId, {
        type: 'isweep_audio_vad_state',
        tab_id: tabId,
        video_id: String(message.video_id || activeTabAudioCapture?.videoId || '').trim() || null,
        session_id: String(message.session_id || '').trim() || null,
        speech_active: message.speech_active === true,
        reason: String(message.reason || 'offscreen_vad'),
        observed_at: Number.isFinite(Number(message.observed_at)) ? Number(message.observed_at) : Date.now(),
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  } else if (message.type === 'isweep_get_audio_caption_debug') {
    sendResponse({ ...audioCaptionDebug });
    return true;
  } else if (message.type === 'isweep_lookup_reference_candidates') {
    lookupReferenceCandidatesOnce({
      video_id: message.video_id,
      title: message.title,
      channel: message.channel,
      duration_seconds: message.duration_seconds,
    }).then(sendResponse);
    return true;
  } else if (message.type === 'isweep_import_local_reference') {
    importLocalReference(message).then(sendResponse);
    return true;
  } else if (message.type === 'isweep_get_local_reference') {
    const requestedVideoId = String(message.video_id || '').trim();
    chrome.storage.local.get([STORAGE_KEYS.LOCAL_REFERENCES]).then((store) => {
      const allRefs = store && typeof store[STORAGE_KEYS.LOCAL_REFERENCES] === 'object' && store[STORAGE_KEYS.LOCAL_REFERENCES]
        ? store[STORAGE_KEYS.LOCAL_REFERENCES]
        : {};
      if (!requestedVideoId) {
        sendResponse({ ok: true, references: allRefs });
        return;
      }
      sendResponse({
        ok: true,
        video_id: requestedVideoId,
        reference: allRefs[requestedVideoId] || null,
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error?.message || error || 'read_failed') });
    });
    return true;
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

function shouldAnalyzeTranscriptForFiltering(text, source) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  const normalizedText = clean.toLowerCase();
  if (normalizedText === 'isweep captions listening...' || normalizedText === 'listening') return false;
  if (normalizedText.includes('speech-to-text is not enabled')) return false;
  if (normalizedText.includes('backend running')) return false;
  const blockedSources = new Set([
    'placeholder',
    'waiting_audio_text',
    'live_masked',
    'audio_stt_disabled',
    'backend_offline',
    'audio_capture_unavailable',
    'silence',
    'error',
  ]);
  const normalizedSource = String(source || '').trim().toLowerCase();
  if (blockedSources.has(normalizedSource)) return false;
  return true;
}

function shouldApplyFilterDecision(decision, transcriptText, source) {
  // Gate: only apply filter decisions (mute, skip, fast_forward) for real transcript text
  // from legitimate sources. Prevents false muting on silence, placeholders, or errors.
  const clean = String(transcriptText || '').trim();
  if (!clean) return false;

  const src = String(source || '').trim().toLowerCase();
  const invalidSources = [
    'silence',
    'audio_stt_disabled',
    'backend_offline',
    'audio_capture_unavailable',
    'waiting_audio_text',
    'placeholder',
    'error',
  ];
  if (invalidSources.includes(src)) return false;

  if (!decision || decision.action === 'none') return false;
  if (!['mute', 'skip', 'fast_forward'].includes(decision.action)) return false;

  return true;
}

function getMatchedFilterText(decision) {
  // Extract the actual matched word/phrase from the decision.
  // Multiple field names are checked for compatibility with different API responses.
  return String(
    decision?.matched_word ||
    decision?.matched_phrase ||
    decision?.matched_text ||
    decision?.match ||
    decision?.word ||
    ''
  ).trim();
}

function shouldApplyWordMute(decision, transcriptText, source) {
  // Stricter gate for mute specifically: only mute if a real word/phrase is matched.
  // Category-only matches (profanity without matched_word) should not trigger mute.
  const cleanText = String(transcriptText || '').trim();
  if (!cleanText) return false;

  const src = String(source || '').trim().toLowerCase();
  const invalidSources = [
    'silence',
    'audio_stt_disabled',
    'backend_offline',
    'audio_capture_unavailable',
    'waiting_audio_text',
    'placeholder',
    'error',
  ];
  if (invalidSources.includes(src)) return false;

  if (!decision || decision.action !== 'mute') return false;

  // CRITICAL: Only mute if there is an actual matched word/phrase.
  // Do not mute on category alone (e.g., matched_category='profanity' without matched_word).
  const matchedText = getMatchedFilterText(decision);
  if (!matchedText) {
    console.warn('[ISWEEP][WORD_MUTE] skipped mute: no matched word/phrase', {
      action: decision?.action,
      matched_category: decision?.matched_category || null,
      source: src,
    });
    return false;
  }

  return true;
}

async function handleMarkerAnalyze(videoId, forceRefresh = false) {
  const cleanVideoId = (videoId || '').trim();
  if (!cleanVideoId) {
    return { status: 'error', source: null, events: [], failure_reason: 'missing_video_id' };
  }

  const modeSnapshot = await getCaptionModeSnapshot();
  if (modeSnapshot.cleanCaptionsEnabled) {
    return {
      status: 'unavailable',
      source: null,
      events: [],
      failure_reason: 'caption_mode_no_markers',
      mode: modeSnapshot.mode,
    };
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
    const requestUrl = `${backendUrl}/videos/analyze`;
    console.log(MARKER_LOG_PREFIX, 'analyze start', { videoId: cleanVideoId });
    res = await fetch(requestUrl, {
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
        requestUrl,
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
    const requestUrl = `${backendUrl}/videos/analyze`;
    const markerErrorMeta = {
      videoId: cleanVideoId,
      requestUrl,
      status: res?.status,
      responseBodyPreview: (responseBody || '').slice(0, 200),
      failureReason,
      exceptionName: String(err?.name || 'Error'),
      exceptionMessage: String(err?.message || err || 'unknown error'),
    };
    console.error(`${MARKER_LOG_PREFIX} analyze exception ${JSON.stringify(markerErrorMeta)}`, markerErrorMeta);
    return { status: 'error', source: null, events: [], failure_reason: failureReason };
  }
}

// Caption-only audio transcription. Posts to /captions/transcribe and forwards transcript text.
// Never calls handleCaptionDecision, never calls /event, never creates filter events.
// Guard: AUDIO_CAPTION_FILTER_ACTIONS_ENABLED must remain false until filtering is intentionally re-enabled.
async function handleAudioCaptionChunk(videoId, audioChunk, mimeType, startSeconds, endSeconds, audioSamples = null, sampleRate = null, channels = null, chunkMeta = null, tabId = null) {
  if (!AUDIO_CAPTION_FILTER_ACTIONS_ENABLED) {
    // captions only; never call /event here
  }
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
  const captureStartedAt = Number.isFinite(Number(chunkMeta?.captureStartedAt)) ? Number(chunkMeta.captureStartedAt) : null;
  const chunkStartedAt = Number.isFinite(Number(chunkMeta?.chunkStartedAt)) ? Number(chunkMeta.chunkStartedAt) : null;
  const chunkFlushedAt = Number.isFinite(Number(chunkMeta?.chunkFlushedAt)) ? Number(chunkMeta.chunkFlushedAt) : null;
  const chunkEmittedAt = Number.isFinite(Number(chunkMeta?.chunkEmittedAt)) ? Number(chunkMeta.chunkEmittedAt) : chunkFlushedAt;
  const sessionId = String(chunkMeta?.sessionId || '').trim() || null;
  const sequenceNumber = Number.isFinite(Number(chunkMeta?.sequenceNumber)) ? Number(chunkMeta.sequenceNumber) : null;
  const chunkId = String(chunkMeta?.chunkId || '').trim() || null;
  const audioWindowStartMs = Number.isFinite(Number(chunkMeta?.audioWindowStartMs))
    ? Number(chunkMeta.audioWindowStartMs)
    : Math.max(Math.round(normalizedStart * 1000), 0);
  const audioWindowEndMs = Number.isFinite(Number(chunkMeta?.audioWindowEndMs))
    ? Number(chunkMeta.audioWindowEndMs)
    : Math.max(Math.round(normalizedEnd * 1000), audioWindowStartMs);
  const backendReceivedAt = Number.isFinite(Number(chunkMeta?.backendReceivedAt)) ? Number(chunkMeta.backendReceivedAt) : Date.now();

  const backendUrl = await getBackendUrl();
  let token = await getAuthToken();
  if (!token) {
    token = await ensureLocalDevCaptionToken(backendUrl);
  }
  if (!token) {
    captionReadinessState.lastError = 'missing_token';
    captionReadinessState.lastFailureReason = 'missing_token';
    captionReadinessState.lastSttStatus = 'authentication_required';
    captionReadinessState.lastSttError = 'missing_token';
    return { status: 'unavailable', events: [], failure_reason: 'missing_token' };
  }

  let res;
  let responseBody = '';
  try {
    const transcribeStartedAt = Date.now();
    audioCaptionDebug.transcribePostCount += 1;
    audioCaptionDebug.lastBackendUrl = backendUrl;
    audioCaptionDebug.transcribeStartedAt = transcribeStartedAt;
    audioCaptionDebug.updatedAt = Date.now();
    console.log(AUDIO_DIAG_LOG, 'posting transcribe', {
      videoId: cleanVideoId,
      transcribePostCount: audioCaptionDebug.transcribePostCount,
    });
    console.log(AUDIO_CAPTIONS_BG_LOG, 'posting /captions/transcribe (caption-only)', {
      videoId: cleanVideoId,
      startSeconds: normalizedStart,
      endSeconds: normalizedEnd,
      mimeType: mimeType || 'audio/wav',
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
        capture_started_at: captureStartedAt,
        chunk_emitted_at: chunkEmittedAt,
        backend_received_at: backendReceivedAt,
        chunk_started_at: chunkStartedAt,
        chunk_flushed_at: chunkFlushedAt,
        session_id: sessionId,
        chunk_id: chunkId,
        tab_id: Number.isFinite(Number(tabId)) ? Number(tabId) : (Number.isFinite(Number(activeTabAudioCapture?.tabId)) ? Number(activeTabAudioCapture.tabId) : null),
        sequence_number: sequenceNumber,
        audio_window_start_ms: audioWindowStartMs,
        audio_window_end_ms: audioWindowEndMs,
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
      captionReadinessState.lastError = backendFailureReason || `http_${res.status}`;
      captionReadinessState.lastFailureReason = backendFailureReason || 'analyze_exception';
      captionReadinessState.lastSttStatus = backendFailureReason === 'stt_disabled'
        ? 'disabled'
        : (backendFailureReason === 'transcription_unavailable' ? 'model_unavailable' : 'transcription_error');
      captionReadinessState.lastSttError = backendFailureReason || null;
      return {
        status: 'error',
        events: [],
        failure_reason: backendFailureReason || 'analyze_exception',
        backend_status: res.status,
        backend_body: (responseBody || '').slice(0, 500),
      };
    }

    const payload = responseBody ? JSON.parse(responseBody) : {};
    const transcribeFinishedAt = Date.now();
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
    const normalizedStatus = payload.status || (hasDisplayPayload ? 'ready' : 'error');
    const backendLatency = payload?.latency && typeof payload.latency === 'object' ? payload.latency : {};
    const captureStartedAtOut = Number.isFinite(Number(backendLatency.capture_started_at))
      ? Number(backendLatency.capture_started_at)
      : captureStartedAt;
    const chunkEmittedAtOut = Number.isFinite(Number(backendLatency.chunk_emitted_at))
      ? Number(backendLatency.chunk_emitted_at)
      : chunkEmittedAt;
    const backendReceivedAtOut = Number.isFinite(Number(backendLatency.backend_received_at))
      ? Number(backendLatency.backend_received_at)
      : backendReceivedAt;
    const transcribeStartedAtOut = Number.isFinite(Number(backendLatency.transcribe_started_at))
      ? Number(backendLatency.transcribe_started_at)
      : transcribeStartedAt;
    const transcribeFinishedAtOut = Number.isFinite(Number(backendLatency.transcribe_finished_at))
      ? Number(backendLatency.transcribe_finished_at)
      : transcribeFinishedAt;

    const result = {
      status: normalizedStatus,
      source: payload.source || 'audio',
      tab_id: Number.isFinite(Number(tabId)) ? Number(tabId) : (Number.isFinite(Number(activeTabAudioCapture?.tabId)) ? Number(activeTabAudioCapture.tabId) : null),
      video_id: cleanVideoId,
      session_id: sessionId,
      chunk_id: chunkId,
      sequence_number: sequenceNumber,
      audio_window_start_ms: audioWindowStartMs,
      audio_window_end_ms: audioWindowEndMs,
      start_seconds: normalizedStart,
      end_seconds: normalizedEnd,
      events: [],  // caption-only: never return filter events
      cleaned_captions: normalizedCleanedCaptions,
      clean_captions: normalizedCleanedCaptions,
      text: typeof payload.text === 'string' ? payload.text : null,
      clean_text: typeof payload.clean_text === 'string' ? payload.clean_text : null,
      cleaned_text: typeof payload.cleaned_text === 'string' ? payload.cleaned_text : null,
      caption_text: typeof payload.caption_text === 'string' ? payload.caption_text : null,
      words: Array.isArray(payload.words)
        ? payload.words
        : (Array.isArray(payload.word_timestamps) ? payload.word_timestamps : []),
      word_timestamps: Array.isArray(payload.word_timestamps)
        ? payload.word_timestamps
        : (Array.isArray(payload.words) ? payload.words : []),
      failure_reason: payload.failure_reason || payload.reason || null,
      cached: payload.cached === true,
      is_partial: payload.is_partial === true,
      stable_text: typeof payload.stable_text === 'string' ? payload.stable_text : '',
      stt_status: typeof payload.stt_status === 'string' ? payload.stt_status : null,
      stt_error: typeof payload.stt_error === 'string' ? payload.stt_error : null,
      latency: {
        captureStartedAt: captureStartedAtOut,
        chunkStartedAt,
        chunkFlushedAt,
        chunkEmittedAt: chunkEmittedAtOut,
        backendReceivedAt: backendReceivedAtOut,
        transcribeStartedAt: transcribeStartedAtOut,
        transcribeFinishedAt: transcribeFinishedAtOut,
        capture_started_at: captureStartedAtOut,
        chunk_started_at: chunkStartedAt,
        chunk_flushed_at: chunkFlushedAt,
        chunk_emitted_at: chunkEmittedAtOut,
        backend_received_at: backendReceivedAtOut,
        transcribe_started_at: transcribeStartedAtOut,
        transcribe_finished_at: transcribeFinishedAtOut,
        relaySentAt: null,
        overlayRenderedAt: null,
        contentScriptReceivedAt: null,
        content_script_received_at: null,
        overlay_rendered_at: null,
        totalLatencyMs: Number.isFinite(Number(captureStartedAtOut))
          ? Math.max(transcribeFinishedAtOut - Number(captureStartedAtOut), 0)
          : null,
        total_latency_ms: Number.isFinite(Number(captureStartedAtOut))
          ? Math.max(transcribeFinishedAtOut - Number(captureStartedAtOut), 0)
          : null,
      },
    };
    console.log(AUDIO_CAPTIONS_BG_LOG, 'caption transcribe response', {
      videoId: cleanVideoId,
      status: result.status,
      source: result.source,
      textPreview: typeof result.text === 'string' ? result.text.slice(0, 80) : '',
      failure_reason: result.failure_reason || null,
    });
    const resultText = result.text || result.clean_text || result.cleaned_text || '';
    captionReadinessState.lastFailureReason = result.failure_reason || null;
    captionReadinessState.lastSttStatus = String(result.stt_status || (result.failure_reason ? 'transcription_error' : 'ok'));
    captionReadinessState.lastSttError = result.stt_error || null;
    captionReadinessState.lastCaptionLatencyMs = Number.isFinite(Number(result?.latency?.totalLatencyMs))
      ? Number(result.latency.totalLatencyMs)
      : captionReadinessState.lastCaptionLatencyMs;
    if (result.status === 'ready' && resultText) {
      audioCaptionDebug.transcribeOkCount += 1;
      captionReadinessState.lastCaptionAt = Date.now();
      captionReadinessState.lastError = null;
    } else if (!resultText) {
      audioCaptionDebug.transcribeEmptyCount += 1;
    } else {
      audioCaptionDebug.transcribeErrorCount += 1;
      captionReadinessState.lastError = result.failure_reason || 'transcription_error';
    }
    audioCaptionDebug.lastTranscribeStatus = result.status;
    audioCaptionDebug.lastTranscribeSource = result.source;
    audioCaptionDebug.lastTextLength = resultText.length;
    audioCaptionDebug.lastTextPreview = resultText.slice(0, 60);
    audioCaptionDebug.transcribeFinishedAt = transcribeFinishedAt;
    audioCaptionDebug.totalLatencyMs = Number.isFinite(Number(chunkStartedAt))
      ? Math.max(transcribeFinishedAt - Number(chunkStartedAt), 0)
      : null;
    audioCaptionDebug.updatedAt = Date.now();
    console.log(AUDIO_DIAG_LOG, 'transcribe result', {
      status: result.status,
      source: result.source,
      textLength: resultText.length,
      textPreview: resultText.slice(0, 60),
      failure_reason: result.failure_reason || null,
    });
    console.log(CAPTION_LATENCY_LOG, 'transcribe complete', {
      videoId: cleanVideoId,
      captureStartedAt: captureStartedAtOut,
      chunkStartedAt,
      chunkFlushedAt,
      chunkEmittedAt: chunkEmittedAtOut,
      backendReceivedAt: backendReceivedAtOut,
      transcribeStartedAt: transcribeStartedAtOut,
      transcribeFinishedAt: transcribeFinishedAtOut,
      totalLatencyMs: result.latency.totalLatencyMs,
      textLength: resultText.length,
    });
    if (result.source === 'audio_stt_disabled' || result.failure_reason === 'stt_disabled') {
      console.warn(AUDIO_CAPTIONS_LOG, 'STT disabled', {
        videoId: cleanVideoId,
        failure_reason: result.failure_reason,
      });
    }
    if (String(result.source || '').toLowerCase() === 'silence') {
      const invalidSilenceText = String(result.text || result.clean_text || result.cleaned_text || '').trim();
      if (invalidSilenceText) {
        console.warn(CAPTION_STATE_LOG, 'invalid silence text dropped', {
          tab_id: result.tab_id,
          video_id: result.video_id,
          session_id: result.session_id,
          chunk_id: result.chunk_id,
          textPreview: invalidSilenceText.slice(0, 80),
        });
        result.text = '';
        result.clean_text = '';
        result.cleaned_text = '';
        result.stable_text = '';
      }
    }
    return result;
  } catch (err) {
    const errorText = err?.message || String(err);
    const failureReason = /Failed to fetch|NetworkError|fetch/i.test(errorText)
      ? 'backend_not_running'
      : 'analyze_exception';
    audioCaptionDebug.transcribeErrorCount += 1;
    audioCaptionDebug.lastError = errorText.slice(0, 80);
    audioCaptionDebug.updatedAt = Date.now();
    captionReadinessState.lastError = errorText.slice(0, 120);
    captionReadinessState.lastFailureReason = failureReason;
    captionReadinessState.lastSttStatus = failureReason === 'backend_not_running' ? 'backend_unreachable' : 'transcription_error';
    captionReadinessState.lastSttError = errorText.slice(0, 120);
    console.warn(AUDIO_DIAG_LOG, 'transcribe result', { status: 'error', failure_reason: failureReason, err: errorText.slice(0, 80) });
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
  let token = await getAuthToken();
  if (!token) {
    token = await ensureLocalDevCaptionToken(backendUrl);
  }
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
    console.log(AUDIO_CAPTIONS_BG_LOG, 'posting /captions/transcribe', {
      videoId: cleanVideoId,
      startSeconds: normalizedStart,
      endSeconds: normalizedEnd,
      mimeType: mimeType || 'audio/wav',
    });
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
      words: Array.isArray(payload.words)
        ? payload.words
        : (Array.isArray(payload.word_timestamps) ? payload.word_timestamps : []),
      word_timestamps: Array.isArray(payload.word_timestamps)
        ? payload.word_timestamps
        : (Array.isArray(payload.words) ? payload.words : []),
      failure_reason: payload.failure_reason || payload.reason || null,
      cached: payload.cached === true,
    };
    console.log(AUDIO_CAPTIONS_BG_LOG, 'transcribe response', {
      videoId: cleanVideoId,
      status: result.status,
      source: result.source,
      textPreview: typeof result.text === 'string' ? result.text.slice(0, 80) : '',
      failure_reason: result.failure_reason || null,
      cached: result.cached,
    });
    if (result.source === 'audio_stt_disabled' || result.failure_reason === 'stt_disabled') {
      console.warn(AUDIO_CAPTIONS_LOG, 'STT disabled', {
        videoId: cleanVideoId,
        failure_reason: result.failure_reason,
      });
    }
    const transcriptEligible = shouldAnalyzeTranscriptForFiltering(result.text, result.source);
    if (result.status === 'ready' && typeof result.text === 'string' && result.text.trim() && transcriptEligible) {
      console.log(AUDIO_CAPTIONS_LOG, 'transcript received', {
        videoId: cleanVideoId,
        textPreview: result.text.slice(0, 80),
      });
    } else {
      console.log(AUDIO_CAPTIONS_LOG, 'silence/no transcript', {
        videoId: cleanVideoId,
        source: result.source || null,
        failure_reason: result.failure_reason || null,
      });
    }

    if (result.failure_reason === 'backend_not_running') {
      console.warn(AUDIO_CAPTIONS_LOG, 'backend offline', { videoId: cleanVideoId });
    }

    if (result.status === 'ready' && result.events.length === 0 && transcriptEligible) {
      // Selected-word mute mode is driven solely by /captions/transcribe word timestamps
      // in the content script. Do not call /event or handleCaptionDecision here.
      console.log('[ISWEEP][WORD_MUTE] skipping /event decision; using STT word timestamps only', {
        videoId: cleanVideoId,
        source: result.source,
        textLength: typeof result.text === 'string' ? result.text.length : 0,
      });
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
