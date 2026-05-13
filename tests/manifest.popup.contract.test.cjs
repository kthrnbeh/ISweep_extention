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
