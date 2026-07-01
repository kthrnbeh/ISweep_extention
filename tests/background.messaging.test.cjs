const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBackgroundContext() {
  const filePath = path.resolve(__dirname, '..', 'background.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const localStore = {};
  let onMessageListener = null;

  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          onMessageListener = listener;
        },
      },
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
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const out = {};
            keys.forEach((key) => {
              out[key] = localStore[key];
            });
            return out;
          }
          return { ...localStore };
        },
        set: async (values) => {
          Object.assign(localStore, values || {});
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((key) => {
            delete localStore[key];
          });
        },
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

  context.__sendRuntimeMessage = (message) => new Promise((resolve) => {
    if (typeof onMessageListener !== 'function') {
      resolve({ ok: false, error: 'listener_not_registered' });
      return;
    }
    const ret = onMessageListener(message, { tab: null }, (response) => resolve(response));
    // If handler returned synchronously without using sendResponse, resolve anyway.
    if (ret !== true) {
      setTimeout(() => resolve(undefined), 0);
    }
  });
  return context;
}

test('caption runtime status prefers YouTube fallback when active tab reports live masked captions', async () => {
  const bg = loadBackgroundContext();
  bg.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', stt_enabled: true }) });
  bg.chrome.tabs.query = async () => ([{ id: 7 }]);
  bg.chrome.tabs.sendMessage = async () => ({
    usingYoutubeFallback: true,
    usingAudioStt: false,
    youtubeDomFallbackEnabled: true,
  });

  const result = await bg.handleCaptionRuntimeStatus();
  assert.equal(result.state, 'youtube_fallback');
  assert.equal(result.label, 'Captions: YouTube fallback');
  assert.equal(result.sourceLabel, 'YouTube Fallback');
});

test('caption runtime status reports listening when health has stt_enabled true and no transcript yet', async () => {
  const bg = loadBackgroundContext();
  bg.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', stt_enabled: true }) });
  bg.chrome.tabs.query = async () => ([{ id: 7 }]);
  bg.chrome.tabs.sendMessage = async () => ({
    usingYoutubeFallback: false,
    usingAudioStt: false,
    overlaySource: 'waiting_audio_text',
    youtubeDomFallbackEnabled: false,
  });

  const result = await bg.handleCaptionRuntimeStatus();
  assert.equal(result.state, 'ready');
  assert.equal(result.source, 'listening');
  assert.equal(result.sourceLabel, 'Listening');
  assert.equal(result.sttEnabled, true);
});

test('caption runtime status reports stt_disabled only when health stt_enabled is false', async () => {
  const bg = loadBackgroundContext();
  bg.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', stt_enabled: false }) });
  bg.chrome.tabs.query = async () => ([{ id: 7 }]);
  bg.chrome.tabs.sendMessage = async () => ({
    usingYoutubeFallback: false,
    usingAudioStt: false,
    overlaySource: 'waiting_audio_text',
    youtubeDomFallbackEnabled: false,
  });

  const result = await bg.handleCaptionRuntimeStatus();
  assert.equal(result.state, 'stt_disabled');
  assert.equal(result.source, 'stt_disabled');
  assert.equal(result.sourceLabel, 'STT Disabled');
  assert.equal(result.sttEnabled, false);
});

test('backend URL defaults to 127.0.0.1:5000 and normalizes old localhost value', async () => {
  const bg = loadBackgroundContext();

  const first = await bg.getBackendUrl();
  assert.equal(first, 'http://127.0.0.1:5000');

  await bg.chrome.storage.local.set({ isweepBackendUrl: 'http://localhost:5000' });
  const normalized = await bg.getBackendUrl();
  assert.equal(normalized, 'http://127.0.0.1:5000');

  const stored = await bg.chrome.storage.local.get(['isweepBackendUrl']);
  assert.equal(stored.isweepBackendUrl, 'http://127.0.0.1:5000');
});

test('caption runtime status reports backend offline when health probe fails', async () => {
  const bg = loadBackgroundContext();
  bg.fetch = async () => { throw new Error('Failed to fetch'); };
  bg.chrome.tabs.query = async () => ([]);

  const result = await bg.handleCaptionRuntimeStatus();
  assert.equal(result.state, 'backend_offline');
  assert.equal(result.label, 'Audio captions: Backend offline');
  assert.equal(result.sourceLabel, 'Backend Offline');
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
  bg.ensureLocalDevCaptionToken = async () => null;

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
  assert.equal(sent.some((entry) => entry.payload.source === 'audio_stt_live'), true);
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

test('live masked source does not call /event', async () => {
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
          source: 'live_masked',
          events: [],
          text: 'that was masked live text',
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

test('silence source does not call /event', async () => {
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
          source: 'silence',
          events: [],
          text: '',
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

test('real transcript does not call /event when no events are returned', async () => {
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
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    };
  };

  await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 1, 2);
  assert.equal(urls.filter((url) => String(url).endsWith('/event')).length, 0);
});

test('starting [CC] does not call mute or change video state', async () => {
  const bg = loadBackgroundContext();
  bg.chrome.tabs.query = async () => ([{ id: 99, url: 'https://www.youtube.com/watch?v=cctest' }]);
  bg.chrome.tabs.sendMessage = async () => ({ ok: true });
  bg.chrome.offscreen.createDocument = async () => {};
  bg.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === 'isweep_offscreen_start_tab_capture') return { ok: true };
    return { ok: true };
  };

  const result = await bg.handleStartTabAudioCaptions();
  assert.equal(result.ok, true);
  assert.equal(result.source, 'tab_capture');
});

test('real transcript with no backend events does not synthesize mute from /event', async () => {
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
          source: 'audio_stt',
          events: [],
          text: 'bad word here',
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    };
  };

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 5, 6);
  assert.equal(result.status, 'ready');
  assert.equal(result.events.length, 0);
  assert.equal(urls.filter((url) => String(url).endsWith('/event')).length, 0);
});

