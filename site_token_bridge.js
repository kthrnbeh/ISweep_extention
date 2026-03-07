// Bridges site-localStorage auth token into extension storage so popup/background share the same Bearer.
const TOKEN_KEY = 'isweep_auth_token';

function pushTokenToExtension() {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (token) {
      chrome.storage.local.set({ [TOKEN_KEY]: token });
      return { ok: true, hasToken: true };
    }
    return { ok: true, hasToken: false };
  } catch (err) {
    return { ok: false, error: err?.message || 'token read failed' };
  }
}

// Push once on load
pushTokenToExtension();

// Respond to explicit pulls from popup/background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ISWEEP_PULL_TOKEN') {
    sendResponse(pushTokenToExtension());
    return true;
  }
  return false;
});
