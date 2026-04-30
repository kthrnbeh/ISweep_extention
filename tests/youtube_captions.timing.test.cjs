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
    window: { innerWidth: 1280, innerHeight: 720 },
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
  assert.equal(normalized.cleanCaptionPosition.x, 0.4);
  assert.equal(normalized.cleanCaptionPosition.y, 0.7);

  const fallback = hooks.normalizeCleanCaptionSettings({
    cleanCaptionStyle: 'invalid',
    cleanCaptionTextSize: 'huge',
  });
  assert.equal(fallback.cleanCaptionsEnabled, true);
  assert.equal(fallback.cleanCaptionStyle, 'transparent_white');
  assert.equal(fallback.cleanCaptionTextSize, 'medium');
  assert.equal(fallback.cleanCaptionPosition.x, 0.5);
  assert.equal(fallback.cleanCaptionPosition.y, 0.8);
});

test('clean caption text masks blocked words', () => {
  const hooks = loadYoutubeTimingHooks();
  hooks.setCachedPreferences({
    enabled: true,
    blocklist: { enabled: true, items: ['shit'] },
    categories: { language: { enabled: true, items: ['shit'] } },
  });
  const cleaned = hooks.toCleanCaptionText('This is shit and [ __ ] now.');
  assert.equal(/shit/i.test(cleaned), false, 'blocked word should be masked');
  assert.equal(cleaned.includes('___'), true, 'placeholder should stay masked');
  assert.equal(cleaned.includes('This'), true, 'clean words should remain visible');
});

