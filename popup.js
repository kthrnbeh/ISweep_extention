// ISweep Chrome Extension - Popup Controller
// Handles UI state, authentication flow, and user interactions
// IMPORTANT:
// chrome.runtime.sendMessage only works inside the extension context.
// Do NOT test runtime messaging from normal webpage DevTools. Use the extension service worker console instead.

// Configuration - Web App Base URL
// Default to public GitHub Pages; allow override via stored setting for local dev.
const DEFAULT_FRONTEND_BASE = 'https://kthrnbeh.github.io/ISweep';
const DEFAULT_BACKEND = 'http://127.0.0.1:5000';
const DEFAULT_LOCAL_FRONTEND_BASE = 'http://127.0.0.1:5500/ISweep_frontend/docs';

// Storage Keys
const STORAGE_KEYS = {
  AUTH: 'isweepAuth',              // Cached auth info
  ENABLED: 'isweepEnabled',        // Toggle for filtering
  TOKEN: 'isweep_auth_token',      // Unified token key
  USER_ID: 'isweepUserId',         // Legacy user id key
  PREFS: 'isweepPreferences',      // Cached preferences
  BACKEND_URL: 'isweepBackendUrl', // Backend base URL
  FRONTEND_URL: 'isweepFrontendUrl',// Frontend base URL override
  CLEAN_CAPTION_SETTINGS: 'isweepCleanCaptionSettings',
  DEV_LOCAL_AUTH: 'devLocalAuthEnabled',
};

const CLEAN_CAPTION_DEFAULTS = {
  cleanCaptionsEnabled: true,
  cleanCaptionStyle: 'transparent_white',
  cleanCaptionTextSize: 'medium',
  cleanCaptionWordMuteMode: 'captions_only',
  cleanCaptionPosition: { x: 0.5, y: 0.8 },
};

function normalizeCleanCaptionSettings(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const style = data.cleanCaptionStyle === 'white_black' ? 'white_black' : 'transparent_white';
  const textSize = ['small', 'medium', 'large'].includes(data.cleanCaptionTextSize)
    ? data.cleanCaptionTextSize
    : 'medium';
  const wordMuteMode = (data.cleanCaptionWordMuteMode === 'captions_word_mute'
    || data.cleanCaptionWordMuteMode === 'captions_selected_word_mute')
    ? 'captions_word_mute'
    : 'captions_only';
  const enabled = data.cleanCaptionsEnabled !== false;
  const position = data.cleanCaptionPosition
    && Number.isFinite(Number(data.cleanCaptionPosition.x))
    && Number.isFinite(Number(data.cleanCaptionPosition.y))
    ? {
      x: Math.max(0, Math.min(1, Number(data.cleanCaptionPosition.x))),
      y: Math.max(0, Math.min(1, Number(data.cleanCaptionPosition.y))),
    }
    : { ...CLEAN_CAPTION_DEFAULTS.cleanCaptionPosition };
  return {
    cleanCaptionsEnabled: enabled,
    cleanCaptionStyle: style,
    cleanCaptionTextSize: textSize,
    cleanCaptionWordMuteMode: wordMuteMode,
    cleanCaptionPosition: position,
  };
}

// Shared token key used by the site and the bridge content script.
const TOKEN_KEY = 'isweep_auth_token';

const LOG_PREFIX = '[ISWEEP][POPUP]'; // Standard log prefix

function isLocalBackendUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return value.startsWith('http://127.0.0.1') || value.startsWith('http://localhost');
}

async function getBackendUrl() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]); // Fetch stored backend URL
  const value = String(store[STORAGE_KEYS.BACKEND_URL] || '').trim();
  let normalized = DEFAULT_BACKEND;
  if (value) {
    try {
      const parsed = new URL(value);
      const port = parsed.port || '80';
      if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && port === '5000') {
        normalized = DEFAULT_BACKEND;
      }
    } catch (_) {
      normalized = DEFAULT_BACKEND;
    }
  }
  if (store[STORAGE_KEYS.BACKEND_URL] !== normalized) {
    await chrome.storage.local.set({ [STORAGE_KEYS.BACKEND_URL]: normalized });
  }
  return normalized;
}

async function getFrontendBaseUrl() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.FRONTEND_URL]); // Fetch stored frontend URL
  const base = store[STORAGE_KEYS.FRONTEND_URL] || DEFAULT_FRONTEND_BASE; // Default to hosted frontend
  return base.replace(/\/+$/, ''); // Trim trailing slashes
}

