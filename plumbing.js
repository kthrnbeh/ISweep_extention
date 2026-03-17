// ISweep Chrome Extension - Content Script (Plumbing)
// This script runs on all web pages and performs content filtering

(function() {
  'use strict';
  
  console.log('[ISweep Plumbing] Content script loaded on:', window.location.hostname); // Log host when loaded
  
  // Storage Keys
  const STORAGE_KEYS = {
    AUTH: 'isweepAuth',      // Stored auth info (email/token)
    ENABLED: 'isweepEnabled' // Flag to toggle filtering on/off
  };
  
  let isEnabled = true;        // Tracks whether filtering is enabled
  let isAuthenticated = false; // Tracks whether user is signed in
  
  /**
   * Initialize content script
   */
  async function init() {
    try {
      // Load enabled state and auth from storage
      const result = await chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.AUTH]);
      
      isEnabled = result[STORAGE_KEYS.ENABLED] !== false; // Default to true if unset
      isAuthenticated = !!(result[STORAGE_KEYS.AUTH] && result[STORAGE_KEYS.AUTH].email); // Require email to count as authed
      
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
      
      if (isEnabled && isAuthenticated) {
        startFiltering();
      } else {
        stopFiltering();
      }
    }
    
    if (changes[STORAGE_KEYS.AUTH]) {
      const newAuth = changes[STORAGE_KEYS.AUTH].newValue; // Pull new auth data
      isAuthenticated = !!(newAuth && newAuth.email); // Authenticated if email present
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
