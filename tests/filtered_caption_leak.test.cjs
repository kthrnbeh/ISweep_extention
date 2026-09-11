const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workspaceRoot = path.resolve(__dirname, '..', '..');

function makeLocalStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setItem(key, value) {
      values[key] = String(value);
    },
    removeItem(key) {
      delete values[key];
    },
    dump() {
      return { ...values };
    },
  };
}

function loadFilterSyncHooks(settings) {
  const source = fs.readFileSync(
    path.join(workspaceRoot, 'docs', 'filter_sync_guard.js'),
    'utf8',
  );
  const localStorage = makeLocalStorage({
    'isweep-settings': JSON.stringify(settings),
  });
  const wordlist = JSON.parse(fs.readFileSync(
    path.join(workspaceRoot, 'docs', 'wordlists', 'language_words.json'),
    'utf8',
  ));
  const context = {
    console: { log() {}, warn() {}, error() {} },
    globalThis: null,
    localStorage,
    atob,
    fetch: async () => ({ ok: true, json: async () => wordlist }),
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } },
    __ISWEEP_TEST_MODE__: true,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'filter_sync_guard.js' });
  return context.__ISWEEP_FILTER_SYNC_TEST_HOOKS__;
}

function loadSiteBridgeHooks(initialLocalStorage = {}) {
  const source = fs.readFileSync(
    path.join(workspaceRoot, 'ISweep_extention', 'site_token_bridge.js'),
    'utf8',
  );
  const localStorage = makeLocalStorage(initialLocalStorage);
  const wordlist = JSON.parse(fs.readFileSync(
    path.join(workspaceRoot, 'docs', 'wordlists', 'language_words.json'),
    'utf8',
  ));
  const extensionStore = {};
  const context = {
    console: { log() {}, warn() {}, error() {} },
    globalThis: null,
    __ISWEEP_TEST_MODE__: true,
    window: { localStorage, location: { href: 'http://localhost:5500/docs/Filter.html' } },
    URL,
    atob,
    fetch: async () => ({ ok: true, json: async () => wordlist }),
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const result = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((key) => { result[key] = extensionStore[key]; });
            return result;
          },
          async set(values) {
            Object.assign(extensionStore, values);
          },
        },
      },
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage() { return { ok: false, error: 'no_backend_in_unit_test' }; },
      },
    },
    setInterval() { return 0; },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'site_token_bridge.js' });
  return context.__ISWEEP_SITE_TOKEN_BRIDGE_TEST_HOOKS__;
}

function loadRemoteCaptionHooks() {
  const source = fs.readFileSync(
    path.join(workspaceRoot, 'ISweep_extention', 'caption_remote.js'),
    'utf8',
  );
  const document = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: {},
    createElement() {
      return {
        id: '',
        style: { setProperty() {} },
        dataset: {},
        textContent: '',
        appendChild() {},
        addEventListener() {},
      };
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    globalThis: null,
    document,
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: {
      storage: {
        local: { async get() { return {}; } },
        onChanged: { addListener() {} },
      },
    },
    __ISWEEP_TEST_MODE__: true,
    setInterval() { return 0; },
    clearInterval() {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'caption_remote.js' });
  return context.__ISWEEP_CAPTION_REMOTE_TEST_HOOKS__;
}

function loadYoutubeHooks() {
  const source = fs.readFileSync(
    path.join(workspaceRoot, 'ISweep_extention', 'youtube_captions.js'),
    'utf8',
  );
  const context = {
    console: { log() {}, warn() {}, error() {} },
    globalThis: null,
    window: { innerWidth: 1280, innerHeight: 720, location: { href: 'https://www.youtube.com/watch?v=unit' } },
    URL,
    document: {
      querySelector(selector) { return selector === 'video' ? { currentTime: 0, muted: false, volume: 1, paused: false } : null; },
      querySelectorAll() { return []; },
      getElementById() { return null; },
      createElement() { return { style: {}, dataset: {}, appendChild() {}, addEventListener() {} }; },
      body: { appendChild() {} },
    },
    __ISWEEP_TEST_MODE__: true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'youtube_captions.js' });
  return context.__ISWEEP_YT_TEST_HOOKS__;
}

