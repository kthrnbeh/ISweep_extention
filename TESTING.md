# ISweep Chrome Extension - Testing Guide

## Prerequisites

1. **Chrome Browser**: Ensure you have Google Chrome or Chromium installed
2. **Local Web Server**: You'll need to serve the docs folder on port 5500
3. **Extension Files**: The `isweep-chrome-extension` folder

## Setup Steps

### 1. Start Local Web Server

The extension expects the web app to be running at `http://127.0.0.1:5500`.

**Option A: Using Python**
```bash
cd /path/to/ISweep_extention
python3 -m http.server 5500
```

**Option B: Using Node.js (http-server)**
```bash
npm install -g http-server
cd /path/to/ISweep_extention
http-server -p 5500
```

**Option C: Using VS Code Live Server**
- Install the "Live Server" extension in VS Code
- Right-click on `docs/Settings.html`
- Select "Open with Live Server"
- Configure to use port 5500

### 2. Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle switch in top right corner)
3. Click "Load unpacked" button
4. Navigate to and select the `isweep-chrome-extension` folder
5. The ISweep extension should now appear in your extensions list

### 3. Pin the Extension (Optional)

1. Click the puzzle piece icon in Chrome toolbar
2. Find "ISweep" in the list
3. Click the pin icon to pin it to the toolbar

## Manual Testing Checklist

### Test 1: Initial State (Logged Out)

**Steps:**
1. Click the ISweep extension icon in the toolbar
2. Verify the popup opens and shows the logged out state

**Expected Results:**
- [ ] Popup displays with width ~360px
- [ ] Header shows ISweep logo (🧹) and name
- [ ] Title: "Sign in to Enable ISweep"
- [ ] Subtitle: "Login to enable safe content filtering."
- [ ] Primary button: "Log in with Email"
- [ ] Link: "No account? Create one here."
- [ ] Footer: "© 2025 ISweep Inc."
- [ ] Styling matches clean, professional aesthetic with teal/green theme

### Test 2: Login Flow - Web App

**Steps:**
1. In the logged out popup, click "Log in with Email"
2. Verify new tab opens

**Expected Results:**
- [ ] New tab opens to `http://127.0.0.1:5500/Account.html`
- [ ] Account page displays with login form
- [ ] Quick login form appears in popup (dev mode)

### Test 3: Login Flow - Quick Login (Dev Mode)

**Steps:**
1. In the popup, after clicking "Log in with Email", enter an email (e.g., `test@example.com`)
2. Click "Sign In" in the quick login form
3. Wait for state to update

**Expected Results:**
- [ ] Popup transitions to logged in state
- [ ] No errors in console
- [ ] State persists when popup is closed and reopened

### Test 4: Logged In State Display

**Steps:**
1. After logging in, verify the logged in state UI

**Expected Results:**
- [ ] Header shows ISweep logo and avatar circle with initials
- [ ] Avatar displays correct initials (e.g., "TE" for test@example.com)
- [ ] Greeting: "Welcome back, test!" (or first part of email)
- [ ] Status container shows green dot
- [ ] Status text: "ISweep is Active"
- [ ] Primary button: "Open Settings →"
- [ ] Links: "Reset Filters | Manage Account | Log Out"
- [ ] Footer: "© 2025 ISweep Inc."

### Test 5: Open Settings Button

**Steps:**
1. While logged in, click "Open Settings →" button

**Expected Results:**
- [ ] New tab opens to `http://127.0.0.1:5500/Settings.html`
- [ ] Settings page displays correctly
- [ ] Popup closes (normal Chrome extension behavior)

### Test 6: Reset Filters Link

**Steps:**
1. Open popup, click "Reset Filters" link

**Expected Results:**
- [ ] New tab opens to `http://127.0.0.1:5500/Settings.html#filters`
- [ ] Page scrolls to filters section
- [ ] Filters section briefly highlights (green border)

### Test 7: Manage Account Link

**Steps:**
1. Open popup, click "Manage Account" link

**Expected Results:**
- [ ] New tab opens to `http://127.0.0.1:5500/Account.html`
- [ ] Account page displays

### Test 8: Create Account Link (Logged Out)

**Steps:**
1. Log out first (see Test 9)
2. In logged out state, click "No account? Create one here."

**Expected Results:**
- [ ] New tab opens to `http://127.0.0.1:5500/Account.html#create`
- [ ] Account page displays with "Create Account" tab active

### Test 9: Log Out

**Steps:**
1. While logged in, click "Log Out" link
2. Verify state changes

**Expected Results:**
- [ ] Popup immediately transitions to logged out state
- [ ] Auth data cleared from storage
- [ ] Can verify in Chrome DevTools: `chrome.storage.local.get('isweepAuth', console.log)`

### Test 10: State Persistence

**Steps:**
1. Log in
2. Close the popup
3. Reopen the popup
4. Close Chrome completely
5. Restart Chrome
6. Open the popup again

