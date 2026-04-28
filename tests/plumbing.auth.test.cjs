const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function waitForInit() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadPlumbingContext(initialStore) {
  const filePath = path.resolve(__dirname, '..', 'plumbing.js');
  const source = fs.readFileSync(filePath, 'utf8');

  const logs = [];
  const elementsById = new Map();
  const storage = { ...(initialStore || {}) };
  const storageListeners = [];

  const document = {
    readyState: 'complete',
    body: {
      appendChild(el) {
        if (el && el.id) elementsById.set(el.id, el);
      },
    },
    createElement(tagName) {
      const element = {
        tagName,
        id: '',
        style: {},
        textContent: '',
        remove() {
          if (this.id) elementsById.delete(this.id);
        },
      };
      return element;
    },
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    addEventListener() {},
  };

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            const out = {};
            keys.forEach((k) => { out[k] = storage[k]; });
            return out;
          }
          return { ...storage };
        },
      },
      onChanged: {
        addListener(fn) {
          storageListeners.push(fn);
        },
      },
    },
  };

  const context = {
    console: {
      log: (...args) => logs.push(args.map((x) => String(x)).join(' ')),
      warn: (...args) => logs.push(args.map((x) => String(x)).join(' ')),
      error: (...args) => logs.push(args.map((x) => String(x)).join(' ')),
    },
    chrome,
    document,
    window: { location: { hostname: 'www.youtube.com' } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'plumbing.js' });

  function triggerStorageChange(changes) {
    Object.entries(changes).forEach(([key, change]) => {
      storage[key] = change.newValue;
    });
    storageListeners.forEach((fn) => fn(changes, 'local'));
  }

  return {
    logs,
    document,
    triggerStorageChange,
  };
}

test('authenticated true starts filtering', async () => {
  const ctx = loadPlumbingContext({
    isweepEnabled: true,
    isweepAuth: { email: 'user@example.com' },
  });

  await waitForInit();
  assert.ok(ctx.document.getElementById('isweep-indicator'));
});

test('authenticated false stops filtering in production mode', async () => {
  const ctx = loadPlumbingContext({
    isweepEnabled: true,
    isweepAuth: { email: 'user@example.com' },
    devLocalAuthEnabled: false,
    isweepBackendUrl: 'https://api.isweep.app',
  });

  await waitForInit();
  assert.ok(ctx.document.getElementById('isweep-indicator'));

  ctx.triggerStorageChange({
    isweepAuth: { oldValue: { email: 'user@example.com' }, newValue: null },
  });

  await waitForInit();
  assert.equal(ctx.document.getElementById('isweep-indicator'), null);
});

test('authenticated false + dev local auth starts filtering', async () => {
  const ctx = loadPlumbingContext({
    isweepEnabled: true,
    isweepAuth: null,
    isweep_auth_token: null,
    devLocalAuthEnabled: true,
    isweepBackendUrl: 'http://127.0.0.1:5000',
  });

  await waitForInit();
  assert.ok(ctx.document.getElementById('isweep-indicator'));
  assert.equal(ctx.logs.some((line) => line.includes('[ISWEEP][AUTH] dev local auth enabled')), true);
});
