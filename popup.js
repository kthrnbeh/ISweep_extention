// ISweep Chrome Extension - Popup Controller
// Handles UI state, authentication flow, and user interactions
// IMPORTANT:
// chrome.runtime.sendMessage only works inside the extension context.
// Do NOT test runtime messaging from normal webpage DevTools. Use the extension service worker console instead.

// Configuration - Web App Base URL
// Default to public GitHub Pages; allow override via stored setting for local dev.
const DEFAULT_FRONTEND_BASE = 'https://kthrnbeh.github.io/ISweep';

// Storage Keys
const STORAGE_KEYS = {
  AUTH: 'isweepAuth',
  ENABLED: 'isweepEnabled',
  TOKEN: 'isweepToken',
  USER_ID: 'isweepUserId',
  PREFS: 'isweepPreferences',
  BACKEND_URL: 'isweepBackendUrl',
  FRONTEND_URL: 'isweepFrontendUrl'
};

// Shared token key used by the site and the bridge content script.
const TOKEN_KEY = 'isweep_auth_token';

const LOG_PREFIX = '[ISWEEP][POPUP]';

async function getBackendUrl() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]);
  return store[STORAGE_KEYS.BACKEND_URL] || 'http://127.0.0.1:5000';
}

async function getFrontendBaseUrl() {
  const store = await chrome.storage.local.get([STORAGE_KEYS.FRONTEND_URL]);
  const base = store[STORAGE_KEYS.FRONTEND_URL] || DEFAULT_FRONTEND_BASE;
  return base.replace(/\/+$/, '');
}

async function saveAuthSession({ authData }) {
  const payload = {
    [STORAGE_KEYS.AUTH]: authData,
    [STORAGE_KEYS.ENABLED]: true,
  };
  await chrome.storage.local.set(payload);
}

// DOM Elements - Logged Out State
const stateLoggedOut = document.getElementById('stateLoggedOut');
const btnLogin = document.getElementById('btnLogin');
const linkCreateAccount = document.getElementById('linkCreateAccount');
const quickLoginForm = document.getElementById('quickLoginForm');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const btnQuickLogin = document.getElementById('btnQuickLogin');
const btnCancelQuickLogin = document.getElementById('btnCancelQuickLogin');

// DOM Elements - Logged In State
const stateLoggedIn = document.getElementById('stateLoggedIn');
const userAvatar = document.getElementById('userAvatar');
const userInitials = document.getElementById('userInitials');
const userName = document.getElementById('userName');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const btnOpenSettings = document.getElementById('btnOpenSettings');
const btnSyncPrefs = document.getElementById('btnSyncPrefs');
const linkResetFilters = document.getElementById('linkResetFilters');
const linkManageAccount = document.getElementById('linkManageAccount');
const linkLogout = document.getElementById('linkLogout');
const signedInStatus = document.getElementById('signedInStatus');

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
      STORAGE_KEYS.TOKEN,
      STORAGE_KEYS.USER_ID,
      STORAGE_KEYS.PREFS,
    ]);
    
    let authData = result[STORAGE_KEYS.AUTH];
    const hasToken = Boolean(result[STORAGE_KEYS.TOKEN]);
    const isEnabled = result[STORAGE_KEYS.ENABLED] !== false; // Default to true if not set
    
    console.log(LOG_PREFIX, 'Auth data:', authData ? 'Present' : 'None', 'token:', hasToken);
    console.log(LOG_PREFIX, 'Enabled state:', isEnabled);

    // Fallback: if token exists but authData missing, synthesize a minimal auth record so UI shows logged-in.
    if (!authData && hasToken) {
      authData = { email: '(signed in)', displayName: 'ISweep user', initials: '--', loggedInAt: new Date().toISOString() };
    }
    
    if (authData && (authData.email || hasToken)) {
      renderLoggedInState(authData, isEnabled);
      // Reflect cached prefs status for clarity.
      if (signedInStatus) {
        const prefs = result[STORAGE_KEYS.PREFS];
        signedInStatus.textContent = prefs ? 'Signed in. Preferences cached.' : 'Signed in. No preferences cached yet.';
      }
    } else {
      renderLoggedOutState();
    }
    
    // Set up event listeners
    setupEventListeners();
    
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
  stateLoggedOut.classList.remove('hidden');
  stateLoggedIn.classList.add('hidden');
}

