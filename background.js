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
  BACKEND_URL: 'isweepBackendUrl'
};

const TOKEN_KEY = 'isweep_auth_token'; // Shared with site_token_bridge and frontend localStorage

const LOG_PREFIX = '[ISWEEP][BG]';

const DEFAULT_BACKEND = 'http://127.0.0.1:5000';
const tabMuteState = new Map(); // tabId -> { timer, previousMuted }

async function muteTabForDuration(tabId, durationMs) {
  if (!tabId || durationMs <= 0) return;

  const tab = await chrome.tabs.get(tabId);
  const current = tabMuteState.get(tabId);
  const previousMuted = current ? current.previousMuted : Boolean(tab.mutedInfo && tab.mutedInfo.muted);

  if (current && current.timer) {
    clearTimeout(current.timer);
  }

  await chrome.tabs.update(tabId, { muted: true });
  const timer = setTimeout(async () => {
    try {
      await chrome.tabs.update(tabId, { muted: previousMuted });
      console.log(LOG_PREFIX, 'tab mute restored', { tabId, previousMuted });
    } catch (err) {
      console.warn(LOG_PREFIX, 'failed to restore tab mute state', { tabId, error: err?.message || err });
    } finally {
      tabMuteState.delete(tabId);
    }
  }, durationMs);

  tabMuteState.set(tabId, { timer, previousMuted });
  console.log(LOG_PREFIX, 'tab muted', { tabId, durationMs, previousMuted });
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

async function getBackendUrl() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]);
  return store[STORAGE_KEYS.BACKEND_URL] || DEFAULT_BACKEND;
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
  } else if (message.type === 'isweep_tab_mute') {
    const tabId = sender?.tab?.id;
    const durationMs = Math.max(Number(message.duration_ms) || 0, 0);
    muteTabForDuration(tabId, durationMs)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
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
async function handleCaptionDecision(text, captionDurationSeconds) {
  const backendUrl = await getBackendUrl();
  const token = await getAuthToken();
  if (!token) {
    console.warn('[ISWEEP][BG][AUTH] missing token; blocking /event');
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
