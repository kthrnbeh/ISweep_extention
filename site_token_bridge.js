// Bridges site-localStorage auth token into extension storage so popup/background share the same Bearer.
const TOKEN_KEY = 'isweep_auth_token'; // Shared token key between site and extension
const PREFS_CACHE_KEY = 'isweep-preferences'; // Frontend cache updated after /preferences saves

async function pushTokenToExtension() {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY); // Read token from site localStorage

    if (!token) {
      return { ok: true, hasToken: false };
    }

    // Wait until the token is actually in extension storage before asking the
    // background worker to fetch /preferences. This removes the old race.
    await chrome.storage.local.set({ [TOKEN_KEY]: token });

    let syncResult = null;
    try {
      syncResult = await chrome.runtime.sendMessage({ type: 'isweep_sync_prefs' });
    } catch (err) {
      console.warn('[ISWEEP][TOKEN_BRIDGE] preference sync request failed', err?.message || err);
    }

    console.log('[ISWEEP][TOKEN_BRIDGE] token copied to extension', {
      prefsSynced: syncResult?.ok === true,
    });

    return {
      ok: true,
      hasToken: true,
      prefsSynced: syncResult?.ok === true,
    };
  } catch (err) {
    console.warn('[ISWEEP][TOKEN_BRIDGE] token bridge failed', err?.message || err);
    return { ok: false, error: err?.message || 'token read failed' };
  }
}

function watchHostedPreferenceChanges() {
  let lastSnapshot = window.localStorage.getItem(PREFS_CACHE_KEY) || '';

  setInterval(() => {
    const nextSnapshot = window.localStorage.getItem(PREFS_CACHE_KEY) || '';
    if (nextSnapshot === lastSnapshot) return;

    lastSnapshot = nextSnapshot;
    console.log('[ISWEEP][TOKEN_BRIDGE] site preferences changed; syncing extension');
    pushTokenToExtension();
  }, 800);
}

// Push once on load, then keep the extension preference cache aligned with
// successful saves made on the hosted Filters page.
pushTokenToExtension();
watchHostedPreferenceChanges();

// Respond to explicit pulls from popup/background.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ISWEEP_PULL_TOKEN') {
    pushTokenToExtension().then(sendResponse);
    return true; // Keep the message channel open for the async response.
  }
  return false;
});
