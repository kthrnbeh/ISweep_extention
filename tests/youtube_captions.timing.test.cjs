const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadYoutubeTimingHooks() {
  const filePath = path.resolve(__dirname, '..', 'youtube_captions.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const context = {
    console: { log() {}, warn() {}, error() {} },
    globalThis: {},
    __ISWEEP_TEST_MODE__: true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'youtube_captions.js' });
  return context.__ISWEEP_YT_TEST_HOOKS__;
}

test('placeholder timing estimates hidden word position, not line start', () => {
  const hooks = loadYoutubeTimingHooks();
  const result = hooks.estimatePlaceholderWordWindow(
    'just know that a perfect circle is a croc of [ __ ] man.',
    100,
    1.6,
    101,
    'backend'
  );

  assert.ok(result, 'expected placeholder window result');
  assert.equal(result.wordsBeforePlaceholder, 10);
  assert.equal(result.totalWords, 12);
  assert.ok(result.estimatedPlaceholderStartSec > result.captionStartSec, 'placeholder should be after caption start');
  assert.ok(result.adjustedStart < result.estimatedPlaceholderStartSec, 'preroll should move mute before placeholder word');
  assert.ok(result.adjustedStart > result.captionStartSec + 0.2, 'mute should not be anchored at caption start');
});

test('fallback detects nearby audio markers and skips redundant placeholder mute', () => {
  const hooks = loadYoutubeTimingHooks();
  const estimated = hooks.estimatePlaceholderWordWindow(
    'just know that a perfect circle is a croc of [ __ ] man.',
    100,
    1.6,
    101,
    'backend'
  );

  const hasNearby = hooks.hasNearbyAudioMuteMarker(
    [
      {
        id: 'audio-1',
        action: 'mute',
        source: 'audio_chunk',
        start_seconds: estimated.estimatedPlaceholderStartSec - 0.05,
        end_seconds: estimated.estimatedPlaceholderStartSec + 0.25,
      },
    ],
    estimated.adjustedStart,
    estimated.muteEndSec,
    estimated.estimatedPlaceholderStartSec
  );

  assert.equal(hasNearby, true);
});

test('marker early-fire timing applies only to mute markers and fires once', () => {
  const hooks = loadYoutubeTimingHooks();

  const muteMarker = { id: 'm1', action: 'mute', start_seconds: 50 };
  const skipMarker = { id: 's1', action: 'skip', start_seconds: 50 };

  assert.equal(hooks.getMarkerEarlyWindowSec('mute') > 0, true);
  assert.equal(hooks.getMarkerEarlyWindowSec('skip'), 0);

  assert.equal(hooks.shouldFireMarker(muteMarker, 49.9, new Set()), true, 'mute should fire in early window');
  assert.equal(hooks.shouldFireMarker(skipMarker, 49.9, new Set()), false, 'skip should not early-fire');
  assert.equal(hooks.shouldFireMarker(skipMarker, 50.0, new Set()), true, 'skip fires on-time');

  const fired = new Set(['m1']);
  assert.equal(hooks.shouldFireMarker(muteMarker, 50.2, fired), false, 'marker should fire only once');
});
