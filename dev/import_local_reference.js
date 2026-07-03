/*
ISweep developer helper: local reference import

Usage (extension console / popup devtools):
  importLocalReferenceFromPaste({
    videoId: 'tQmEd_UeeIk',
    title: 'Optional title',
    pastedLyrics: 'line one\nline two\nline three'
  });
*/

async function importLocalReferenceFromPaste(options = {}) {
  const videoId = String(options.videoId || '').trim();
  if (!videoId) {
    throw new Error('videoId is required');
  }
  const pastedLyrics = String(options.pastedLyrics || '').trim();
  if (!pastedLyrics) {
    throw new Error('pastedLyrics is required');
  }
  const payload = {
    type: 'isweep_import_local_reference',
    video_id: videoId,
    title: String(options.title || '').trim(),
    reference_type: String(options.referenceType || 'user_provided_lyrics').trim(),
    pasted_lyrics: pastedLyrics,
  };
  const response = await chrome.runtime.sendMessage(payload);
  if (!response || response.ok !== true) {
    const detail = response && response.error ? response.error : 'import_failed';
    throw new Error(`local reference import failed: ${detail}`);
  }
  return response;
}

if (typeof globalThis !== 'undefined') {
  globalThis.importLocalReferenceFromPaste = importLocalReferenceFromPaste;
}
