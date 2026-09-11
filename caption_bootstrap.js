// ISweep media-filter startup bootstrap.
// Keeps page filtering independent of the Filters tab: every supported media page
// asks the background worker for the user's last saved shared preferences at startup.
(function () {
  'use strict';

  const LOG = '[ISWEEP][CAPTION_BOOT]';
  const PREFS_KEY = 'isweepPreferences';
  const SETTINGS_KEY = 'isweepCleanCaptionSettings';

  function countSelectedWords(prefs) {
    const data = prefs && typeof prefs === 'object' ? prefs : {};
    const language = data.categories?.language && typeof data.categories.language === 'object'
      ? data.categories.language
      : {};
    const values = [];

    if (Array.isArray(data.blocklist?.items)) values.push(...data.blocklist.items);
    if (Array.isArray(language.items)) values.push(...language.items);
    if (Array.isArray(language.words)) values.push(...language.words);
    if (Array.isArray(language.customWords)) values.push(...language.customWords);
    if (Array.isArray(data.customWords)) values.push(...data.customWords);

    return new Set(
      values
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
    ).size;
  }

  async function logSnapshot(stage) {
    const state = await chrome.storage.local.get([PREFS_KEY, SETTINGS_KEY]);
    const prefs = state[PREFS_KEY];
    const settings = state[SETTINGS_KEY] || {};

    console.log(LOG, stage, {
      selectedWordCount: countSelectedWords(prefs),
      hasPreferences: Boolean(prefs && typeof prefs === 'object'),
      cleanCaptionsEnabled: settings.cleanCaptionsEnabled !== false,
      mode: settings.cleanCaptionWordMuteMode || 'captions_only',
    });
  }

  console.log(LOG, 'script loaded');
  document.documentElement.dataset.isweepCaptionBootstrap = 'loaded';

  logSnapshot('before preference refresh').catch(() => {});

  chrome.runtime.sendMessage({ type: 'isweep_sync_prefs' })
    .then((result) => {
      console.log(LOG, 'preference refresh result', {
        ok: result?.ok === true,
        status: result?.status ?? null,
        error: result?.error || null,
      });
      return logSnapshot('after preference refresh');
    })
    .catch((error) => {
      console.warn(LOG, 'preference refresh failed', error?.message || error);
      return logSnapshot('using cached preferences');
    });
})();
