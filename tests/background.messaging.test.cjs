const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBackgroundContext() {
  const filePath = path.resolve(__dirname, '..', 'background.js');
  const source = fs.readFileSync(filePath, 'utf8');

  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} },
      sendMessage: async () => ({}),
      getURL: (p) => `chrome-extension://unit-test/${p}`,
      getContexts: async () => ([]),
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => ({}),
    },
    tabCapture: {
      getMediaStreamId: async () => 'stream-id-1',
    },
    offscreen: {
      createDocument: async () => ({}),
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: async () => ({}),
        set: async () => ({}),
        remove: async () => ({}),
      },
    },
    action: {
      setIcon: async () => ({}),
      setBadgeText: async () => ({}),
      setBadgeBackgroundColor: async () => ({}),
      setTitle: async () => ({}),
    },
  };

  const context = {
    console: { log() {}, warn() {}, error() {} },
    chrome,
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    setTimeout,
    clearTimeout,
    globalThis: {},
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'background.js' });
  return context;
}

test('caption runtime status prefers YouTube fallback when active tab reports live masked captions', async () => {
  const bg = loadBackgroundContext();
  bg.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', stt_enabled: true }) });
  bg.chrome.tabs.query = async () => ([{ id: 7 }]);
  bg.chrome.tabs.sendMessage = async () => ({ usingYoutubeFallback: true, usingAudioStt: false });

  const result = await bg.handleCaptionRuntimeStatus();
  assert.equal(result.state, 'youtube_fallback');
  assert.equal(result.label, 'Captions: YouTube fallback');
});

test('caption runtime status reports backend offline when health probe fails', async () => {
  const bg = loadBackgroundContext();
  bg.fetch = async () => { throw new Error('Failed to fetch'); };
  bg.chrome.tabs.query = async () => ([]);

  const result = await bg.handleCaptionRuntimeStatus();
  assert.equal(result.state, 'backend_offline');
  assert.equal(result.label, 'Audio captions: Backend offline');
});

test('missing token handling for /event returns structured none decision', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => null;
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  const result = await bg.handleCaptionDecision('test text', 0.4);
  assert.equal(result.action, 'none');
  assert.equal(result.reason, 'missing token');
  assert.equal(result.duration_seconds, 0);
  assert.equal(result.matched_category, null);
});

test('missing token in dev local auth mode falls back to cached local preferences', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => null;
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';
  bg.getDevLocalAuthContext = async () => ({
    enabled: true,
    backendUrl: 'http://127.0.0.1:5000',
    prefs: {
      enabled: true,
      categories: {
        language: { enabled: true, action: 'mute', duration: 4 },
      },
      blocklist: {
        enabled: true,
        action: 'mute',
        duration: 6,
        items: ['jerk'],
      },
    },
  });

  const result = await bg.handleCaptionDecision('you are a jerk', 0.5);
  assert.equal(result.action, 'mute');
  assert.equal(result.matched_category, 'blocklist');
  assert.equal(result.duration_seconds, 6);
  assert.equal(/local prefs blocklist match/i.test(result.reason), true);
});

test('missing token handling for /audio/analyze returns unavailable + missing_token', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => null;
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 10, 11);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.failure_reason, 'missing_token');
  assert.equal(Array.isArray(result.events), true);
  assert.equal(result.events.length, 0);
});

test('audio result normalization handles unauthorized and network-unavailable distinctly', async () => {
  const unauthorized = loadBackgroundContext();
  unauthorized.getAuthToken = async () => 'token';
  unauthorized.getBackendUrl = async () => 'http://127.0.0.1:5000';
  unauthorized.fetch = async () => ({ ok: false, status: 401, text: async () => '' });

  const unauthorizedResult = await unauthorized.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 10, 11);
  assert.equal(unauthorizedResult.status, 'error');
  assert.equal(unauthorizedResult.failure_reason, 'unauthorized');

  const unavailable = loadBackgroundContext();
  unavailable.getAuthToken = async () => 'token';
  unavailable.getBackendUrl = async () => 'http://127.0.0.1:5000';
  unavailable.fetch = async () => {
    throw new Error('Failed to fetch');
  };

  const unavailableResult = await unavailable.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 10, 11);
  assert.equal(unavailableResult.status, 'error');
  assert.equal(unavailableResult.failure_reason, 'backend_not_running');
});

