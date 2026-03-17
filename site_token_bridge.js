// Bridges site-localStorage auth token into extension storage so popup/background share the same Bearer.
const TOKEN_KEY = 'isweep_auth_token'; // Shared token key between site and extension

function pushTokenToExtension() {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY); // Read token from site localStorage
    if (token) {
      chrome.storage.local.set({ [TOKEN_KEY]: token }); // Copy token into extension storage
      return { ok: true, hasToken: true }; // Indicate success with token
    }
    return { ok: true, hasToken: false }; // No token found but operation fine
  } catch (err) {
    return { ok: false, error: err?.message || 'token read failed' }; // Propagate read/set errors
  }
}

// Push once on load
pushTokenToExtension(); // On script load, copy token if present

// Respond to explicit pulls from popup/background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ISWEEP_PULL_TOKEN') {
    sendResponse(pushTokenToExtension()); // Refresh token into extension storage
    return true; // Indicate async response handled
  }
  return false; // Ignore other messages
});