/**
 * Render the Logged In state
 * @param {Object} authData - User authentication data {email, displayName, initials, loggedInAt}
 * @param {boolean} isEnabled - Whether ISweep filtering is enabled
 */
function renderLoggedInState(authData, isEnabled) {
  console.log(LOG_PREFIX, 'rendering logged in state');
  
  // Update user display name
  const displayName = authData.displayName || authData.email.split('@')[0];
  userName.textContent = displayName;
  
  // Update avatar initials
  userInitials.textContent = 'KA';
  
  // Update status based on enabled state
  if (isEnabled) {
    statusDot.classList.remove('paused');
    statusText.textContent = 'ISweep is Active';
  } else {
    statusDot.classList.add('paused');
    statusText.textContent = 'ISweep is Paused';
  }
  if (signedInStatus) signedInStatus.textContent = 'Signed in.';
  
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
  
  const parts = name.split(/[\s@._-]+/).filter(p => p.length > 0);
  
  if (parts.length === 0) return '--';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Set up all event listeners for buttons and links
 */
function setupEventListeners() {
  // Logged Out State Events
  btnLogin.addEventListener('click', handleLoginClick);
  linkCreateAccount.addEventListener('click', handleCreateAccountClick);
  btnQuickLogin.addEventListener('click', handleQuickLogin);
  btnCancelQuickLogin.addEventListener('click', handleCancelQuickLogin);
  
  // Logged In State Events
  btnOpenSettings.addEventListener('click', handleOpenSettings);
  if (btnSyncPrefs) {
    btnSyncPrefs.addEventListener('click', handleSyncPrefs);
  }
  linkResetFilters.addEventListener('click', handleResetFilters);
  linkManageAccount.addEventListener('click', handleManageAccount);
  linkLogout.addEventListener('click', handleLogout);
  
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

async function handleSyncPrefs(e) {
  if (e) e.preventDefault();
  console.log(LOG_PREFIX, 'prefs sync start');
  try {
    // Ask the active tab (site) to push its token into extension storage.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      try {
        await chrome.tabs.sendMessage(activeTab.id, { type: 'ISWEEP_PULL_TOKEN' });
      } catch (_) {
        // ignore; fallback to whatever is already in storage
      }
    }

    // Pull token from storage using unified key, fallback to legacy key.
    const store = await chrome.storage.local.get([TOKEN_KEY, STORAGE_KEYS.TOKEN]);
    const token = store[TOKEN_KEY] || store[STORAGE_KEYS.TOKEN];

    if (!token) {
      console.warn(LOG_PREFIX, 'prefs sync failed', 'missing token');
      alert('Sync failed. Please sign in on the ISweep site, then try again.');
      return;
    }

    // Keep legacy key populated for background fetch logic.
    await chrome.storage.local.set({ [STORAGE_KEYS.TOKEN]: token });

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
  chrome.tabs.create({ url: `${WEB_BASE_URL}/Account.html#create` });
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
      alert('Login failed. Please check your credentials and backend URL.');
      return;
    }
    console.log(LOG_PREFIX, 'login success', response.status || '');

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
  const base = await getFrontendBaseUrl();
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
      STORAGE_KEYS.TOKEN,
      STORAGE_KEYS.USER_ID,
      STORAGE_KEYS.PREFS,
    ]);
    
    console.log('[ISweep Popup] Logged out successfully');
    
    // Render logged out state
    renderLoggedOutState();
    
  } catch (error) {
    console.error('[ISweep Popup] Error logging out:', error);
    alert('Failed to log out. Please try again.');
  }
}
