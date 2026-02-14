# ISweep Chrome Extension

Safe content filtering for a better browsing experience.

## Features

- **Two-State Popup UI**: Clean login and logged-in states
- **User Authentication**: Local storage-based auth with email login
- **Enabled/Paused Status**: Visual indicators for filtering state
- **Web Settings Integration**: Direct links to ISweep web app settings
- **Icon State Management**: Dynamic icon changes based on enabled state

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the repository root folder (`ISweep_extention/`)

## Development Setup

### Web App Base URL

The extension is configured to connect to the ISweep web app at:
- **Development**: `http://127.0.0.1:5500/docs`

To change the base URL, edit `WEB_BASE_URL` in `popup.js`.

### Testing the Extension

1. Load the extension in Chrome (see Installation above)
2. Click the ISweep icon in the toolbar to open the popup
3. **Logged Out State**: Click "Log in with Email"
   - Option 1: Opens web app login page in new tab
   - Option 2: Use quick login form (dev mode) - enter any email
4. **Logged In State**: After login, you'll see:
   - Welcome message with your name
   - Active/Paused status indicator
   - "Open Settings" button → opens web Settings page
   - Secondary links: Reset Filters, Manage Account, Log Out

### Manual Test Checklist

- [ ] Popup shows login state on first open
- [ ] "Log in with Email" opens web app Account page
- [ ] Quick login form accepts email and logs in
- [ ] Logged in state shows user name and initials
- [ ] Status shows "ISweep is Active" with green dot
- [ ] "Open Settings" opens `http://127.0.0.1:5500/docs/Settings.html`
- [ ] "Reset Filters" opens Settings page with #filters anchor
- [ ] "Manage Account" opens Account page
- [ ] "Log Out" clears auth and returns to login state
- [ ] Icon badge updates based on enabled state
- [ ] State persists across popup close/reopen
- [ ] State persists across browser restart

## File Structure

```
ISweep_extention/
├── manifest.json          # Extension manifest (Chrome Extension v3)
├── popup.html            # Popup UI with two states
├── popup.css             # Styling matching ISweep web aesthetic
├── popup.js              # Popup logic and event handlers
├── background.js         # Service worker for icon management
├── plumbing.js           # Content script for page filtering
├── options.html          # Options page (placeholder)
├── options.js            # Options logic (placeholder)
├── icons/                # Extension icons (enabled/disabled states)
│   ├── icon-16.png
│   ├── icon-48.png
│   ├── icon-128.png
│   ├── icon-disabled-16.png
│   ├── icon-disabled-48.png
│   └── icon-disabled-128.png
├── CONFIG.md             # Configuration guide
├── TESTING.md            # Testing guide
└── README.md             # This file
```

## Storage Schema

The extension uses `chrome.storage.local` for data persistence:

### `isweepAuth`
```javascript
{
  email: string,          // User's email address
  displayName: string,    // Display name (extracted from email)
  initials: string,       // User initials for avatar
  loggedInAt: string      // ISO timestamp of login
}
```

### `isweepEnabled`
```javascript
boolean  // true = filtering active, false = paused
```

## Web App Integration

### Required Web App Pages

The extension links to these pages on the ISweep web app:

- `/Settings.html` - Main settings page
- `/Settings.html#filters` - Settings page, filters section
- `/Account.html` - Account management
- `/Account.html#create` - Account creation

### URL Configuration

All web app URLs are configured via `WEB_BASE_URL` constant in `popup.js`:

```javascript
// Development
const WEB_BASE_URL = 'http://127.0.0.1:5500/docs';

// Production  
// const WEB_BASE_URL = 'https://isweep.example.com';
```

For production, update this to your production domain.

## Future Enhancements

- [ ] Implement actual content filtering in `plumbing.js`
- [ ] Add filter statistics and counters
- [ ] Implement OAuth or SSO for production login
- [ ] Add advanced settings in options page
- [ ] Add whitelist/blacklist management
- [ ] Implement sync across devices (chrome.storage.sync)
- [ ] Add notification system for blocked content

## License

© 2025 ISweep Inc.
