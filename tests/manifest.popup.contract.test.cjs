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