test('handleAudioAhead does not call handleCaptionDecision', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';
  let decisionCalls = 0;
  bg.handleCaptionDecision = async () => {
    decisionCalls += 1;
    return { action: 'mute', duration_seconds: 1.0, matched_category: 'language', matched_word: 'bad' };
  };

  const urls = [];
  bg.fetch = async (url) => {
    urls.push(url);
    if (String(url).endsWith('/captions/transcribe')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: 'ready',
          source: 'audio_stt',
          events: [],
          text: 'some text here',
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    };
  };

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 5, 6);
  assert.equal(result.status, 'ready');
  assert.equal(result.events.length, 0);
  assert.equal(decisionCalls, 0);
  assert.equal(urls.filter((url) => String(url).endsWith('/event')).length, 0);
});

test('audio_capture_unavailable source does not call /event', async () => {
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
          source: 'audio_capture_unavailable',
          events: [],
          text: 'text but unavailable',
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    };
  };

  await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 5, 6);
  assert.equal(urls.filter((url) => String(url).endsWith('/event')).length, 0);
});

test('handleAudioCaptionChunk always returns events: []', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  bg.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'ready',
      source: 'audio_stt',
      events: [{ id: 'fake', start_seconds: 0, end_seconds: 1, action: 'mute' }],
      text: 'hello world',
    }),
  });

  const result = await bg.handleAudioCaptionChunk('vid1', 'ZmFrZQ==', 'audio/wav', 0, 2);
  assert.ok(Array.isArray(result.events) && result.events.length === 0, 'handleAudioCaptionChunk must always return events: []');
});

test('handleAudioCaptionChunk does not call /event', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  const postedUrls = [];
  bg.fetch = async (url) => {
    postedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ready', source: 'audio_stt', events: [], text: 'hello' }),
    };
  };

  await bg.handleAudioCaptionChunk('vid1', 'ZmFrZQ==', 'audio/wav', 0, 2);
  assert.equal(postedUrls.filter((u) => u.endsWith('/event')).length, 0, 'handleAudioCaptionChunk must not call /event');
  assert.equal(postedUrls.filter((u) => u.endsWith('/captions/transcribe')).length, 1, 'must post to /captions/transcribe');
});

test('handleAudioCaptionChunk forwards non-empty transcript to content script', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  bg.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: 'ready', source: 'audio_stt', events: [], text: 'hello world' }),
  });

  const sent = [];
  bg.chrome.tabs.query = async () => ([{ id: 55, url: 'https://www.youtube.com/watch?v=ccvid1' }]);
  bg.chrome.tabs.sendMessage = async (tabId, payload) => { sent.push(payload); return { ok: true }; };
  bg.chrome.runtime.sendMessage = async () => ({ ok: true });

  await bg.handleStartTabAudioCaptions();
  const result = await bg.handleAudioCaptionChunk('ccvid1', 'ZmFrZQ==', 'audio/wav', 0, 2);
  await bg.relayAudioCaptionResultToTab(result);

  const captionMsg = sent.find((p) => p.type === 'isweep_audio_caption_text');
  assert.ok(captionMsg, 'must send isweep_audio_caption_text to content script');
  assert.equal(captionMsg.text, 'hello world');
  assert.ok(Array.isArray(captionMsg.events) && captionMsg.events.length === 0, 'events must be empty []');
});

test('handleAudioCaptionChunk does not forward empty transcript text', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  bg.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: 'ready', source: 'audio_stt', events: [], text: '' }),
  });

  const result = await bg.handleAudioCaptionChunk('vid1', 'ZmFrZQ==', 'audio/wav', 0, 2);
  assert.ok(Array.isArray(result.events) && result.events.length === 0, 'events must always be []');
  assert.equal(result.text === '' || result.text === null, true, 'empty transcript must not become non-empty');
});