test('audio non-ok response preserves backend failure reason and body snippet', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';
  bg.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({
      status: 'error',
      failure_reason: 'audio_decode_failed',
      error: 'decoder failed',
    }),
  });

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 10, 11);
  assert.equal(result.status, 'error');
  assert.equal(result.failure_reason, 'audio_decode_failed');
  assert.equal(result.backend_status, 500);
  assert.equal(typeof result.backend_body, 'string');
  assert.equal(result.backend_body.includes('audio_decode_failed'), true);
});

test('audio chunk result shape normalization preserves status/failure_reason from backend payload', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';
  bg.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'unavailable',
      source: 'audio_chunk',
      events: [],
      failure_reason: 'transcription_unavailable',
    }),
  });

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 10, 11);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.source, 'audio_chunk');
  assert.equal(Array.isArray(result.events), true);
  assert.equal(result.events.length, 0);
  assert.equal(result.failure_reason, 'transcription_unavailable');
  assert.equal(result.start_seconds, 10);
  assert.equal(result.end_seconds, 11);
});

test('audio result forwards chunk aliases and preserves cleaned captions/cache flag', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  let requestBody = null;
  bg.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status: 'ready',
        source: 'audio_stt',
        events: [{ id: 'm1', action: 'mute', start_seconds: 10.2, end_seconds: 10.5 }],
        cleaned_captions: [{ start_seconds: 10, end_seconds: 11, clean_text: 'hello ___' }],
        failure_reason: null,
        cached: true,
      }),
    };
  };

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 10, 11, [0.1, -0.1], 16000, 1);
  assert.equal(requestBody.chunk_start_seconds, 10);
  assert.equal(requestBody.chunk_end_seconds, 11);
  assert.equal(requestBody.start_seconds, 10);
  assert.equal(requestBody.end_seconds, 11);
  assert.equal(Array.isArray(requestBody.audio), true);
  assert.equal(requestBody.audio.length, 2);
  assert.equal(requestBody.sampleRate, 16000);
  assert.equal(requestBody.channels, 1);

  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'audio_stt');
  assert.equal(result.cached, true);
  assert.equal(Array.isArray(result.cleaned_captions), true);
  assert.equal(result.cleaned_captions.length, 1);
});

test('caption decision suppresses near-simultaneous duplicate text across youtube and audio sources', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';
  bg.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ action: 'mute', reason: 'matched', duration_seconds: 4, matched_category: 'language' }),
  });

  const first = await bg.handleCaptionDecision('same phrase', 0.8, { source: 'youtube_dom' });
  assert.equal(first.action, 'mute');

  const second = await bg.handleCaptionDecision('same phrase', 0.8, { source: 'audio_stt' });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'duplicate caption suppressed');
});

test('audio result accepts clean_captions alias from backend payload', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';
  bg.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'ready',
      source: 'audio_stt',
      events: [],
      clean_captions: [{ start_seconds: 1.0, end_seconds: 1.5, clean_text: 'safe text' }],
      failure_reason: null,
      cached: false,
    }),
  });

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 1, 2);
  assert.equal(result.status, 'ready');
  assert.equal(Array.isArray(result.cleaned_captions), true);
  assert.equal(result.cleaned_captions.length, 1);
});

test('audio result preserves top-level text fields for single-entry overlay fallback', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';
  bg.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'ready',
      source: 'audio_stt',
      events: [],
      text: 'You are a jerk',
      clean_text: 'You are a ___',
      failure_reason: null,
      cached: false,
    }),
  });

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 1, 2);
  assert.equal(result.status, 'ready');
  assert.equal(result.text, 'You are a jerk');
  assert.equal(result.clean_text, 'You are a ___');
});

test('audio_stt results without markers do not synthesize coarse full-chunk mute events', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';
  bg.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'ready',
      source: 'audio_stt',
      events: [],
      text: 'bad word here',
      clean_text: '___ word here',
      failure_reason: null,
      cached: false,
    }),
  });

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 1, 2);
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'audio_stt');
  assert.equal(Array.isArray(result.events), true);
  assert.equal(result.events.length, 0);
});

test('start tab audio captions requests tab capture and marks ready without checking YouTube CC state', async () => {
  const bg = loadBackgroundContext();
  const sent = [];
  bg.chrome.tabs.query = async () => ([{ id: 11, url: 'https://www.youtube.com/watch?v=abc123' }]);
  bg.chrome.tabs.sendMessage = async (tabId, payload) => {
    sent.push({ tabId, payload });
    return { ok: true };
  };
  bg.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === 'isweep_offscreen_start_tab_capture') {
      return { ok: true };
    }
    return { ok: true };
  };

  const result = await bg.handleStartTabAudioCaptions();
  assert.equal(result.ok, true);
  assert.equal(result.source, 'tab_capture');
  assert.equal(sent.some((entry) => entry.payload.type === 'isweep_tab_audio_capture_status' && entry.payload.state === 'ready'), true);
});

