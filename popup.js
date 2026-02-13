// ISweep Chrome Extension Popup JavaScript

// Constants
const ISWEEP_FRONTEND_URL = 'https://isweep.app'; // Replace with actual ISweep frontend URL
const LOGIN_URL = `${ISWEEP_FRONTEND_URL}/login`;
const SETTINGS_URL = `${ISWEEP_FRONTEND_URL}/docs/Settings.html`;
const CREATE_ACCOUNT_URL = `${ISWEEP_FRONTEND_URL}/signup`;
const MANAGE_ACCOUNT_URL = `${ISWEEP_FRONTEND_URL}/account`;
const RESET_FILTERS_URL = `${ISWEEP_FRONTEND_URL}/#filters`;

// DOM Elements
const loggedOutView = document.getElementById('logged-out-view');
const loggedInView = document.getElementById('logged-in-view');
const loginBtn = document.getElementById('login-btn');
const createAccountLink = document.getElementById('create-account-link');
const settingsBtn = document.getElementById('settings-btn');
const toggleStatusBtn = document.getElementById('toggle-status-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const resetFiltersLink = document.getElementById('reset-filters-link');
const manageAccountLink = document.getElementById('manage-account-link');
const logoutLink = document.getElementById('logout-link');

// Initialize popup
document.addEventListener('DOMContentLoaded', initializePopup);

async function initializePopup() {
  // Check authentication state
  const isAuthenticated = await checkAuthState();
  
  if (isAuthenticated) {
    showLoggedInView();
    await loadStatus();
  } else {
    showLoggedOutView();
  }
  
  // Setup event listeners
  setupEventListeners();
}

// Authentication state management
async function checkAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['isAuthenticated', 'authToken'], (result) => {
      resolve(result.isAuthenticated === true && result.authToken);
    });
  });
}

async function clearAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(['isAuthenticated', 'authToken', 'userEmail'], () => {
      resolve();
    });
  });
}

// Status management
async function loadStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['isweepStatus'], (result) => {
      const status = result.isweepStatus || 'active';
      updateStatusUI(status);
      resolve(status);
    });
  });
}

async function toggleStatus() {
  const currentStatus = await loadStatus();
  const newStatus = currentStatus === 'active' ? 'paused' : 'active';
  
  return new Promise((resolve) => {
    chrome.storage.local.set({ isweepStatus: newStatus }, () => {
      updateStatusUI(newStatus);
      resolve(newStatus);
    });
  });
}

function updateStatusUI(status) {
  if (status === 'active') {
    statusIndicator.classList.remove('paused');
    statusIndicator.classList.add('active');
    statusText.textContent = 'ISweep Active';
  } else {
    statusIndicator.classList.remove('active');
    statusIndicator.classList.add('paused');
    statusText.textContent = 'ISweep Paused';
  }
}

// View management
function showLoggedOutView() {
  loggedOutView.classList.remove('hidden');
  loggedInView.classList.add('hidden');
}

function showLoggedInView() {
  loggedOutView.classList.add('hidden');
  loggedInView.classList.remove('hidden');
}

// Event listeners
function setupEventListeners() {
  // Logged out view
  loginBtn.addEventListener('click', handleLogin);
  createAccountLink.addEventListener('click', handleCreateAccount);
  
  // Logged in view
  settingsBtn.addEventListener('click', handleOpenSettings);
  toggleStatusBtn.addEventListener('click', handleToggleStatus);
  resetFiltersLink.addEventListener('click', handleResetFilters);
  manageAccountLink.addEventListener('click', handleManageAccount);
  logoutLink.addEventListener('click', handleLogout);
}

// Event handlers
function handleLogin(e) {
  e.preventDefault();
  chrome.tabs.create({ url: LOGIN_URL });
}

function handleCreateAccount(e) {
  e.preventDefault();
  chrome.tabs.create({ url: CREATE_ACCOUNT_URL });
}

function handleOpenSettings(e) {
  e.preventDefault();
  chrome.tabs.create({ url: SETTINGS_URL });
}

async function handleToggleStatus(e) {
  e.preventDefault();
  await toggleStatus();
}

function handleResetFilters(e) {
  e.preventDefault();
  chrome.tabs.create({ url: RESET_FILTERS_URL });
}

function handleManageAccount(e) {
  e.preventDefault();
  chrome.tabs.create({ url: MANAGE_ACCOUNT_URL });
}

async function handleLogout(e) {
  e.preventDefault();
  
  // Confirm logout
  if (confirm('Are you sure you want to log out?')) {
    await clearAuthState();
    showLoggedOutView();
  }
}

// Listen for storage changes (e.g., when user logs in from web)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes.isAuthenticated || changes.authToken) {
      initializePopup();
    }
    if (changes.isweepStatus) {
      updateStatusUI(changes.isweepStatus.newValue);
    }
  }
});
