// ISweep Chrome Extension - Background Service Worker
// Handles icon state updates based on enabled/disabled status

// Storage Keys
const STORAGE_KEYS = {
  AUTH: 'isweepAuth',
  ENABLED: 'isweepEnabled'
};

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
  console.log('[ISweep Background] Extension installed/updated:', details.reason);
  
  // Set default values if not already set
  const result = await chrome.storage.local.get([STORAGE_KEYS.ENABLED]);
  
  if (result[STORAGE_KEYS.ENABLED] === undefined) {
    // Default to enabled on first install
    await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: true });
    console.log('[ISweep Background] Set default enabled state to true');
  }
  
  // Update icon based on current state
  updateIcon(result[STORAGE_KEYS.ENABLED] !== false);
});

/**
 * Listen for storage changes and update icon accordingly
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  
  // Check if enabled state changed
  if (changes[STORAGE_KEYS.ENABLED]) {
    const newValue = changes[STORAGE_KEYS.ENABLED].newValue;
    console.log('[ISweep Background] Enabled state changed to:', newValue);
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
      console.log('[ISweep Background] Icon updated to:', isEnabled ? 'enabled' : 'disabled');
    } catch (iconError) {
      // If icon files don't exist, set badge text as fallback
      console.log('[ISweep Background] Icon files not found, using badge fallback');
      await chrome.action.setBadgeText({ text: isEnabled ? '✓' : '⏸' });
      await chrome.action.setBadgeBackgroundColor({ 
        color: isEnabled ? '#10b981' : '#6b7280' 
      });
    }
    
    // Set tooltip to indicate current state
    const title = isEnabled ? 'ISweep - Active' : 'ISweep - Paused';
    await chrome.action.setTitle({ title });
    
  } catch (error) {
    console.error('[ISweep Background] Error updating icon:', error);
  }
}

/**
 * Handle messages from content scripts or popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[ISweep Background] Received message:', message);
  
  if (message.action === 'updateIcon') {
    // Allow explicit icon updates from other parts of the extension
    updateIcon(message.enabled !== false);
    sendResponse({ success: true });
  }
  
  return true; // Keep message channel open for async response
});

// Initial icon update on service worker startup
chrome.storage.local.get([STORAGE_KEYS.ENABLED]).then((result) => {
  const isEnabled = result[STORAGE_KEYS.ENABLED] !== false;
  console.log('[ISweep Background] Service worker started, enabled state:', isEnabled);
  updateIcon(isEnabled);
});