test('selected Filter word hell travels from saved selection into shared preferences', async () => {
  const hooks = loadFilterSyncHooks({
    filters_enabled: { language: true },
    predefined_words: { language: { profanity: { selectedIds: ['profanity-15'] } } },
    custom_words: { language: [] },
    actions: { language: { action: 'mute', duration: 6, sensitivity: 3 } },
  });

  const preferences = await hooks.buildPreferencesFromSavedSettings();
  assert.deepEqual(Array.from(hooks.getWordItems(preferences)), ['hell']);
  assert.equal(hooks.getWordCount(preferences), 1);
});

test('site bridge preserves selected words and normalizes case without broad matching', () => {
  const hooks = loadSiteBridgeHooks();
  const normalized = hooks.normalizeSavedPreferences({
    blocklist: { items: ['Hell', 'shell', 'hell'] },
    categories: { language: { items: ['ignored because blocklist exists'] } },
  });

  assert.deepEqual(Array.from(normalized.blocklist.items), ['hell', 'shell']);
  assert.deepEqual(Array.from(normalized.categories.language.items), ['hell', 'shell']);
});

test('site bridge can expand the saved Filter selection when backend cache is absent', async () => {
  const hooks = loadSiteBridgeHooks({
    'isweep-settings': JSON.stringify({
      filters_enabled: { language: true },
      predefined_words: { language: { profanity: { selectedIds: ['profanity-15'] } } },
      custom_words: { language: [] },
    }),
  });

  const snapshot = await hooks.readExpectedPreferenceSnapshot();
  assert.equal(snapshot.source, 'saved_filter_settings');
  assert.deepEqual(Array.from(snapshot.prefs.blocklist.items), ['hell']);
  assert.equal(snapshot.prefs.blocklist.items.includes('hell'), true);
});

test('site bridge ignores an explicit cache owned by another account', async () => {
  const hooks = loadSiteBridgeHooks({
    'isweep-user-id': 'current-account',
    'isweep-preferences-user-id': 'previous-account',
    'isweep-preferences': JSON.stringify({
      enabled: true,
      blocklist: { enabled: true, items: ['hell'] },
    }),
  });

  const snapshot = await hooks.readExpectedPreferenceSnapshot();
  assert.equal(snapshot.source, 'none');
  assert.equal(snapshot.prefs, null);
});

test('main and remote caption renderers mask hell but leave shell and empty filters alone', () => {
  const youtube = loadYoutubeHooks();
  youtube.setCachedPreferences({
    enabled: true,
    blocklist: { enabled: true, items: ['hell'] },
    categories: { language: { enabled: true, items: ['hell'] } },
  });

  const mainMasked = youtube.toCleanCaptionText('hell Hell, shell hello');
  assert.equal(/\bhell\b/i.test(mainMasked), false);
  assert.equal(mainMasked.includes('___'), true);
  assert.equal(mainMasked.includes('shell'), true);
  assert.equal(mainMasked.includes('hello'), true);
  assert.equal(
    youtube.getCleanCaptionDisplayText({ clean_text: 'go to hell, shell' }),
    'go to ___, shell',
  );

  const remote = loadRemoteCaptionHooks();
  remote.setPreferencesForTest({
    enabled: true,
    blocklist: { enabled: true, items: ['hell'] },
    categories: { language: { enabled: true, items: ['hell'] } },
  });
  assert.equal(remote.maskSelectedText('hell'), '___');
  assert.equal(remote.maskSelectedText('Hell'), '___');
  assert.equal(remote.maskSelectedText('hell, shell'), '___, shell');

  remote.setPreferencesForTest({
    enabled: true,
    blocklist: { enabled: true, items: [] },
    categories: { language: { enabled: true, items: [] } },
  });
  assert.equal(remote.maskSelectedText('hell shell'), 'hell shell');
});
