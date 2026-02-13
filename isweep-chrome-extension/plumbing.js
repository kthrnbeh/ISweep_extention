// ISweep Chrome Extension - Content Script (Plumbing)
// This script runs on all web pages and performs content filtering

(function() {
  'use strict';
  
  console.log('[ISweep Plumbing] Content script loaded on:', window.location.hostname);
  
  // Storage Keys
  const STORAGE_KEYS = {
    AUTH: 'isweepAuth',
    ENABLED: 'isweepEnabled'
  };
  
  let isEnabled = true;
  let isAuthenticated = false;
  
  /**
   * Initialize content script
   */
  async function init() {
    try {
      // Load enabled state and auth from storage
      const result = await chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.AUTH]);
      
      isEnabled = result[STORAGE_KEYS.ENABLED] !== false;
      isAuthenticated = !!(result[STORAGE_KEYS.AUTH] && result[STORAGE_KEYS.AUTH].email);
      
      console.log('[ISweep Plumbing] Initialized - Enabled:', isEnabled, 'Authenticated:', isAuthenticated);
      
      if (isEnabled && isAuthenticated) {
        // Start content filtering
        startFiltering();
      }
      
      // Listen for storage changes
      chrome.storage.onChanged.addListener(handleStorageChange);
      
    } catch (error) {
      console.error('[ISweep Plumbing] Initialization error:', error);
    }
  }
  
  /**
   * Handle storage changes (enabled state or auth changes)
   */
  function handleStorageChange(changes, areaName) {
    if (areaName !== 'local') return;
    
    if (changes[STORAGE_KEYS.ENABLED]) {
      isEnabled = changes[STORAGE_KEYS.ENABLED].newValue !== false;
      console.log('[ISweep Plumbing] Enabled state changed to:', isEnabled);
      
      if (isEnabled && isAuthenticated) {
        startFiltering();
      } else {
        stopFiltering();
      }
    }
    
    if (changes[STORAGE_KEYS.AUTH]) {
      const newAuth = changes[STORAGE_KEYS.AUTH].newValue;
      isAuthenticated = !!(newAuth && newAuth.email);
      console.log('[ISweep Plumbing] Auth state changed, authenticated:', isAuthenticated);
      
      if (!isAuthenticated) {
        stopFiltering();
      } else if (isEnabled) {
        startFiltering();
      }
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
    if (document.getElementById('isweep-indicator')) return;
    
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
    `;
    indicator.textContent = '🧹 ISweep Active';
    
    document.body.appendChild(indicator);
    
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
      indicator.remove();
    }
  }
  
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