test('stop tab audio captions notifies tab and stops capture', async () => {
  const bg = loadBackgroundContext();
  const sent = [];
  bg.chrome.tabs.query = async () => ([{ id: 22, url: 'https://www.youtube.com/watch?v=xyz' }]);
  bg.chrome.tabs.sendMessage = async (tabId, payload) => {
    sent.push({ tabId, payload });
    return { ok: true };
  };
  bg.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === 'isweep_offscreen_start_tab_capture') return { ok: true };
    if (payload.type === 'isweep_offscreen_stop_tab_capture') return { ok: true };
    return { ok: true };
  };

  await bg.handleStartTabAudioCaptions();

  const result = await bg.handleStopTabAudioCaptions();
  assert.equal(result.ok, true);
  assert.equal(sent.some((entry) => entry.payload.type === 'isweep_tab_audio_capture_status' && entry.payload.state === 'stopped'), true);
});

test('audio caption chunk posts to transcribe and relays transcript to content script', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  const postedUrls = [];
  bg.fetch = async (url) => {
    postedUrls.push(url);
    if (String(url).endsWith('/event')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ action: 'none' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status: 'ready',
        source: 'audio_stt',
        events: [],
        text: 'hello world',
        clean_text: 'hello world',
      }),
    };
  };

  const sent = [];
  bg.chrome.tabs.query = async () => ([{ id: 33, url: 'https://www.youtube.com/watch?v=chunkvid' }]);
  bg.chrome.tabs.sendMessage = async (tabId, payload) => {
    sent.push({ tabId, payload });
    return { ok: true };
  };
  bg.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === 'isweep_offscreen_start_tab_capture') return { ok: true };
    return { ok: true };
  };

  await bg.handleStartTabAudioCaptions();

  const result = await bg.handleAudioAhead('chunkvid', 'ZmFrZQ==', 'audio/wav', 0, 2);
  assert.equal(postedUrls.some((url) => String(url).endsWith('/captions/transcribe')), true);
  assert.equal(result.status, 'ready');

  await bg.relayAudioCaptionResultToTab(result);

  assert.equal(sent.some((entry) => entry.payload.type === 'isweep_audio_caption_text'), true);
});

test('start audio captions creates offscreen document', async () => {
  const bg = loadBackgroundContext();
  let created = 0;
  bg.chrome.tabs.query = async () => ([{ id: 88, url: 'https://www.youtube.com/watch?v=offscreen1' }]);
  bg.chrome.offscreen.createDocument = async () => {
    created += 1;
  };
  bg.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === 'isweep_offscreen_start_tab_capture') return { ok: true };
    return { ok: true };
  };

  const result = await bg.handleStartTabAudioCaptions();
  assert.equal(result.ok, true);
  assert.equal(created, 1);
});

test('empty transcript does not call /event', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  const urls = [];
  bg.fetch = async (url) => {
    urls.push(url);
    if (String(url).endsWith('/captions/transcribe')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'ready', source: 'audio_stt', events: [], text: '' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ action: 'none' }),
    };
  };

  await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 1, 2);
  assert.equal(urls.filter((url) => String(url).endsWith('/event')).length, 0);
});

test('placeholder or status source does not call /event', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  const urls = [];
  bg.fetch = async (url) => {
    urls.push(url);
    if (String(url).endsWith('/captions/transcribe')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: 'ready',
          source: 'audio_stt_disabled',
          events: [],
          text: 'ISweep Captions listening...',
          failure_reason: 'stt_disabled',
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ action: 'none' }),
    };
  };

  await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 1, 2);
  assert.equal(urls.filter((url) => String(url).endsWith('/event')).length, 0);
});

test('real transcript calls /event once when no events are returned', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  const urls = [];
  bg.fetch = async (url) => {
    urls.push(url);
    if (String(url).endsWith('/captions/transcribe')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'ready', source: 'audio_stt', events: [], text: 'hello world' }),
      };
    }
    if (String(url).endsWith('/event')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ action: 'none', duration_seconds: 0, matched_category: null }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    };
  };

  await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 1, 2);
  assert.equal(urls.filter((url) => String(url).endsWith('/event')).length, 1);
});