async function getPreferredFrontendBaseUrl() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.FRONTEND_URL, STORAGE_KEYS.BACKEND_URL]);
  const configuredFrontend = String(store[STORAGE_KEYS.FRONTEND_URL] || '').trim();
  if (configuredFrontend) return configuredFrontend.replace(/\/+$/, '');

  const backend = String(store[STORAGE_KEYS.BACKEND_URL] || DEFAULT_BACKEND).trim();
  if (isLocalBackendUrl(backend)) return DEFAULT_LOCAL_FRONTEND_BASE;
  return DEFAULT_FRONTEND_BASE;
}

async function saveAuthSession({ authData }) {
  const payload = {
    [STORAGE_KEYS.AUTH]: authData,   // Persist auth payload
    [STORAGE_KEYS.ENABLED]: true,    // Enable filtering by default after login
  };
  await chrome.storage.local.set(payload); // Save to storage
}

// DOM Elements - Logged Out State
const stateLoggedOut = document.getElementById('stateLoggedOut'); // Logged-out container
const btnLogin = document.getElementById('btnLogin'); // Login button
const linkCreateAccount = document.getElementById('linkCreateAccount'); // Create account link
const quickLoginForm = document.getElementById('quickLoginForm'); // Inline login form
const emailInput = document.getElementById('emailInput'); // Email input field
const passwordInput = document.getElementById('passwordInput'); // Password input field
const btnQuickLogin = document.getElementById('btnQuickLogin'); // Submit quick login
const btnCreateLocalDevAccount = document.getElementById('btnCreateLocalDevAccount');
const btnCancelQuickLogin = document.getElementById('btnCancelQuickLogin'); // Cancel quick login

// DOM Elements - Logged In State
const stateLoggedIn = document.getElementById('stateLoggedIn'); // Logged-in container
const userAvatar = document.getElementById('userAvatar'); // Avatar element (not dynamically used yet)
const userInitials = document.getElementById('userInitials'); // Initials badge
const userName = document.getElementById('userName'); // Display name text
const statusDot = document.getElementById('statusDot'); // Status indicator dot
const statusText = document.getElementById('statusText'); // Status text label
const btnOpenSettings = document.getElementById('btnOpenSettings'); // Open filters/settings
const btnSyncPrefs = document.getElementById('btnSyncPrefs'); // Sync prefs button
const linkResetFilters = document.getElementById('linkResetFilters'); // Reset filters link
const linkManageAccount = document.getElementById('linkManageAccount'); // Manage account link
const linkLogout = document.getElementById('linkLogout'); // Logout link
const signedInStatus = document.getElementById('signedInStatus'); // Status line about prefs cache
const btnCleanCaptionsToggle = document.getElementById('btnCleanCaptionsToggle');
const btnCaptionAppearance = document.getElementById('btnCaptionAppearance');
const captionSettingsPanel = document.getElementById('captionSettingsPanel');
const captionRuntimeStatus = document.getElementById('captionRuntimeStatus');
const backendStateValue = document.getElementById('backendStateValue');
const backendUrlValue = document.getElementById('backendUrlValue');
const backendLastErrorValue = document.getElementById('backendLastErrorValue');
const backendSttStatusValue = document.getElementById('backendSttStatusValue');
const backendLastSuccessCaptionValue = document.getElementById('backendLastSuccessCaptionValue');
const captionStateValue = document.getElementById('captionStateValue');
const primaryCaptionSourceValue = document.getElementById('primaryCaptionSourceValue');
const currentChunkIdValue = document.getElementById('currentChunkIdValue');
const lastAcceptedWindowValue = document.getElementById('lastAcceptedWindowValue');
const lastDropReasonValue = document.getElementById('lastDropReasonValue');
const pageTextAssistSourceValue = document.getElementById('pageTextAssistSourceValue');
const sttPageAgreementValue = document.getElementById('sttPageAgreementValue');
const captionModeValue = document.getElementById('captionModeValue');
const selectedWordsCountValue = document.getElementById('selectedWordsCountValue');
const selectedWordsPreviewValue = document.getElementById('selectedWordsPreviewValue');
const cleanCaptionStyleSelect = document.getElementById('cleanCaptionStyle');
const cleanCaptionTextSizeSelect = document.getElementById('cleanCaptionTextSize');
const cleanCaptionWordMuteModeSelect = document.getElementById('cleanCaptionWordMuteMode');
const btnResetCaptionPosition = document.getElementById('btnResetCaptionPosition');

let cleanCaptionSettingsCache = { ...CLEAN_CAPTION_DEFAULTS };

