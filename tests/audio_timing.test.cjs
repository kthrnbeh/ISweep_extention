const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadOffscreenTimingHooks() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'offscreen.js'),
    'utf8',
  );
  const context = {
    console: { log() {}, warn() {}, error() {} },
    globalThis: {},
    __ISWEEP_TEST_MODE__: true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    btoa: () => '',
    chrome: {
      runtime: {
        id: 'test-extension',
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener() {} },
      },
      tabs: { sendMessage: async () => ({ ok: true }) },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'offscreen.js' });
  return context.__ISWEEP_OFFSCREEN_TEST_HOOKS__;
}

test('audio source window maps chunk offsets onto the current video timeline', () => {
  const hooks = loadOffscreenTimingHooks();
  const window = hooks.resolveSourceTimelineWindow(60, 3, 63, false);

  assert.equal(window.discard, false);
  assert.equal(window.start_seconds, 60);
  assert.equal(window.end_seconds, 63);
});

test('audio source window rebases after a seek instead of applying a blind offset', () => {
  const hooks = loadOffscreenTimingHooks();
  const window = hooks.resolveSourceTimelineWindow(0, 3, 63, false);

  assert.equal(window.discard, true);
  assert.equal(window.reason, 'video_clock_discontinuity');
  assert.equal(window.start_seconds, 63);
});

test('audio source window is discarded while playback is paused', () => {
  const hooks = loadOffscreenTimingHooks();
  const window = hooks.resolveSourceTimelineWindow(60, 3, 61, true);

  assert.equal(window.discard, true);
  assert.equal(window.reason, 'video_paused');
  assert.equal(window.start_seconds, 61);
});