test('clean caption text follows precedence order: pre-analyzed, marker, audio, then live', () => {
  const hooks = loadYoutubeTimingHooks();
  hooks.setCachedPreferences({
    enabled: true,
    blocklist: { enabled: true, items: ['shit'] },
    categories: { language: { enabled: true, items: ['shit'] } },
  });
  const nowMs = Date.now();

  const audioCachedResult = hooks.getBestCleanCaptionText('live fallback', 10.2, {
    preCachedAudioCaptions: [
      { start_seconds: 10, end_seconds: 10.5, clean_text: 'audio cached line' },
    ],
    liveAudioCaptions: [
      { start_seconds: 10, end_seconds: 10.5, clean_text: 'audio live line' },
    ],
    preAnalyzedCaptions: [
      { start_seconds: 10, end_seconds: 10.5, clean_text: 'pre analyzed line' },
    ],
    markerEntries: [
      { start_seconds: 10, end_seconds: 10.5, cleaned_text: 'marker line' },
    ],
    liveCaptionObservedAtMs: nowMs,
    nowMs,
  });

  assert.equal(audioCachedResult.text, 'pre analyzed line');
  assert.equal(audioCachedResult.source, 'pre_analyzed');
  assert.equal(audioCachedResult.stale, false);

  const audioLiveResult = hooks.getBestCleanCaptionText('live fallback', 11.2, {
    preCachedAudioCaptions: [],
    liveAudioCaptions: [
      { start_seconds: 11, end_seconds: 11.5, clean_text: 'audio live line' },
    ],
    preAnalyzedCaptions: [],
    markerEntries: [
      { start_seconds: 11, end_seconds: 11.5, cleaned_text: 'marker line' },
    ],
    liveCaptionObservedAtMs: nowMs,
    nowMs,
  });

  assert.equal(audioLiveResult.text, 'marker line');
  assert.equal(audioLiveResult.source, 'marker_text');
  assert.equal(audioLiveResult.stale, false);

  const preAnalyzedResult = hooks.getBestCleanCaptionText('live fallback', 10.2, {
    preCachedAudioCaptions: [],
    liveAudioCaptions: [],
    preAnalyzedCaptions: [
      { start_seconds: 10, end_seconds: 10.5, clean_text: 'pre analyzed line' },
    ],
    markerEntries: [
      { start_seconds: 10, end_seconds: 10.5, cleaned_text: 'marker line' },
    ],
    liveCaptionObservedAtMs: nowMs,
    nowMs,
  });

  assert.equal(preAnalyzedResult.text, 'pre analyzed line');
  assert.equal(preAnalyzedResult.source, 'pre_analyzed');
  assert.equal(preAnalyzedResult.stale, false);
  assert.equal(preAnalyzedResult.cleanResumeTime, null);

  const markerResult = hooks.getBestCleanCaptionText('live fallback', 15.05, {
    preCachedAudioCaptions: [],
    liveAudioCaptions: [],
    preAnalyzedCaptions: [],
    markerEntries: [
      { start_seconds: 15, end_seconds: 15.4, caption_text: 'marker caption line' },
    ],
    liveCaptionObservedAtMs: nowMs,
    nowMs,
  });

  assert.equal(markerResult.text, 'marker caption line');
  assert.equal(markerResult.source, 'marker_text');
  assert.equal(markerResult.stale, false);
  assert.equal(markerResult.cleanResumeTime, null);

  const liveResult = hooks.getBestCleanCaptionText('that was shit', 20, {
    preCachedAudioCaptions: [],
    liveAudioCaptions: [],
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

test('mute window uses blocked word start and clean resume time', () => {
  const hooks = loadYoutubeTimingHooks();
  const window = hooks.getMuteWindowFromMarker({
    start_seconds: 5.0,
    end_seconds: 6.0,
    blocked_word_start: 5.25,
    clean_resume_time: 5.7,
  });

  assert.equal(window.start_seconds, 5.25);
  assert.equal(window.end_seconds, 5.7);
});

test('manual mute remains muted after restore logic', () => {
  const hooks = loadYoutubeTimingHooks();
  assert.equal(hooks.shouldISweepUnmute(true), false);
  assert.equal(hooks.shouldISweepUnmute(false), true);
});

test('live masked text is used when no pre-analyzed caption exists', () => {
  const hooks = loadYoutubeTimingHooks();
  hooks.setCachedPreferences({
    enabled: true,
    blocklist: { enabled: true, items: ['shit'] },
    categories: { language: { enabled: true, items: ['shit'] } },
  });
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

  assert.equal(result.text, '');
  assert.equal(result.source, 'live_masked');
  assert.equal(result.stale, true);
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

  assert.equal(result.text, 'marker caption line');
  assert.equal(result.source, 'marker_text');
  assert.equal(result.stale, false);
  assert.equal(result.cleanResumeTime, null);
});

test('overlay bridges small timing gaps', () => {
  const hooks = loadYoutubeTimingHooks();
  const nowMs = 1000;
  const resolved = hooks.resolveOverlayDisplayState(
    { text: '', source: null, stale: false },
    {
      text: 'previous caption',
      source: 'pre_analyzed',
      visible: true,
      updatedAtMs: nowMs - 120,
    },
    nowMs,
    hooks.constants.CLEAN_CC_BRIDGE_GAP_MS,
  );

  assert.equal(resolved.visible, true);
  assert.equal(resolved.bridged, true);
  assert.equal(resolved.text, 'previous caption');
  assert.equal(resolved.source, 'pre_analyzed');
});

test('overlay shows waiting placeholder when no caption text exists', () => {
  const hooks = loadYoutubeTimingHooks();
  const resolved = hooks.resolveOverlayDisplayState(
    { text: '', source: null, stale: false },
    { text: '', source: 'none', visible: false, updatedAtMs: 0 },
    1000,
    hooks.constants.CLEAN_CC_BRIDGE_GAP_MS,
    { cleanCaptionsEnabled: true, placeholderText: 'ISweep captions listening...' },
  );

  assert.equal(resolved.visible, true);
  assert.equal(resolved.source, 'waiting_audio_text');
  assert.equal(resolved.text, 'ISweep captions listening...');
  assert.equal(resolved.waiting, true);
});

test('overlay can be disabled without requiring caption text state', () => {
  const hooks = loadYoutubeTimingHooks();
  const resolved = hooks.resolveOverlayDisplayState(
    { text: '', source: null, stale: false },
    { text: '', source: 'none', visible: false, updatedAtMs: 0 },
    1000,
    hooks.constants.CLEAN_CC_BRIDGE_GAP_MS,
    { cleanCaptionsEnabled: false, placeholderText: 'ISweep captions listening...' },
  );

  assert.equal(resolved.visible, false);
  assert.equal(resolved.source, 'disabled');
  assert.equal(resolved.text, '');
});

test('stale captions still clear', () => {
  const hooks = loadYoutubeTimingHooks();
  const resolved = hooks.resolveOverlayDisplayState(
    { text: '', source: 'live_masked', stale: true },
    {
      text: 'old caption',
      source: 'pre_analyzed',
      visible: true,
      updatedAtMs: 1000,
    },
    1100,
    hooks.constants.CLEAN_CC_BRIDGE_GAP_MS,
  );

  assert.equal(resolved.visible, false);
  assert.equal(resolved.stale, true);
  assert.equal(resolved.text, '');
  assert.equal(resolved.source, 'stale');
});

test('pre-analyzed remains preferred over live-masked', () => {
  const hooks = loadYoutubeTimingHooks();
  const nowMs = Date.now();
  const result = hooks.getBestCleanCaptionText('this is shit', 42.1, {
    preAnalyzedCaptions: [
      { start_seconds: 42.0, end_seconds: 42.6, clean_text: 'clean from pre' },
    ],
    markerEntries: [],
    liveCaptionObservedAtMs: nowMs,
    nowMs,
  });

  assert.equal(result.source, 'pre_analyzed');
  assert.equal(result.text, 'clean from pre');
  assert.equal(result.stale, false);
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

  assert.equal(bounds.start_seconds, 10.4);
  assert.equal(bounds.end_seconds, 11.2);
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

test('audio caption fallback masks blocked words when clean_text is missing', () => {
  const hooks = loadYoutubeTimingHooks();
  hooks.setCachedPreferences({
    enabled: true,
    blocklist: { enabled: true, items: ['shit'] },
    categories: { language: { enabled: true, items: ['shit'] } },
  });
  const normalized = hooks.normalizePreAnalyzedCaptions([
    {
      start_seconds: 5,
      end_seconds: 6,
      text: 'You are shit',
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(/shit/i.test(normalized[0].clean_text), false);
  assert.equal(normalized[0].clean_text.includes('___'), true);
});

test('overlay state remains display-only metadata', () => {
  const hooks = loadYoutubeTimingHooks();
  const resolved = hooks.resolveOverlayDisplayState(
    { text: 'hello', source: 'audio_stt_live', stale: false },
    { text: '', source: 'none', visible: false, updatedAtMs: 0 },
    1000,
    hooks.constants.CLEAN_CC_BRIDGE_GAP_MS,
    { cleanCaptionsEnabled: true, placeholderText: 'ISweep captions listening...' },
  );

  assert.equal('action' in resolved, false);
  assert.equal('start_seconds' in resolved, false);
  assert.equal('end_seconds' in resolved, false);
  assert.equal(resolved.visible, true);
});

test('audio caption response with top-level clean_text becomes timed overlay entry', () => {
  const hooks = loadYoutubeTimingHooks();
  const entries = hooks.buildAudioResponseCaptions(
    {
      status: 'ready',
      source: 'audio_stt',
      start_seconds: 50.0,
      end_seconds: 50.8,
      text: 'You are a jerk',
      clean_text: 'You are a ___',
    },
    50.0,
    50.8,
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].clean_text, 'You are a ___');
  assert.equal(entries[0].start_seconds, 50.0);
  assert.equal(entries[0].end_seconds, 50.8);
});

test('audio caption response with only words builds masked timed overlay entry', () => {
  const hooks = loadYoutubeTimingHooks();
  hooks.setCachedPreferences({
    enabled: true,
    blocklist: { enabled: true, items: ['jerk'] },
    categories: { language: { enabled: true, items: ['jerk'] } },
  });

  const entries = hooks.buildAudioResponseCaptions(
    {
      status: 'ready',
      source: 'audio',
      cleaned_captions: [],
      clean_captions: [],
      words: [
        { word: 'You', start: 80.0, end: 80.1 },
        { word: 'are', start: 80.1, end: 80.2 },
        { word: 'a', start: 80.2, end: 80.25 },
        { word: 'jerk', start: 80.25, end: 80.45 },
      ],
    },
    80.0,
    80.6,
  );

  assert.equal(entries.length, 1);
  const best = hooks.getBestCleanCaptionText('', 80.3, {
    preCachedAudioCaptions: [],
    liveAudioCaptions: entries,
    preAnalyzedCaptions: [],
    markerEntries: [],
    liveCaptionObservedAtMs: Date.now(),
    nowMs: Date.now(),
  });

  assert.equal(best.source, 'audio_stt_live');
  assert.equal(/jerk/i.test(best.text), false);
  assert.equal(best.text.includes('____') || best.text.includes('___'), true);
});

test('overlay receives audio_stt text when backend returns cleaned_captions', () => {
  const hooks = loadYoutubeTimingHooks();
  const entries = hooks.buildAudioResponseCaptions(
    {
      status: 'ready',
      source: 'audio_stt',
      cleaned_captions: [
        {
          start_seconds: 70.0,
          end_seconds: 70.7,
          text: 'You are jerk',
          clean_text: 'You are ___',
        },
      ],
    },
    70.0,
    70.7,
  );

  const best = hooks.getBestCleanCaptionText('', 70.2, {
    preCachedAudioCaptions: [],
    liveAudioCaptions: entries,
    preAnalyzedCaptions: [],
    markerEntries: [],
    liveCaptionObservedAtMs: Date.now(),
    nowMs: Date.now(),
  });

  assert.equal(best.source, 'audio_stt_live');
  assert.equal(best.text, 'You are ___');
});

test('overlay receives audio_stt text when backend returns empty cleaned_captions but top-level cleaned_text', () => {
  const hooks = loadYoutubeTimingHooks();
  const entries = hooks.buildAudioResponseCaptions(
    {
      status: 'ready',
      source: 'audio',
      cleaned_captions: [],
      clean_captions: [],
      cleaned_text: 'What the ____ is going on',
      words: [{ word: 'What', start: 123.5, end: 123.6 }],
    },
    123.0,
    125.0,
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].cleaned_text, 'What the ____ is going on');
  assert.equal(entries[0].start_seconds, 123.0);
  assert.equal(entries[0].end_seconds, 125.0);

  const best = hooks.getBestCleanCaptionText('', 123.5, {
    preCachedAudioCaptions: [],
    liveAudioCaptions: entries,
    preAnalyzedCaptions: [],
    markerEntries: [],
    liveCaptionObservedAtMs: Date.now(),
    nowMs: Date.now(),
  });

  assert.equal(best.source, 'audio_stt_live');
  assert.equal(best.text, 'What the ____ is going on');
});

test('audio_stt caption replaces waiting placeholder', () => {
  const hooks = loadYoutubeTimingHooks();
  const waiting = hooks.resolveOverlayDisplayState(
    { text: '', source: null, stale: false },
    { text: '', source: 'none', visible: false, updatedAtMs: 0 },
    1000,
    hooks.constants.CLEAN_CC_BRIDGE_GAP_MS,
    { cleanCaptionsEnabled: true, placeholderText: 'ISweep captions listening...' },
  );
  assert.equal(waiting.source, 'waiting_audio_text');
  assert.equal(waiting.visible, true);
  assert.equal(waiting.text, 'ISweep captions listening...');

  const spoken = hooks.resolveOverlayDisplayState(
    { text: 'hello there', source: 'audio_stt_live', stale: false },
    { text: waiting.text, source: waiting.source, visible: waiting.visible, updatedAtMs: 1000 },
    1010,
    hooks.constants.CLEAN_CC_BRIDGE_GAP_MS,
    { cleanCaptionsEnabled: true, placeholderText: 'ISweep captions listening...' },
  );
  assert.equal(spoken.visible, true);
  assert.equal(spoken.text, 'hello there');
  assert.equal(spoken.source, 'audio_stt_live');
});

test('masking follows stored preferences as source of truth', () => {
  const hooks = loadYoutubeTimingHooks();
  hooks.setCachedPreferences({
    enabled: true,
    blocklist: { enabled: true, items: ['jerk'] },
    categories: { language: { enabled: true, items: ['jerk'] } },
  });
  const masked = hooks.toCleanCaptionText('You are a jerk');
  assert.equal(masked.includes('jerk'), false);
  assert.equal(masked.includes('___') || masked.includes('____'), true);

  hooks.setCachedPreferences({
    enabled: true,
    blocklist: { enabled: true, items: ['different'] },
    categories: { language: { enabled: true, items: ['different'] } },
  });
  const unmasked = hooks.toCleanCaptionText('You are a jerk');
  assert.equal(unmasked.includes('jerk'), true);
});

test('overlay drag save helper returns normalized position', () => {
  const hooks = loadYoutubeTimingHooks();
  const pos = hooks.getNormalizedCaptionPosition(320, 360, 200, 60);
  assert.ok(pos.x > 0 && pos.x < 1);
  assert.ok(pos.y > 0 && pos.y < 1);
});

test('audio capture path does not use microphone getUserMedia', () => {
  const filePath = path.resolve(__dirname, '..', 'youtube_captions.js');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.equal(/getUserMedia\s*\(\s*\{\s*audio\s*:\s*true/i.test(source), false);
});

test('audio marker overlap dedupe detects near-identical overlap windows', () => {
  const hooks = loadYoutubeTimingHooks();
  const existing = {
    action: 'mute',
    start_seconds: 10.0,
    end_seconds: 10.5,
  };
  const incoming = {
    action: 'mute',
    start_seconds: 10.05,
    end_seconds: 10.55,
  };

  assert.equal(hooks.shouldDedupAudioMarker(existing, incoming), true);
});

test('audio marker source priority ranks audio before transcript and caption fallback', () => {
  const hooks = loadYoutubeTimingHooks();
  assert.equal(hooks.markerSourcePriority('audio'), 0);
  assert.equal(hooks.markerSourcePriority('audio_stt'), 0);
  assert.equal(hooks.markerSourcePriority('transcript'), 1);
  assert.equal(hooks.markerSourcePriority('live_masked'), 2);
});