function setSyncPrefsAvailability(hasToken) {
  if (!btnSyncPrefs) return;
  const enabled = hasToken === true;
  btnSyncPrefs.disabled = !enabled;
  btnSyncPrefs.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  btnSyncPrefs.title = enabled
    ? 'Sync preferences from your ISweep account'
    : 'Sign in on the ISweep site to sync preferences';
}

function renderCaptionRuntimeStatus(status) {
  if (!captionRuntimeStatus) return;
  const state = typeof status?.state === 'string' ? status.state : 'backend_offline';
  const label = typeof status?.label === 'string' ? status.label : 'Audio captions: Backend offline';
  const sourceLabel = typeof status?.sourceLabel === 'string' ? status.sourceLabel : '';
  captionRuntimeStatus.textContent = sourceLabel ? `Caption source: ${sourceLabel}` : label;
  captionRuntimeStatus.dataset.state = state;
}

function toRelativeTimeLabel(epochMs) {
  const value = Number(epochMs);
  if (!Number.isFinite(value) || value <= 0) return 'never';
  const deltaSec = Math.max(Math.floor((Date.now() - value) / 1000), 0);
  if (deltaSec < 1) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function renderCaptionReadiness(status) {
  const readiness = status?.readiness && typeof status.readiness === 'object' ? status.readiness : status;
  const backend = readiness?.backend && typeof readiness.backend === 'object' ? readiness.backend : {};

  if (backendStateValue) {
    const backendState = String(backend.state || '').trim().toLowerCase();
    if (backendState === 'ready') {
      backendStateValue.textContent = 'Ready';
    } else if (backendState === 'stt_disabled') {
      backendStateValue.textContent = 'STT Disabled';
    } else {
      backendStateValue.textContent = 'Offline';
    }
  }
  if (backendUrlValue) {
    backendUrlValue.textContent = String(backend.backendUrl || DEFAULT_BACKEND);
  }
  if (backendLastErrorValue) {
    const reasonCode = String(backend.reasonCode || status?.reasonCode || readiness?.lastFailureReason || '').trim();
    const detail = String(backend.errorMessage || readiness?.lastError || '').trim();
    backendLastErrorValue.textContent = reasonCode || detail ? `${reasonCode || 'error'}${detail ? ` (${detail})` : ''}` : 'none';
  }
  if (backendSttStatusValue) {
    const sttStatus = String(readiness?.sttStatus || backend.sttStatus || 'unknown');
    const sttError = String(readiness?.sttError || '').trim();
    backendSttStatusValue.textContent = sttError ? `${sttStatus} (${sttError})` : sttStatus;
  }
  if (backendLastSuccessCaptionValue) {
    const since = toRelativeTimeLabel(readiness?.lastSuccessfulCaptionAt);
    const latency = Number.isFinite(Number(readiness?.lastCaptionLatencyMs))
      ? `, ${Math.round(Number(readiness.lastCaptionLatencyMs))}ms`
      : '';
    backendLastSuccessCaptionValue.textContent = `${since}${latency}`;
  }
  if (captionStateValue) {
    captionStateValue.textContent = String(status?.captionState || readiness?.captionState || 'Listening');
  }
  if (primaryCaptionSourceValue) {
    primaryCaptionSourceValue.textContent = String(
      readiness?.primaryCaptionSource
      || status?.primaryCaptionSource
      || 'Waiting for audio'
    );
  }
  if (currentChunkIdValue) {
    currentChunkIdValue.textContent = String(status?.currentChunkId || readiness?.currentChunkId || 'none');
  }
  if (lastAcceptedWindowValue) {
    const endMs = Number(status?.lastAcceptedWindowEndMs ?? readiness?.lastAcceptedWindowEndMs);
    lastAcceptedWindowValue.textContent = Number.isFinite(endMs) && endMs >= 0 ? `${endMs}ms` : 'none';
  }
  if (lastDropReasonValue) {
    lastDropReasonValue.textContent = String(status?.lastDroppedReason || readiness?.lastDroppedReason || 'none');
  }
  if (pageTextAssistSourceValue) {
    const source = String(status?.pageTextAssistSource || readiness?.pageTextAssistSource || 'none');
    const assistState = String(status?.pageTextAssistState || readiness?.pageTextAssistState || '').trim();
    pageTextAssistSourceValue.textContent = assistState ? `${source} (${assistState})` : source;
  }
  if (sttPageAgreementValue) {
    sttPageAgreementValue.textContent = String(status?.sttPageAgreement || readiness?.sttPageAgreement || 'unavailable');
  }
  if (captionModeValue) {
    captionModeValue.textContent = String(readiness?.captionModeLabel || 'Captions Only');
  }
  if (selectedWordsCountValue) {
    selectedWordsCountValue.textContent = String(Number(readiness?.selectedWordCount || 0));
  }
  if (selectedWordsPreviewValue) {
    const preview = Array.isArray(readiness?.selectedWordPreview) ? readiness.selectedWordPreview : [];
    const source = String(readiness?.selectedWordSource || '').trim();
    const sourceSuffix = source ? ` [${source}]` : '';
    selectedWordsPreviewValue.textContent = preview.length
      ? `${preview.slice(0, 8).join(', ')}${sourceSuffix}`
      : `(none)${sourceSuffix}`;
  }
}

async function refreshCaptionRuntimeStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'isweep_get_caption_runtime_status' });
    renderCaptionRuntimeStatus(status);
    renderCaptionReadiness(status);
    const backendOk = status?.backend?.ok === true || status?.backendOnline === true;
    const sttEnabled = status?.backend?.stt_enabled === true || status?.sttEnabled === true;
    const captionSource = String(status?.source || status?.sourceLabel || status?.state || 'unknown');
    console.log('[ISWEEP][POPUP] health status', {
      backendOk,
      stt_enabled: sttEnabled,
      captionSource,
    });
    console.log('[ISWEEP][CAPTIONS]', 'popup status refreshed', status);
  } catch (error) {
    renderCaptionRuntimeStatus({ state: 'backend_offline', label: 'Audio captions: Backend offline' });
    renderCaptionReadiness({
      backend: {
        ready: false,
        backendUrl: DEFAULT_BACKEND,
        reasonCode: 'backend_unreachable',
      },
      sttStatus: 'unknown',
    });
    console.log('[ISWEEP][CAPTIONS]', 'popup status refresh failed', error?.message || error);
  }
}

