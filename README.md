# ISweep Chrome Extension (dev)

Wires the browser to the ISweep backend: signs in, syncs preferences, and applies decisions (mute/skip/fast_forward) while you watch YouTube captions.

## How to run locally
1) Open Chrome → `chrome://extensions` → toggle **Developer mode**.
2) Click **Load unpacked** and select the `ISweep_extention/` folder.
3) Open the extension **Options** page:
   - Set Backend URL (default `http://127.0.0.1:5000`).
   - Use **Test Connection** to verify `/health`.
4) Click the toolbar icon → **Log in with Email**:
   - Enter the same email/password created via the frontend/backend.
   - On success we store `isweepToken` + `isweepUserId` in `chrome.storage.local`.
5) (Optional) Open Settings or Account links to the site at `http://127.0.0.1:5500/docs/`.

## YouTube testing flow
- Open any YouTube video with captions on (`*://*.youtube.com/watch*`).
- The content script `youtube_captions.js` watches caption text and sends it to the background.
- Background posts to `/event` with Bearer token and returns a decision.
- Actions applied to the `<video>` element:
  - `mute`: mute temporarily, then restore.
  - `skip`: `currentTime += duration_seconds`.
  - `fast_forward`: set `playbackRate = 2x`, then restore.
- Watch DevTools console for `[ISWEEP]` logs (content + background).

## Storage keys (chrome.storage.local)
- `isweep_auth_token`, `isweepUserId`: canonical auth session for backend calls.
- Legacy site keys (`isweep-token`, `auth-state`) are migrated by the site bridge when available.
- `isweepBackendUrl`: configured backend base URL.
- `isweepPreferences`: last downloaded preferences (fallback).
- `isweepEnabled`: toggle for icon state.

## Canonical preferences

The selected words used by the Filter page, backend, popup, and caption listener
are stored in `blocklist.items`. Category data remains available for display and
future actions, but the normalized selected-word list is the blocklist list:

```json
{
  "categories": {
    "language": { "items": [] },
    "intimacy": { "items": [] },
    "violence": { "items": [] },
    "substances": { "items": [] },
    "horror": { "items": [] }
  },
  "blocklist": { "items": [] }
}
```

The extension reports the selected-word count, preview, preference source, and
sync failure reason in its caption runtime status. A missing word list is not
treated as a verified successful non-empty sync.

## Permissions
- `storage`, `activeTab`, `tabs`, `scripting` + host permissions for backend URLs and YouTube captions.

### Why these permissions exist
- `storage`: keep user/session prefs and auth tokens locally so filtering stays consistent.
- `tabs`: inspect tab metadata to target the correct YouTube watch tab when applying playback controls.
- `activeTab`: limit interaction to the user’s current tab when sending actions.
- `scripting`: inject the caption listener into YouTube pages to observe captions and relay them to the backend.
- Host permissions (`localhost`, `127.0.0.1`, and `<all_urls>` for existing scripts): allow talking to the dev backend and loading content scripts on YouTube during development.

> Note: Chrome extensions do not allow comments or fake `_comment_*` keys inside `manifest.json`. Keep explanations here in the README instead.

### Playback-only guarantee
- ISweep only adjusts live playback state (mute/unmute/skip/fast-forward) based on captions and backend decisions.
- It never edits, rewrites, or saves media, video files, or caption files.

## Audio STT smoke logs (captions optional)
For audio-first watch-ahead verification (including captions off), expect these logs during playback.

Page console:
- `[ISWEEP][AUDIO_CAPTURE] started`
- `[ISWEEP][AUDIO_CAPTURE] captions_required=false`
- `[ISWEEP][AUDIO_CAPTURE] chunk ready`
- `[ISWEEP][AUDIO_CAPTURE] chunk sent`
- `[ISWEEP][WORD_MUTE] marker scheduled`
- `[ISWEEP][WORD_MUTE] applied`
- `[ISWEEP][WORD_MUTE] clean resume`

Backend terminal:
- `[ISWEEP][AUDIO_STT] chunk received`
- `[ISWEEP][AUDIO_STT] whisper started`
- `[ISWEEP][AUDIO_STT] word timestamps generated`
- `[ISWEEP][AUDIO_STT] cached saved`
- `[ISWEEP][AUDIO_STT] cached hit`

## Notes
- Tokens are stored locally for dev; clear via popup logout.
- If backend is unreachable, decisions default to `none` and logs include the reason.