test('handleAudioCaptionChunk preserves transcript text per chunk', async () => {
  const bg = loadBackgroundContext();
  bg.getAuthToken = async () => 'token';
  bg.getBackendUrl = async () => 'http://127.0.0.1:5000';

  let call = 0;
  bg.fetch = async (url) => {
    if (!String(url).includes('/captions/transcribe')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', stt_enabled: true }), text: async () => '{}' };
    }
    call += 1;
    const text = call === 1
      ? 'we should move right now'
      : 'should move right now please';
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ready', source: 'audio_stt', events: [], text }),
    };
  };

  const first = await bg.handleAudioCaptionChunk('vid-overlap', 'ZmFrZQ==', 'audio/wav', 0, 1.5);
  const second = await bg.handleAudioCaptionChunk('vid-overlap', 'ZmFrZQ==', 'audio/wav', 1.0, 2.5);

  assert.equal(first.text, 'we should move right now');
  assert.equal(second.text, 'should move right now please');
});

test('isweep_get_audio_caption_debug returns counters and diag messages update state', async () => {
  const bg = loadBackgroundContext();

  const before = await bg.__sendRuntimeMessage({ type: 'isweep_get_audio_caption_debug' });
  assert.equal(typeof before, 'object');
  assert.equal(typeof before.offscreenStreamReadyCount, 'number');
  assert.equal(typeof before.offscreenWorkletLoadedCount, 'number');
  assert.equal(typeof before.offscreenChunkCount, 'number');
  assert.equal('chunkStartedAt' in before, true);
  assert.equal('transcribeStartedAt' in before, true);
  assert.equal('overlayRenderedAt' in before, true);
  assert.equal('totalLatencyMs' in before, true);

  await bg.__sendRuntimeMessage({ type: 'isweep_audio_diag', stage: 'offscreen_stream_ready', videoId: 'v1' });
  await bg.__sendRuntimeMessage({ type: 'isweep_audio_diag', stage: 'offscreen_worklet_loaded' });
  await bg.__sendRuntimeMessage({ type: 'isweep_audio_diag', stage: 'offscreen_chunk_emitted', chunkCount: 10, sampleCount: 12345 });

  const after = await bg.__sendRuntimeMessage({ type: 'isweep_get_audio_caption_debug' });
  assert.equal(after.offscreenStreamReadyCount, before.offscreenStreamReadyCount + 1);
  assert.equal(after.offscreenWorkletLoadedCount, before.offscreenWorkletLoadedCount + 1);
  assert.equal(after.offscreenChunkCount, before.offscreenChunkCount + 1);
});

test('relay recovers tabId after SW restart and retries after content script inject', async () => {
  const bg = loadBackgroundContext();

  bg.chrome.tabs.query = async () => ([{ id: 99, url: 'https://www.youtube.com/watch?v=abc123' }]);
  let sendAttempts = 0;
  bg.chrome.tabs.sendMessage = async () => {
    sendAttempts += 1;
    if (sendAttempts === 1) {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }
    return { ok: true };
  };
  let injected = 0;
  bg.chrome.scripting = {
    executeScript: async () => {
      injected += 1;
    },
  };

  const ok = await bg.relayAudioCaptionResultToTab({
    status: 'ready',
    source: 'audio_stt',
    text: 'hello world',
    events: [],
  });

  assert.equal(ok, true);
  assert.equal(sendAttempts, 2, 'should retry once after inject');
  assert.equal(injected, 1, 'should inject content script before retry');
});

test('relay fails with reason when no active tab can be recovered', async () => {
  const bg = loadBackgroundContext();
  bg.chrome.tabs.query = async () => ([]);

  const ok = await bg.relayAudioCaptionResultToTab({
    status: 'ready',
    source: 'audio_stt',
    text: 'hello world',
    events: [],
  });

  assert.equal(ok, false);
  const debug = await bg.__sendRuntimeMessage({ type: 'isweep_get_audio_caption_debug' });
  assert.equal(debug.lastError, 'relay_no_tab_id');
  assert.equal(debug.relayFailureCount > 0, true);
});

test('relay includes word timestamps for selected-word mute scheduling', async () => {
  const bg = loadBackgroundContext();
  const sent = [];
  bg.chrome.tabs.query = async () => ([{ id: 66, url: 'https://www.youtube.com/watch?v=wordrelay' }]);
  bg.chrome.tabs.sendMessage = async (tabId, payload) => {
    sent.push(payload);
    return { ok: true };
  };

  const ok = await bg.relayAudioCaptionResultToTab({
    status: 'ready',
    source: 'audio_stt',
    text: 'go to hell now',
    words: [
      { word: 'go', start: 0.0, end: 0.2 },
      { word: 'to', start: 0.2, end: 0.3 },
      { word: 'hell', start: 0.3, end: 0.7 },
      { word: 'now', start: 0.7, end: 1.0 },
    ],
    events: [],
  });

  assert.equal(ok, true);
  const message = sent.find((entry) => entry.type === 'isweep_audio_caption_text');
  assert.equal(Boolean(message), true);
  assert.equal(Array.isArray(message.words), true);
  assert.equal(message.words.length, 4);
  assert.equal(Array.isArray(message.word_timestamps), true);
  assert.equal(message.word_timestamps.length, 4);
  assert.equal(message.source, 'audio_stt_live');
});
