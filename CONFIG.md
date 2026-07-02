# Extension Configuration

## Frontend URL Configuration

The ISweep Chrome Extension requires a connection to the ISweep frontend web application. You must configure the frontend URL before using the extension.

### Configuration Steps

1. Open `popup.js` in this directory
2. Locate the `WEB_BASE_URL` constant (near the top of the file)
3. Update it to match your frontend deployment:

```javascript
// Development Example (local dev server)
const WEB_BASE_URL = 'http://127.0.0.1:5500/docs';

// Production Example (deployed frontend)
const WEB_BASE_URL = 'https://isweep.example.com';
```

### Required Frontend Pages

The extension expects these pages to be available at your frontend URL:

- **Settings.html** - Main settings page with filter configuration
  - Used by: "Open Settings" button
  - Also accessible with anchors: `#filters` for reset filters link

- **Account.html** - User account and authentication page
  - Used by: "Log in with Email" button, "Manage Account" link
  - Also accessible with anchors: `#create` for account creation

### Important Notes

- The `WEB_BASE_URL` includes `/docs` in the path (e.g., `http://127.0.0.1:5500/docs`)
- The extension appends page paths to this base URL (e.g., `/Settings.html`)
- Final URLs will be like: `http://127.0.0.1:5500/docs/Settings.html`
- The frontend repository should have the HTML pages in a `docs` folder or be configured to serve from that path
- Ensure CORS is properly configured on your frontend if using a different domain
- For local development, make sure your frontend dev server is running before testing the extension

### Testing Your Configuration

1. Load the extension in Chrome (`chrome://extensions/`)
2. Click the ISweep icon in the toolbar
3. Click "Log in with Email" - it should open your frontend Account page
4. After logging in (use quick login for dev), click "Open Settings" - it should open your frontend Settings page
5. If pages don't open correctly, verify your `WEB_BASE_URL` is correct and the frontend is running

## Optional Full-Word Protection Plan (Design)

This section documents a future optional local delay-buffer design. It is not active by default.

### Goals

- Keep playback natural: no `playbackRate` changes, no skip, no fast-forward, no video edits.
- Analyze captured tab audio before delayed speaker output reaches the user.
- Preserve user-muted state exactly as today.

### Proposed Pipeline

1. Capture active-tab audio frames (never microphone).
2. Write frames into a local ring buffer (target output delay: 800-1200 ms).
3. Run Fast Guard + VAD on incoming frames immediately.
4. If Fast Guard sees possible selected-word onset with audio evidence, request early mute window.
5. Release delayed audio to speakers only after the delay horizon.
6. End mute windows using VAD speech-end and stable STT boundaries.

### Safety Constraints

- Audio-STT timestamps remain the only mute trigger source.
- Page text/transcript/script/lyrics/search evidence can improve display text only.
- Evidence cannot create selected words or mute windows.
- User-initiated mute always wins.

### Integration Notes

- Keep this feature behind an explicit feature flag.
- Reuse existing mute ownership (`isweep` vs user) logic.
- Reuse current stale-drop timeline logic to avoid post-speech ghost captions.
