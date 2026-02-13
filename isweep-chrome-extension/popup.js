// ISweep Chrome Extension - Popup Controller
// Handles UI state, authentication flow, and user interactions

// Configuration - Web App Base URL
const WEB_BASE_URL = 'http://127.0.0.1:5500/docs';

// Storage Keys
const STORAGE_KEYS = {
  AUTH: 'isweepAuth',
  ENABLED: 'isweepEnabled'
};

// DOM Elements - Logged Out State
const stateLoggedOut = document.getElementById('stateLoggedOut');
const btnLogin = document.getElementById('btnLogin');
const linkCreateAccount = document.getElementById('linkCreateAccount');
const quickLoginForm = document.getElementById('quickLoginForm');
const emailInput = document.getElementById('emailInput');
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
const linkResetFilters = document.getElementById('linkResetFilters');
const linkManageAccount = document.getElementById('linkManageAccount');
const linkLogout = document.getElementById('linkLogout');

/**
 * Initialize popup on load
 * Loads auth and enabled state from chrome.storage.local
 * Renders the appropriate UI state
 */
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[ISweep Popup] Initializing...');
  
  try {
    // Load stored data from chrome.storage.local
    const result = await chrome.storage.local.get([STORAGE_KEYS.AUTH, STORAGE_KEYS.ENABLED]);
    
    const authData = result[STORAGE_KEYS.AUTH];
    const isEnabled = result[STORAGE_KEYS.ENABLED] !== false; // Default to true if not set
    
    console.log('[ISweep Popup] Auth data:', authData ? 'Present' : 'None');
    console.log('[ISweep Popup] Enabled state:', isEnabled);
    
    if (authData && authData.email) {
      // User is logged in - show logged in state
      renderLoggedInState(authData, isEnabled);
    } else {
      // User is logged out - show login state
      renderLoggedOutState();
    }
    
    // Set up event listeners
    setupEventListeners();
    
  } catch (error) {
    console.error('[ISweep Popup] Error initializing:', error);
    renderLoggedOutState(); // Fallback to logged out state
  }
});

/**
 * Render the Logged Out state
 */
function renderLoggedOutState() {
  console.log('[ISweep Popup] Rendering logged out state');
  stateLoggedOut.classList.remove('hidden');
  stateLoggedIn.classList.add('hidden');
}

/**
 * Render the Logged In state
 * @param {Object} authData - User authentication data {email, displayName, initials, loggedInAt}
 * @param {boolean} isEnabled - Whether ISweep filtering is enabled
 */
function renderLoggedInState(authData, isEnabled) {
  console.log('[ISweep Popup] Rendering logged in state');
  
  // Update user display name
  const displayName = authData.displayName || authData.email.split('@')[0];
  userName.textContent = displayName;
  
  // Update avatar initials
  const initials = authData.initials || getInitials(displayName);
  userInitials.textContent = initials;
  
  // Update status based on enabled state
  if (isEnabled) {
    statusDot.classList.remove('paused');
    statusText.textContent = 'ISweep is Active';
  } else {
    statusDot.classList.add('paused');
    statusText.textContent = 'ISweep is Paused';
  }
  
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
  linkResetFilters.addEventListener('click', handleResetFilters);
  linkManageAccount.addEventListener('click', handleManageAccount);
  linkLogout.addEventListener('click', handleLogout);
  
  // Allow Enter key in email input
  emailInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleQuickLogin();
    }
  });
}

/**
 * Handle "Log in with Email" button click
 * Opens web app login page in new tab and shows quick login form
 */
function handleLoginClick(e) {
  e.preventDefault();
  console.log('[ISweep Popup] Login button clicked');
  
  // Open web app login/account page in new tab
  chrome.tabs.create({ url: `${WEB_BASE_URL}/Account.html` });
  
  // Also show quick login form for development
  quickLoginForm.classList.remove('hidden');
  emailInput.focus();
}

/**
 * Handle "Create one here" link click
 * Opens web app account creation page
 */
function handleCreateAccountClick(e) {
  e.preventDefault();
  console.log('[ISweep Popup] Create account link clicked');
  chrome.tabs.create({ url: `${WEB_BASE_URL}/Account.html#create` });
}

/**
 * Handle quick login (development mode)
 * Saves email to chrome.storage.local and renders logged in state
 */
async function handleQuickLogin() {
  const email = emailInput.value.trim();
  
  if (!email || !email.includes('@')) {
    alert('Please enter a valid email address');
    return;
  }
  
  console.log('[ISweep Popup] Quick login for:', email);
  
  // Extract display name from email
  const displayName = email.split('@')[0];
  const initials = getInitials(displayName);
  
  // Create auth data object
  const authData = {
    email: email,
    displayName: displayName,
    initials: initials,
    loggedInAt: new Date().toISOString()
  };
  
  try {
    // Save to chrome.storage.local
    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTH]: authData,
      [STORAGE_KEYS.ENABLED]: true // Enable filtering on login
    });
    
    console.log('[ISweep Popup] Auth data saved successfully');
    
    // Render logged in state
    renderLoggedInState(authData, true);
    
    // Hide quick login form
    quickLoginForm.classList.add('hidden');
    emailInput.value = '';
    
  } catch (error) {
    console.error('[ISweep Popup] Error saving auth data:', error);
    alert('Failed to save login information. Please try again.');
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
 * Handle "Open Settings" button click
 * Opens ISweep Settings page in new tab
 */
function handleOpenSettings(e) {
  e.preventDefault();
  console.log('[ISweep Popup] Opening Settings page');
  chrome.tabs.create({ url: `${WEB_BASE_URL}/Settings.html` });
}

/**
 * Handle "Reset Filters" link click
 * Opens Settings page with filters section anchor
 */
function handleResetFilters(e) {
  e.preventDefault();
  console.log('[ISweep Popup] Opening Reset Filters');
  chrome.tabs.create({ url: `${WEB_BASE_URL}/Settings.html#filters` });
}

/**
 * Handle "Manage Account" link click
 * Opens Account page
 */
function handleManageAccount(e) {
  e.preventDefault();
  console.log('[ISweep Popup] Opening Manage Account');
  chrome.tabs.create({ url: `${WEB_BASE_URL}/Account.html` });
}

/**
 * Handle "Log Out" link click
 * Clears auth data and renders logged out state
 */
async function handleLogout(e) {
  e.preventDefault();
  console.log('[ISweep Popup] Logging out');
  
  try {
    // Remove auth data from storage
    await chrome.storage.local.remove(STORAGE_KEYS.AUTH);
    
    console.log('[ISweep Popup] Logged out successfully');
    
    // Render logged out state
    renderLoggedOutState();
    
  } catch (error) {
    console.error('[ISweep Popup] Error logging out:', error);
    alert('Failed to log out. Please try again.');
  }
}
