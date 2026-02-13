# ISweep Chrome Extension

A Chrome extension for ISweep - Smart content filtering.

## Features

### Logged Out State
- ISweep logo
- "Sign in to Enable ISweep" message
- "Log in with Email" button (opens ISweep login page)
- "Create an account" link

### Logged In State
- Welcome message with ISweep logo
- Active/Paused status indicator (synced with chrome.storage)
- Toggle button to switch between Active/Paused states
- "Open Settings →" button (opens ISweep Settings page)
- Quick access links:
  - Reset Filters
  - Manage Account
  - Log Out

## Installation

1. Clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the extension directory

## File Structure

```
ISweep_extention/
├── manifest.json       # Extension configuration
├── popup.html          # Popup UI structure
├── popup.css           # Popup styling
├── popup.js            # Popup logic and functionality
├── icons/              # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## Development

The extension uses Chrome's `storage` API to manage:
- Authentication state (`isAuthenticated`, `authToken`)
- ISweep status (`isweepStatus`: 'active' or 'paused')

## Testing

To test different states:

1. **Test Logged Out State:**
   - Open Chrome DevTools
   - Go to Application > Storage > Local Storage
   - Clear all ISweep-related keys
   - Refresh the popup

2. **Test Logged In State:**
   - Open Chrome DevTools Console on the popup
   - Run: `chrome.storage.local.set({ isAuthenticated: true, authToken: 'test-token' })`
   - Refresh the popup

3. **Test Active/Paused Toggle:**
   - In logged-in state, click the "Toggle" button
   - The status should switch between "ISweep Active" (green) and "ISweep Paused" (orange)
