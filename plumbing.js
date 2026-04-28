// ISweep Chrome Extension - Content Script (Plumbing)
// This script runs on all web pages and performs content filtering

(function() {
  'use strict';
  
  console.log('[ISweep Plumbing] Content script loaded on:', window.location.hostname); // Log host when loaded
  
  // Storage Keys
  const STORAGE_KEYS = {
    AUTH: 'isweepAuth',      // Stored auth info (email/token)
    ENABLED: 'isweepEnabled', // Flag to toggle filtering on/off
    TOKEN: 'isweep_auth_token',
    DEV_LOCAL_AUTH: 'devLocalAuthEnabled',
    BACKEND_URL: 'isweepBackendUrl'
  };

  const DEFAULT_BACKEND = 'http://127.0.0.1:5000';
  
  let isEnabled = true;        // Tracks whether filtering is enabled
  let isAuthenticated = false; // Tracks whether user is signed in

  function isLocalBackendUrl(url) {
    const value = String(url || '').trim().toLowerCase();
    return value.startsWith('http://127.0.0.1') || value.startsWith('http://localhost');
  }

  function computeAuthState(store) {
    const auth = store?.[STORAGE_KEYS.AUTH];
    const hasAuthEmail = Boolean(auth && auth.email);
    const hasToken = Boolean(store?.[STORAGE_KEYS.TOKEN]);
    const backendUrl = store?.[STORAGE_KEYS.BACKEND_URL] || DEFAULT_BACKEND;
    const devLocalAuthEnabled = store?.[STORAGE_KEYS.DEV_LOCAL_AUTH] === true && isLocalBackendUrl(backendUrl);

    if (devLocalAuthEnabled) {
      console.log('[ISWEEP][AUTH] dev local auth enabled');
    }

    const authenticated = hasAuthEmail || hasToken || devLocalAuthEnabled;
    if (!hasAuthEmail && !hasToken && devLocalAuthEnabled) {
      console.log('[ISWEEP][AUTH] using local preferences fallback');
    }
    return authenticated;
  }

  async function refreshAuthStateAndApply() {
    const store = await chrome.storage.local.get([
      STORAGE_KEYS.AUTH,
      STORAGE_KEYS.TOKEN,
      STORAGE_KEYS.DEV_LOCAL_AUTH,
      STORAGE_KEYS.BACKEND_URL,
    ]);
    isAuthenticated = computeAuthState(store);
    console.log('[ISweep Plumbing] Auth state changed, authenticated:', isAuthenticated);
    if (isEnabled && isAuthenticated) {
      startFiltering();
    } else {
      stopFiltering();
    }
  }
  
  /**
   * Initialize content script
   */
  async function init() {
    try {
      // Load enabled state and auth from storage
      const result = await chrome.storage.local.get([
        STORAGE_KEYS.ENABLED,
        STORAGE_KEYS.AUTH,
        STORAGE_KEYS.TOKEN,
        STORAGE_KEYS.DEV_LOCAL_AUTH,
        STORAGE_KEYS.BACKEND_URL,
      ]);
      
      isEnabled = result[STORAGE_KEYS.ENABLED] !== false; // Default to true if unset
      isAuthenticated = computeAuthState(result);
      
      console.log('[ISweep Plumbing] Initialized - Enabled:', isEnabled, 'Authenticated:', isAuthenticated);
      
      if (isEnabled && isAuthenticated) {
        // Start content filtering when both enabled and authed
        startFiltering();
      }
      
      // Listen for storage changes to react to toggle/auth updates
      chrome.storage.onChanged.addListener(handleStorageChange);
      
    } catch (error) {
      console.error('[ISweep Plumbing] Initialization error:', error); // Log init errors
    }
  }
  
  /**
   * Handle storage changes (enabled state or auth changes)
   */
  function handleStorageChange(changes, areaName) {
    if (areaName !== 'local') return; // Only care about local storage
    
    if (changes[STORAGE_KEYS.ENABLED]) {
      isEnabled = changes[STORAGE_KEYS.ENABLED].newValue !== false; // Update enabled flag
      console.log('[ISweep Plumbing] Enabled state changed to:', isEnabled);
      
      refreshAuthStateAndApply().catch((error) => {
        console.error('[ISweep Plumbing] Failed to refresh auth state:', error);
      });
    }

    if (
      changes[STORAGE_KEYS.AUTH]
      || changes[STORAGE_KEYS.TOKEN]
      || changes[STORAGE_KEYS.DEV_LOCAL_AUTH]
      || changes[STORAGE_KEYS.BACKEND_URL]
    ) {
      refreshAuthStateAndApply().catch((error) => {
        console.error('[ISweep Plumbing] Failed to refresh auth state:', error);
      });
    }
  }
  
  /**
   * Start content filtering
   */
  function startFiltering() {
    console.log('[ISweep Plumbing] Starting content filtering...');
    
    // TODO: Implement actual content filtering logic
    // - Scan page content for inappropriate material
    // - Apply blur/hide effects to flagged content
    // - Track statistics (blocked items count)
    // - Communicate with background script
    
    // Placeholder: Add visual indicator that ISweep is active (dev mode)
    addActiveIndicator();
  }
  
  /**
   * Stop content filtering
   */
  function stopFiltering() {
    console.log('[ISweep Plumbing] Stopping content filtering...');
    
    // TODO: Remove filters, restore original content
    
    // Remove visual indicator
    removeActiveIndicator();
  }
  
  /**
   * Add visual indicator (development mode only)
   */
  function addActiveIndicator() {
    if (document.getElementById('isweep-indicator')) return; // Avoid duplicates
    
    const indicator = document.createElement('div');
    indicator.id = 'isweep-indicator';
    indicator.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #14b8a6;
      color: white;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      z-index: 999999;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `; // Styles for the temporary indicator badge
    indicator.textContent = '🧹 ISweep Active'; // Label with emoji
    
    document.body.appendChild(indicator); // Add to page
    
    // Auto-remove after 3 seconds
    setTimeout(() => {
      removeActiveIndicator();
    }, 3000);
  }
  
  /**
   * Remove visual indicator
   */
  function removeActiveIndicator() {
    const indicator = document.getElementById('isweep-indicator');
    if (indicator) {
      indicator.remove(); // Remove badge if present
    }
  }
  
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init); // Wait for DOM load
  } else {
    init(); // Run immediately if DOM already ready
  }
  
})();