/**
 * Initialize popup on load
 * Loads auth and enabled state from chrome.storage.local
 * Renders the appropriate UI state
 */
document.addEventListener('DOMContentLoaded', async () => {
  console.log(LOG_PREFIX, 'initializing...');
  
  try {
    // Load stored data from chrome.storage.local
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.AUTH,
      STORAGE_KEYS.ENABLED,
      TOKEN_KEY,
      STORAGE_KEYS.USER_ID,
      STORAGE_KEYS.PREFS,
      STORAGE_KEYS.DEV_LOCAL_AUTH,
      STORAGE_KEYS.BACKEND_URL,
    ]);
    
    let authData = result[STORAGE_KEYS.AUTH]; // Pull cached auth data
    const hasToken = Boolean(result[TOKEN_KEY]); // Token presence
    const isEnabled = result[STORAGE_KEYS.ENABLED] !== false; // Default to true if not set
    const devLocalAuthActive = result[STORAGE_KEYS.DEV_LOCAL_AUTH] === true
      && isLocalBackendUrl(result[STORAGE_KEYS.BACKEND_URL] || 'http://127.0.0.1:5000');
    
    console.log(LOG_PREFIX, 'Auth data:', authData ? 'Present' : 'None', 'token:', hasToken);
    console.log(LOG_PREFIX, 'Enabled state:', isEnabled);

    // Fallback: if token exists but authData missing, synthesize minimal auth so UI shows logged-in
    if (!authData && hasToken) {
      authData = { email: '(signed in)', displayName: 'ISweep user', initials: '--', loggedInAt: new Date().toISOString() };
    }

    if (!authData && !hasToken && devLocalAuthActive) {
      console.log('[ISWEEP][AUTH] dev local auth enabled');
      console.log('[ISWEEP][AUTH] using local preferences fallback');
      authData = {
        email: '(dev-local)',
        displayName: 'ISweep local dev',
        initials: 'DL',
        loggedInAt: new Date().toISOString(),
      };
    }
    
    if (authData && (authData.email || hasToken)) {
      renderLoggedInState(authData, isEnabled); // Show logged-in UI
      setSyncPrefsAvailability(hasToken);
      // Reflect cached prefs status for clarity.
      if (signedInStatus) {
        const prefs = result[STORAGE_KEYS.PREFS];
        if (devLocalAuthActive && !hasToken) {
          signedInStatus.textContent = prefs
            ? 'Dev local auth enabled. Using cached preferences.'
            : 'Dev local auth enabled. No cached preferences yet.';
        } else {
          signedInStatus.textContent = prefs ? 'Signed in. Preferences cached.' : 'Signed in. No preferences cached yet.';
        }
      }
    } else {
      renderLoggedOutState(); // Show logged-out UI
      setSyncPrefsAvailability(false);
    }
    
    // Set up event listeners
    setupEventListeners();
    await initCleanCaptionControls();
    await refreshCaptionRuntimeStatus();
    
  } catch (error) {
    console.error(LOG_PREFIX, 'Error initializing:', error);
    renderLoggedOutState(); // Fallback to logged out state
  }
});

