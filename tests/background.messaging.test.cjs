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
        cleaned_captions: [{ start_seconds: 10, end_seconds: 11, clean_text: 'hello ____' }],
        failure_reason: null,
        cached: true,
      }),
    };
  };

  const result = await bg.handleAudioAhead('video1', 'ZmFrZQ==', 'audio/wav', 10, 11);
  assert.equal(requestBody.chunk_start_seconds, 10);
  assert.equal(requestBody.chunk_end_seconds, 11);
  assert.equal(requestBody.start_seconds, 10);
  assert.equal(requestBody.end_seconds, 11);

  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'audio_stt');
  assert.equal(result.cached, true);
  assert.equal(Array.isArray(result.cleaned_captions), true);
  assert.equal(result.cleaned_captions.length, 1);
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
