const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(
  path.join(workspaceRoot, relativePath),
  'utf8',
);

test('Filter page loads the authentication and preference-save guards', () => {
  const filterHtml = read('docs/Filter.html');
  assert.match(filterHtml, /<script src="main\.js" defer><\/script>/);
  assert.match(filterHtml, /<script src="auth_sync\.js" defer><\/script>/);
  assert.match(filterHtml, /<script src="filter_sync_guard\.js" defer><\/script>/);
});

test('account display and preference save use the same aligned token source', () => {
  const main = read('docs/main.js');
  assert.match(main, /function resolveStoredAuthToken\(\)/);
  assert.match(main, /function alignStoredAuthToken\(\)/);
  assert.match(main, /const isSignedIn = Boolean\(token\)/);
  assert.match(main, /const token = alignStoredAuthToken\(\);/);
  assert.match(main, /state\?\.token/);
  assert.match(main, /\[ISWEEP\]\[FE\]\[AUTH\] preference save auth state/);
});

test('auth sync aligns auth-state tokens into both website token keys', () => {
  const authSync = read('docs/auth_sync.js');
  assert.match(authSync, /function alignTokenKeys\(\)/);
  assert.match(authSync, /auth\?\.token/);
  assert.match(authSync, /localStorage\.setItem\(TOKEN_KEY, token\)/);
  assert.match(authSync, /localStorage\.setItem\(SHARED_TOKEN_KEY, token\)/);
  assert.match(authSync, /const token = alignTokenKeys\(\);/);
});

test('local backend allows hosted-page private-network preflight', () => {
  const backend = read('ISweep_backend/app.py');
  assert.match(backend, /Access-Control-Allow-Private-Network.*true/);
});