/**
 * Render the Logged Out state
 */
function renderLoggedOutState() {
  console.log(LOG_PREFIX, 'rendering logged out state');
  stateLoggedOut.classList.remove('hidden'); // Show logged-out view
  stateLoggedIn.classList.add('hidden'); // Hide logged-in view
}

/**
 * Render the Logged In state
 * @param {Object} authData - User authentication data {email, displayName, initials, loggedInAt}
 * @param {boolean} isEnabled - Whether ISweep filtering is enabled
 */
function renderLoggedInState(authData, isEnabled) {
  console.log(LOG_PREFIX, 'rendering logged in state');
  
  // Update user display name
  const displayName = authData.displayName || authData.email.split('@')[0]; // Prefer displayName else email prefix
  userName.textContent = displayName;
  
  // Update avatar initials
  userInitials.textContent = 'KA'; // Static placeholder initials
  
  // Update status based on enabled state
  if (isEnabled) {
    statusDot.classList.remove('paused');
    statusText.textContent = 'ISweep is Active';
  } else {
    statusDot.classList.add('paused');
    statusText.textContent = 'ISweep is Paused';
  }
  if (signedInStatus) signedInStatus.textContent = 'Signed in.'; // Basic signed-in indicator
  
  // Show logged in state, hide logged out state
  stateLoggedIn.classList.remove('hidden');
  stateLoggedOut.classList.add('hidden');
}

/**
 * Extract initials from a name or email
 * @param {string} name - Name or email to extract initials from
 * @returns {string} Initials (up to 2 characters)
 */
function getInitials(name) {
  if (!name) return '--';
  
  const parts = name.split(/[\s@._-]+/).filter(p => p.length > 0); // Split on common separators
  
  if (parts.length === 0) return '--';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase(); // First two letters
  
  return (parts[0][0] + parts[1][0]).toUpperCase(); // First letters of first two parts
}

/**
 * Set up all event listeners for buttons and links
 */
function setupEventListeners() {
  // Logged Out State Events
  btnLogin.addEventListener('click', handleLoginClick); // Open login flow
  linkCreateAccount.addEventListener('click', handleCreateAccountClick); // Open account creation
  btnQuickLogin.addEventListener('click', handleQuickLogin); // Submit quick login
  if (btnCreateLocalDevAccount) {
    btnCreateLocalDevAccount.addEventListener('click', handleCreateLocalDevAccount);
  }
  btnCancelQuickLogin.addEventListener('click', handleCancelQuickLogin); // Cancel quick login
  
  // Logged In State Events
  btnOpenSettings.addEventListener('click', handleOpenSettings); // Open filters/settings page
  if (btnSyncPrefs) {
    btnSyncPrefs.addEventListener('click', handleSyncPrefs); // Trigger prefs sync
  }
  linkResetFilters.addEventListener('click', handleResetFilters); // Open reset filters section
  linkManageAccount.addEventListener('click', handleManageAccount); // Open account page
  linkLogout.addEventListener('click', handleLogout); // Log out

  if (btnCleanCaptionsToggle) {
    btnCleanCaptionsToggle.addEventListener('click', async () => {
      const next = {
        ...cleanCaptionSettingsCache,
        cleanCaptionsEnabled: !cleanCaptionSettingsCache.cleanCaptionsEnabled,
      };
      await saveCleanCaptionSettings(next);
    });
  }
  if (btnCaptionAppearance && captionSettingsPanel) {
    btnCaptionAppearance.addEventListener('click', () => {
      const willShow = captionSettingsPanel.classList.contains('hidden');
      captionSettingsPanel.classList.toggle('hidden', !willShow);
      btnCaptionAppearance.setAttribute('aria-expanded', willShow ? 'true' : 'false');
    });
  }
  if (cleanCaptionStyleSelect) {
    cleanCaptionStyleSelect.addEventListener('change', async () => {
      await saveCleanCaptionSettings({
        ...cleanCaptionSettingsCache,
        cleanCaptionStyle: cleanCaptionStyleSelect.value,
      });
    });
  }
  if (cleanCaptionTextSizeSelect) {
    cleanCaptionTextSizeSelect.addEventListener('change', async () => {
      await saveCleanCaptionSettings({
        ...cleanCaptionSettingsCache,
        cleanCaptionTextSize: cleanCaptionTextSizeSelect.value,
      });
    });
  }
  if (cleanCaptionWordMuteModeSelect) {
    cleanCaptionWordMuteModeSelect.addEventListener('change', async () => {
      await saveCleanCaptionSettings({
        ...cleanCaptionSettingsCache,
        cleanCaptionWordMuteMode: cleanCaptionWordMuteModeSelect.value,
      });
    });
  }
  if (btnResetCaptionPosition) {
    btnResetCaptionPosition.addEventListener('click', async () => {
      await saveCleanCaptionSettings({
        ...cleanCaptionSettingsCache,
        cleanCaptionPosition: { ...CLEAN_CAPTION_DEFAULTS.cleanCaptionPosition },
      });
    });
  }
  
  // Allow Enter key in email input
  emailInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleQuickLogin();
    }
  });
  if (passwordInput) {
    passwordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        handleQuickLogin();
      }
    });
  }
}

