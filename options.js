const STORAGE_KEYS = {
	BACKEND_URL: 'isweepBackendUrl' // Storage key for backend URL
};

const backendForm = document.getElementById('backendForm'); // Form element for backend URL
const backendUrlInput = document.getElementById('backendUrl'); // Input where user types backend URL
const backendStatus = document.getElementById('backendStatus'); // Status message element
const testButton = document.getElementById('testBackend'); // Button to test backend health

function logStatus(message, color = '#6b7280') {
	backendStatus.textContent = message; // Show message to user
	backendStatus.style.color = color; // Color-code status (gray default)
}

async function loadBackendUrl() {
	const store = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]); // Read stored URL
	const url = store[STORAGE_KEYS.BACKEND_URL] || 'http://127.0.0.1:5000'; // Default if missing
	backendUrlInput.value = url; // Prefill input with stored/default URL
	console.log('[ISWEEP][EXT] loaded backend url', url); // Debug log
	logStatus(`Loaded backend URL: ${url}`); // Update status label
}

backendForm.addEventListener('submit', async (e) => {
	e.preventDefault(); // Stop default form submit
	const url = backendUrlInput.value.trim() || 'http://127.0.0.1:5000'; // Use input or default
	await chrome.storage.local.set({ [STORAGE_KEYS.BACKEND_URL]: url }); // Persist URL
	console.log('[ISWEEP][EXT] backend url saved', url); // Debug log
	logStatus(`Saved backend URL: ${url}`, '#10b981'); // Green success status
});

testButton.addEventListener('click', async () => {
	const url = backendUrlInput.value.trim() || 'http://127.0.0.1:5000'; // Use input/default URL
	logStatus('Testing connection...', '#6b7280'); // Inform user of pending test
	try {
		const res = await fetch(`${url}/health`); // Hit backend health endpoint
		if (!res.ok) throw new Error(await res.text()); // Throw if non-2xx
		const body = await res.json(); // Parse JSON body
		console.log('[ISWEEP][EXT] health ok', res.status); // Debug success
		logStatus(`Success: ${body.status || 'ok'}`, '#10b981'); // Green success message
	} catch (err) {
		console.warn('[ISWEEP][EXT] health failed', err.message || err); // Debug failure
		logStatus(`Failed to connect: ${err.message}`, '#ef4444'); // Red error message
	}
});

loadBackendUrl(); // Initialize form with stored/default backend URL
