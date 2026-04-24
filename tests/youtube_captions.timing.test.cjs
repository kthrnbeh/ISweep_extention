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

test('clean caption settings normalization applies defaults safely', () => {
  const hooks = loadYoutubeTimingHooks();
  const normalized = hooks.normalizeCleanCaptionSettings({
    cleanCaptionsEnabled: false,
    cleanCaptionStyle: 'white_black',
    cleanCaptionTextSize: 'large',
    cleanCaptionPosition: { x: 0.4, y: 0.7 },
  });

  assert.equal(normalized.cleanCaptionsEnabled, false);
  assert.equal(normalized.cleanCaptionStyle, 'white_black');
  assert.equal(normalized.cleanCaptionTextSize, 'large');
  assert.deepEqual(normalized.cleanCaptionPosition, { x: 0.4, y: 0.7 });

  const fallback = hooks.normalizeCleanCaptionSettings({
    cleanCaptionStyle: 'invalid',
    cleanCaptionTextSize: 'huge',
  });
  assert.equal(fallback.cleanCaptionsEnabled, true);
  assert.equal(fallback.cleanCaptionStyle, 'transparent_white');
  assert.equal(fallback.cleanCaptionTextSize, 'medium');
  assert.deepEqual(fallback.cleanCaptionPosition, { x: 0.5, y: 0.8 });
});

test('clean caption text masks blocked words', () => {
  const hooks = loadYoutubeTimingHooks();
  const cleaned = hooks.toCleanCaptionText('This is shit and [ __ ] now.');
  assert.equal(/shit/i.test(cleaned), false, 'blocked word should be masked');
  assert.equal(cleaned.includes('___'), true, 'placeholder should stay masked');
  assert.equal(cleaned.includes('This'), true, 'clean words should remain visible');
});

test('clean caption text follows precedence order: pre-analyzed, then marker, then live', () => {
  const hooks = loadYoutubeTimingHooks();
  const nowMs = Date.now();

  const preAnalyzedResult = hooks.getBestCleanCaptionText('live fallback', 10.2, {
    preAnalyzedCaptions: [
      { start_seconds: 10, end_seconds: 10.5, clean_text: 'pre analyzed line' },
    ],
    markerEntries: [
      { start_seconds: 10, end_seconds: 10.5, cleaned_text: 'marker line' },
    ],
    liveCaptionObservedAtMs: nowMs,
    nowMs,
  });

  assert.deepEqual(preAnalyzedResult, {
    text: 'pre analyzed line',
    source: 'pre_analyzed',
    stale: false,
  });

  const markerResult = hooks.getBestCleanCaptionText('live fallback', 15.05, {
    preAnalyzedCaptions: [],
    markerEntries: [
      { start_seconds: 15, end_seconds: 15.4, caption_text: 'marker caption line' },
    ],
    liveCaptionObservedAtMs: nowMs,
    nowMs,
  });

  assert.deepEqual(markerResult, {
    text: 'marker caption line',
    source: 'marker_text',
    stale: false,
  });

  const liveResult = hooks.getBestCleanCaptionText('that was shit', 20, {
    preAnalyzedCaptions: [],
    markerEntries: [],
    liveCaptionObservedAtMs: nowMs,
    nowMs,
  });

  assert.equal(liveResult.source, 'live_masked');
  assert.equal(liveResult.stale, false);
  assert.equal(/shit/i.test(liveResult.text), false);
  assert.equal(liveResult.text.includes('____'), true);
});

test('live masked text is used when no pre-analyzed caption exists', () => {
  const hooks = loadYoutubeTimingHooks();
  const result = hooks.getBestCleanCaptionText('that was shit', 20, {
    preAnalyzedCaptions: [],
    markerEntries: [],
    liveCaptionObservedAtMs: Date.now(),
    nowMs: Date.now(),
  });

  assert.equal(result.source, 'live_masked');
  assert.equal(result.stale, false);
  assert.equal(/shit/i.test(result.text), false);
  assert.equal(result.text.includes('____'), true);
});

test('stale live caption text is not displayed', () => {
  const hooks = loadYoutubeTimingHooks();
  const nowMs = 5000;
  const result = hooks.getBestCleanCaptionText('still here', 30, {
    preAnalyzedCaptions: [],
    markerEntries: [],
    liveCaptionObservedAtMs: nowMs - hooks.constants.CLEAN_CAPTION_STALE_MS - 10,
    nowMs,
  });

  assert.deepEqual(result, {
    text: '',
    source: 'live_masked',
    stale: true,
  });
});

test('marker text is used when timed metadata matches and no pre-analyzed caption exists', () => {
  const hooks = loadYoutubeTimingHooks();
  const result = hooks.getBestCleanCaptionText('fallback live', 15.05, {
    preAnalyzedCaptions: [],
    markerEntries: [
      { start_seconds: 15, end_seconds: 15.4, caption_text: 'marker caption line' },
    ],
    liveCaptionObservedAtMs: Date.now(),
    nowMs: Date.now(),
  });

  assert.deepEqual(result, {
    text: 'marker caption line',
    source: 'marker_text',
    stale: false,
  });
});

test('timed entry bounds prefer word timings over segment bounds', () => {
  const hooks = loadYoutubeTimingHooks();
  const bounds = hooks.getEntryTimingBounds({
    start_seconds: 10.0,
    end_seconds: 14.0,
    words: [
      { word: 'What', start: 10.4, end: 10.8 },
      { word: 'heck', start: 10.8, end: 11.2 },
    ],
  });

  assert.deepEqual(bounds, {
    start_seconds: 10.4,
    end_seconds: 11.2,
  });
});

test('best clean caption selection matches using word-timing lookahead', () => {
  const hooks = loadYoutubeTimingHooks();
  const result = hooks.getBestCleanCaptionText('live fallback', 12.86, {
    preAnalyzedCaptions: [
      {
        start_seconds: 12.0,
        end_seconds: 14.0,
        clean_text: 'word aligned',
        words: [
          { word: 'badword', start: 12.4, end: 12.8 },
          { word: 'clean', start: 12.9, end: 13.2 },
        ],
        clean_resume_time: 12.9,
      },
    ],
    markerEntries: [],
    liveCaptionObservedAtMs: Date.now(),
    nowMs: Date.now(),
  });

  assert.equal(result.source, 'pre_analyzed');
  assert.equal(result.text, 'word aligned');
  assert.equal(result.cleanResumeTime, 12.9);
});