**Expected Results:**
- [ ] Login state persists when popup is closed/reopened
- [ ] Login state persists across browser restart
- [ ] User name and initials remain correct

### Test 11: Icon State Management

**Steps:**
1. Check extension icon in toolbar
2. Open Chrome DevTools Console in background page
   - Go to `chrome://extensions/`
   - Find ISweep extension
   - Click "background page" or "service worker"
3. Monitor console logs

**Expected Results:**
- [ ] Icon shows enabled state (teal) or badge "✓"
- [ ] Console shows "[ISweep Background] Service worker started"
- [ ] No errors in background console

### Test 12: Enabled/Paused State (Manual Toggle)

**Steps:**
1. Open Chrome DevTools Console
2. Run: `chrome.storage.local.set({isweepEnabled: false})`
3. Reopen popup

**Expected Results:**
- [ ] Status dot changes to gray
- [ ] Status text: "ISweep is Paused"
- [ ] Icon/badge updates to disabled state

**Steps to Re-enable:**
1. Run: `chrome.storage.local.set({isweepEnabled: true})`
2. Reopen popup

**Expected Results:**
- [ ] Status dot changes to green
- [ ] Status text: "ISweep is Active"
- [ ] Icon/badge updates to enabled state

### Test 13: Content Script Loading

**Steps:**
1. Navigate to any website (e.g., `example.com`)
2. Open DevTools Console on that page
3. Look for ISweep console messages

**Expected Results:**
- [ ] Console shows "[ISweep Plumbing] Content script loaded on: example.com"
- [ ] If logged in and enabled, shows "[ISweep Plumbing] Starting content filtering..."
- [ ] Brief "ISweep Active" indicator may appear on page (dev mode)

### Test 14: Email Validation (Quick Login)

**Steps:**
1. Log out
2. Click "Log in with Email"
3. Try entering invalid email (e.g., "notanemail")
4. Click "Sign In"

**Expected Results:**
- [ ] Alert appears: "Please enter a valid email address"
- [ ] Login does not proceed

### Test 15: Cancel Quick Login

**Steps:**
1. In logged out state, click "Log in with Email"
2. Click "Cancel" in quick login form

**Expected Results:**
- [ ] Quick login form hides
- [ ] Email input is cleared
- [ ] Remains in logged out state

## Browser Console Commands (Debugging)

### View Current Storage State
```javascript
chrome.storage.local.get(null, (data) => console.log('Storage:', data));
```

### View Auth Data
```javascript
chrome.storage.local.get('isweepAuth', (data) => console.log('Auth:', data));
```

### View Enabled State
```javascript
chrome.storage.local.get('isweepEnabled', (data) => console.log('Enabled:', data));
```

### Clear All Data (Reset)
```javascript
chrome.storage.local.clear(() => console.log('Storage cleared'));
```

### Set Test Login
```javascript
chrome.storage.local.set({
  isweepAuth: {
    email: 'john.doe@example.com',
    displayName: 'John Doe',
    initials: 'JD',
    loggedInAt: new Date().toISOString()
  },
  isweepEnabled: true
}, () => console.log('Test login set'));
```

## Troubleshooting

### Issue: Popup doesn't open
- Check Chrome console for errors
- Verify manifest.json is valid
- Reload the extension: chrome://extensions/ → click reload icon

### Issue: Web pages don't open
- Verify local web server is running on port 5500
- Check URL in browser: http://127.0.0.1:5500/Settings.html
- Update WEB_BASE_URL in popup.js if using different port

### Issue: Icon doesn't change
- Check background service worker console
- Verify icon files exist in icons/ folder
- Icon may use badge text if PNG files fail to load

### Issue: State doesn't persist
- Check Chrome storage: chrome://storage-internals/
- Verify no errors in popup console
- Clear cache and reload extension

### Issue: Content script not loading
- Check page console for errors
- Verify manifest.json includes content_scripts section
- Some pages (chrome://, chrome-extension://) block content scripts

## Screenshots Checklist

Take screenshots of:
1. [ ] Logged out state (full popup)
2. [ ] Logged in state (full popup)
3. [ ] Logged in state with "ISweep is Paused" status
4. [ ] Settings page opened from popup
5. [ ] Account page opened from popup
6. [ ] Chrome extensions page showing ISweep installed

## Test Result Summary

**Date Tested:** _______________

**Chrome Version:** _______________

**Tester:** _______________

**Overall Result:** ⬜ Pass  ⬜ Fail  ⬜ Partial

**Notes:**
```
[Add any additional notes, bugs found, or suggestions here]
```

**Failed Tests (if any):**
- Test #___: _________________________
- Test #___: _________________________

**Follow-up Actions:**
- [ ] Fix critical bugs
- [ ] Update documentation
- [ ] Retest failed cases
- [ ] Deploy to production
