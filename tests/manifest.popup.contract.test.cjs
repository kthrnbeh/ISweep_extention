const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.join(__dirname, '..');

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(extensionRoot, fileName), 'utf8'));
}

test('manifest does not include invalid offscreen_documents key', () => {
  const manifest = readJson('manifest.json');
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'offscreen_documents'), false);
});

test('manifest does not request microphone permission', () => {
  const manifest = readJson('manifest.json');
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  assert.equal(permissions.includes('microphone'), false);
});

test('popup CC toggle sends exact audio caption start/stop messages', () => {
  const popupSource = fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');
  assert.equal(popupSource.includes('isweep_start_audio_captions'), true);
  assert.equal(popupSource.includes('isweep_stop_audio_captions'), true);
  assert.equal(popupSource.includes('isweep_start_tab_audio_captions'), false);
  assert.equal(popupSource.includes('isweep_stop_tab_audio_captions'), false);
});

test('popup supports local dev account shortcut and tokenless sync messaging', () => {
  const popupHtml = fs.readFileSync(path.join(extensionRoot, 'popup.html'), 'utf8');
  const popupSource = fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');

  assert.equal(popupHtml.includes('btnCreateLocalDevAccount'), true);
  assert.equal(popupSource.includes('async function handleCreateLocalDevAccount'), true);
  assert.equal(popupSource.includes('/auth/register'), true);
  assert.equal(popupSource.includes('[TOKEN_KEY]'), true);
  assert.equal(popupSource.includes('Captions active. Sign in to sync preferences.'), true);
  assert.equal(popupSource.includes('setSyncPrefsAvailability(false)'), true);
  assert.equal(popupSource.includes('invalid credentials for this backend'), true);
  assert.equal(popupSource.includes('isweep_start_audio_captions'), true);
});

test('popup account links use preferred frontend base URL helper', () => {
  const popupSource = fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');
  assert.equal(popupSource.includes('async function getPreferredFrontendBaseUrl'), true);
  assert.equal(popupSource.includes('DEFAULT_LOCAL_FRONTEND_BASE'), true);
  assert.equal(popupSource.includes('getPreferredFrontendBaseUrl()'), true);
  assert.equal(popupSource.includes('Account.html#create'), true);
});

test('offscreen.js routes captured tab audio back to speakers', () => {
  const offscreenSource = fs.readFileSync(path.join(extensionRoot, 'offscreen.js'), 'utf8');
  // Verify audio routing: source → monitorGain → destination (for speakers)
  assert.equal(offscreenSource.includes('const monitorGain = audioCtx.createGain()'), true);
  assert.equal(offscreenSource.includes('monitorGain.gain.value = 1.0'), true);
  assert.equal(offscreenSource.includes('source.connect(monitorGain)'), true);
  assert.equal(offscreenSource.includes('monitorGain.connect(audioCtx.destination)'), true);
  // Verify no microphone getUserMedia
  assert.equal(offscreenSource.includes("chromeMediaSource: 'tab'"), true);
});

test('background.js uses filter decision gating to prevent false mutes', () => {
  const bgSource = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
  // Verify shouldApplyFilterDecision helper exists
  assert.equal(bgSource.includes('function shouldApplyFilterDecision'), true);
  // Verify it's used in handleAudioAhead
  assert.equal(bgSource.includes('shouldApplyFilterDecision(decision,'), true);
});

test('background captions can bootstrap local dev token when user token is missing', () => {
  const bgSource = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
  assert.equal(bgSource.includes('async function ensureLocalDevCaptionToken'), true);
  assert.equal(bgSource.includes('LOCAL_DEV_CAPTION_EMAIL'), true);
  assert.equal(bgSource.includes('token = await ensureLocalDevCaptionToken(backendUrl);'), true);
  assert.equal(bgSource.includes('posting /captions/transcribe (caption-only)'), true);
});

test('background login success persists token for sync preferences', () => {
  const bgSource = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
  assert.equal(bgSource.includes("[TOKEN_KEY]: token"), true);
  assert.equal(bgSource.includes("[STORAGE_KEYS.USER_ID]: userId"), true);
  assert.equal(bgSource.includes('login success'), true);
});