async function initCleanCaptionControls() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]);
  cleanCaptionSettingsCache = normalizeCleanCaptionSettings(store[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]);
  renderCleanCaptionControls();

  // Keep runtime capture state aligned with persisted [CC] toggle.
  // If the service worker restarted while [CC] stayed enabled, re-send start.
  try {
    await chrome.runtime.sendMessage({
      type: 'isweep_caption_capture_control',
      enabled: cleanCaptionSettingsCache.cleanCaptionsEnabled === true,
    });
  } catch (_) {
    // Best effort. Popup still reflects current persisted settings.
  }
}

function renderCleanCaptionControls() {
  if (btnCleanCaptionsToggle) {
    btnCleanCaptionsToggle.dataset.enabled = cleanCaptionSettingsCache.cleanCaptionsEnabled ? 'true' : 'false';
    btnCleanCaptionsToggle.setAttribute('aria-pressed', cleanCaptionSettingsCache.cleanCaptionsEnabled ? 'true' : 'false');
    btnCleanCaptionsToggle.textContent = '[CC]';
    btnCleanCaptionsToggle.setAttribute(
      'aria-label',
      cleanCaptionSettingsCache.cleanCaptionsEnabled ? 'Clean captions on' : 'Clean captions off'
    );
  }
  if (cleanCaptionStyleSelect) {
    cleanCaptionStyleSelect.value = cleanCaptionSettingsCache.cleanCaptionStyle;
  }
  if (cleanCaptionTextSizeSelect) {
    cleanCaptionTextSizeSelect.value = cleanCaptionSettingsCache.cleanCaptionTextSize;
  }
  if (cleanCaptionWordMuteModeSelect) {
    cleanCaptionWordMuteModeSelect.value = cleanCaptionSettingsCache.cleanCaptionWordMuteMode;
  }
}

async function saveCleanCaptionSettings(nextSettings) {
  cleanCaptionSettingsCache = normalizeCleanCaptionSettings(nextSettings);
  await chrome.storage.local.set({
    [STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]: cleanCaptionSettingsCache,
  });
  try {
    await chrome.runtime.sendMessage({
      type: cleanCaptionSettingsCache.cleanCaptionsEnabled === true
        ? 'isweep_start_audio_captions'
        : 'isweep_stop_audio_captions',
    });
  } catch (_) {
    // Best effort: content script also reacts to storage changes.
  }
  await notifyActiveYouTubeTabCleanCaptionSettings(cleanCaptionSettingsCache);
  renderCleanCaptionControls();
  await refreshCaptionRuntimeStatus();
  console.log(LOG_PREFIX, 'clean caption settings saved', cleanCaptionSettingsCache);
}

async function notifyActiveYouTubeTabCleanCaptionSettings(settings) {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) return;
    if (!/youtube\.com\/watch/i.test(String(activeTab.url || ''))) return;
    await chrome.tabs.sendMessage(activeTab.id, {
      type: 'isweep_clean_caption_settings_changed',
      settings,
    });
  } catch (_) {
    // Best effort: content script may not be ready yet; storage.onChanged is fallback.
  }
}

