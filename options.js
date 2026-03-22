const STORAGE_KEYS = {
  BACKEND_URL: 'isweepBackendUrl' // Storage key for backend URL
};

const backendForm = document.getElementById('backendForm');
const backendUrlInput = document.getElementById('backendUrl');
const backendStatus = document.getElementById('backendStatus');
const testButton = document.getElementById('testBackend');

document.addEventListener('DOMContentLoaded', () => {
  function logStatus(message, color = '#6b7280') {
    if (!backendStatus) return;
    backendStatus.textContent = message;
    backendStatus.style.color = color;
  }

  async function loadBackendUrl() {
    if (!backendUrlInput) return;
    const store = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]);
    const url = store[STORAGE_KEYS.BACKEND_URL] || 'http://127.0.0.1:5000';
    backendUrlInput.value = url;
    console.log('[ISWEEP][EXT] loaded backend url', url);
    logStatus(`Loaded backend URL: ${url}`);
}

  if (backendForm) {
    backendForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = backendUrlInput?.value.trim() || 'http://127.0.0.1:5000';
      await chrome.storage.local.set({ [STORAGE_KEYS.BACKEND_URL]: url });
      console.log('[ISWEEP][EXT] backend url saved', url);
      logStatus(`Saved backend URL: ${url}`, '#10b981');
    });
}

  if (testButton) {
    testButton.addEventListener('click', async () => {
      const url = backendUrlInput?.value.trim() || 'http://127.0.0.1:5000';
      logStatus('Testing connection...', '#6b7280');
      try {
        const res = await fetch(`${url}/health`);
        if (!res.ok) throw new Error(await res.text());
        const body = await res.json();
        console.log('[ISWEEP][EXT] health ok', res.status);
        logStatus(`Success: ${body.status || 'ok'}`, '#10b981');
      } catch (err) {
        console.warn('[ISWEEP][EXT] health failed', err.message || err);
        logStatus(`Failed to connect: ${err.message}`, '#ef4444');
      }
    });
}

  loadBackendUrl();
});