async function handleSyncPrefs(e) {
  if (e) e.preventDefault();
  console.log(LOG_PREFIX, 'prefs sync start');
  try {
    const preStore = await chrome.storage.local.get([
      TOKEN_KEY,
      STORAGE_KEYS.DEV_LOCAL_AUTH,
      STORAGE_KEYS.BACKEND_URL,
      STORAGE_KEYS.PREFS,
    ]);
    const devLocalAuthActive = preStore[STORAGE_KEYS.DEV_LOCAL_AUTH] === true
      && isLocalBackendUrl(preStore[STORAGE_KEYS.BACKEND_URL] || 'http://127.0.0.1:5000');

    // Ask the active tab (site) to push its token into extension storage.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      try {
        await chrome.tabs.sendMessage(activeTab.id, { type: 'ISWEEP_PULL_TOKEN' });
      } catch (_) {
        // ignore; fallback to whatever is already in storage
      }
    }

    // Pull token from storage using the canonical key.
    const store = await chrome.storage.local.get([TOKEN_KEY]);
    const token = store[TOKEN_KEY];

    if (!token) {
      if (devLocalAuthActive) {
        console.log('[ISWEEP][AUTH] dev local auth enabled');
        console.log('[ISWEEP][AUTH] using local preferences fallback');
        setSyncPrefsAvailability(false);
        if (signedInStatus) {
          signedInStatus.textContent = preStore[STORAGE_KEYS.PREFS]
            ? 'Dev local auth enabled. Using cached preferences.'
            : 'Dev local auth enabled. No cached preferences yet.';
        }
        return;
      }
      console.warn(LOG_PREFIX, 'prefs sync failed', 'missing token');
      setSyncPrefsAvailability(false);
      if (signedInStatus) {
        signedInStatus.textContent = 'Captions active. Sign in to sync preferences.';
      }
      return;
    }

    // Refresh canonical token key in storage for background fetch logic.
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
    setSyncPrefsAvailability(true);

    const res = await chrome.runtime
      .sendMessage({ type: 'isweep_sync_prefs' })
      .catch((err) => {
        console.error(LOG_PREFIX, 'Runtime message failed:', err);
        return { ok: false, error: 'background not available' };
      });
    if (!res || !res.ok) {
      console.warn(LOG_PREFIX, 'prefs sync failed', res?.error || 'unknown');
      alert('Sync failed. Are you logged in?');
      return;
    }
    console.log(LOG_PREFIX, 'prefs sync success', res.status || '');
    alert('Preferences synced.');
  } catch (err) {
    console.error(LOG_PREFIX, 'prefs sync failed', err);
    alert('Sync failed.');
  }
}

/**
 * Handle "Log in with Email" button click
 * Opens web app login page in new tab and shows quick login form
 */
function handleLoginClick(e) {
  e.preventDefault();
  console.log(LOG_PREFIX, 'login button clicked');

  // Show quick login form inside popup
  quickLoginForm.classList.remove('hidden');
  emailInput.focus();
}

/**
 * Handle "Create one here" link click
 * Opens web app account creation page
 */
function handleCreateAccountClick(e) {
  e.preventDefault();
  console.log(LOG_PREFIX, 'create account link clicked');
  getPreferredFrontendBaseUrl()
    .then((base) => {
      chrome.tabs.create({ url: `${base}/Account.html#create` });
    })
    .catch(() => {
      chrome.tabs.create({ url: `${DEFAULT_LOCAL_FRONTEND_BASE}/Account.html#create` });
    });
}

async function handleCreateLocalDevAccount() {
  const email = emailInput.value.trim();
  const password = (passwordInput?.value || '').trim();

  if (!email || !email.includes('@') || !password) {
    alert('Enter email and password to create a local dev account.');
    return;
  }

  const backendUrl = await getBackendUrl();
  if (!isLocalBackendUrl(backendUrl)) {
    alert('Local dev account creation is only available with local backend.');
    return;
  }

  const payload = { email, password };
  let responseBody = null;
  try {
    const signup = await fetch(`${backendUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (signup.ok) {
      responseBody = await signup.json().catch(() => ({}));
    } else if (signup.status === 409) {
      const login = await fetch(`${backendUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!login.ok) {
        const body = await login.text();
        throw new Error(body || `status ${login.status}`);
      }
      responseBody = await login.json().catch(() => ({}));
    } else {
      const body = await signup.text();
      throw new Error(body || `status ${signup.status}`);
    }

    if (!responseBody?.token) {
      throw new Error('Missing token in auth response');
    }

    const displayName = email.split('@')[0];
    const authData = {
      email,
      displayName,
      initials: getInitials(displayName),
      loggedInAt: new Date().toISOString(),
    };

    await chrome.storage.local.set({
      [TOKEN_KEY]: responseBody.token,
      [STORAGE_KEYS.USER_ID]: responseBody.user_id,
      [STORAGE_KEYS.AUTH]: authData,
      [STORAGE_KEYS.ENABLED]: true,
    });
    setSyncPrefsAvailability(true);
    renderLoggedInState(authData, true);
    if (signedInStatus) {
      signedInStatus.textContent = 'Signed in. Preferences can now sync.';
    }

    quickLoginForm.classList.add('hidden');
    emailInput.value = '';
    if (passwordInput) passwordInput.value = '';
    console.log(LOG_PREFIX, 'local dev account ready');
  } catch (error) {
    console.warn(LOG_PREFIX, 'local dev account creation failed', error?.message || error);
    alert('Local dev account creation failed. Please verify backend and credentials.');
  }
}

/**
 * Handle quick login (development mode)
 * Saves email to chrome.storage.local and renders logged in state
 */
async function handleQuickLogin() {
  const email = emailInput.value.trim();
  const password = (passwordInput?.value || '').trim();

  if (!email || !email.includes('@') || !password) {
    alert('Please enter email and password.');
    return;
  }

  console.log(LOG_PREFIX, 'login start');

  try {
    const response = await chrome.runtime
      .sendMessage({
        type: 'isweep_login',
        email,
        password,
      })
      .catch((err) => {
        console.error(LOG_PREFIX, 'Runtime message failed:', err);
        return { ok: false, error: 'background not available' };
      });
    if (!response || !response.ok) {
      console.warn(LOG_PREFIX, 'login failed', response?.error || 'unknown');
      const errorText = String(response?.error || '').toLowerCase();
      if (errorText.includes('invalid credentials')) {
        alert('Login failed: invalid credentials for this backend. If using local backend, create a local account first.');
      } else {
        alert(`Login failed. ${response?.error || 'Please check your credentials and backend URL.'}`);
      }
      return;
    }
    console.log('[ISWEEP][POPUP] login success', response.status || '');

    const displayName = email.split('@')[0];
    const initials = getInitials(displayName);
    const authData = {
      email,
      displayName,
      initials,
      loggedInAt: new Date().toISOString(),
    };

    await saveAuthSession({ authData });
    // Reflect prefs presence after background login
    const store = await chrome.storage.local.get([STORAGE_KEYS.PREFS]);
    if (signedInStatus) {
      signedInStatus.textContent = store[STORAGE_KEYS.PREFS]
        ? 'Signed in. Preferences cached.'
        : 'Signed in. No preferences cached yet (open Filters and Save).';
    }
    setSyncPrefsAvailability(true);
    renderLoggedInState(authData, true);

    quickLoginForm.classList.add('hidden');
    emailInput.value = '';
    if (passwordInput) passwordInput.value = '';
  } catch (error) {
    console.error(LOG_PREFIX, 'login failed', error);
    alert('Login failed. Please check your credentials and backend URL.');
  }
}

/**
 * Handle cancel quick login
 */
function handleCancelQuickLogin(e) {
  e.preventDefault();
  quickLoginForm.classList.add('hidden');
  emailInput.value = '';
}

/**
 * Handle "Open Filters" button click
 * Opens ISweep Filters page in new tab
 */
async function handleOpenSettings(e) {
  e.preventDefault();
  console.log(LOG_PREFIX, 'opening Filters page');
  const base = await getFrontendBaseUrl();
  chrome.tabs.create({ url: `${base}/Filter.html` });
}

/**
 * Handle "Reset Filters" link click
 * Opens Filters page with filters section anchor
 */
async function handleResetFilters(e) {
  e.preventDefault();
  console.log(LOG_PREFIX, 'opening Reset Filters');
  const base = await getFrontendBaseUrl();
  chrome.tabs.create({ url: `${base}/Filter.html#filters` });
}

/**
 * Handle "Manage Account" link click
 * Opens Account page
 */
async function handleManageAccount(e) {
  e.preventDefault();
  console.log(LOG_PREFIX, 'opening Manage Account');
  const base = await getPreferredFrontendBaseUrl();
  chrome.tabs.create({ url: `${base}/Account.html` });
}

/**
 * Handle "Log Out" link click
 * Clears auth data and renders logged out state
 */
async function handleLogout(e) {
  e.preventDefault();
  console.log(LOG_PREFIX, 'logging out');
  
  try {
    // Remove auth data from storage
    await chrome.storage.local.remove([
      STORAGE_KEYS.AUTH,
      STORAGE_KEYS.USER_ID,
      STORAGE_KEYS.PREFS,
      TOKEN_KEY,
    ]);
    setSyncPrefsAvailability(false);
    
    console.log('[ISWEEP][POPUP] Logged out successfully');
    
    // Render logged out state
    renderLoggedOutState();
    
  } catch (error) {
    console.error('[ISweep Popup] Error logging out:', error);
    alert('Failed to log out. Please try again.');
  }
}
