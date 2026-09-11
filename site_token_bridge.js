// Bridges website auth + the last successfully saved backend preferences into extension storage.
//
// Cohesion rule:
//   Filter.html saves to /preferences
//        ↓
//   Backend/database is the durable source of truth
//        ↓
//   Browser clients consume the same saved preference object
//
// This file is intentionally safe to inject more than once. The service worker
// can re-inject it into an already-open ISweep tab after the extension reloads.
(function initIsweepSiteTokenBridge() {
  'use strict';

  if (globalThis.__ISWEEP_SITE_TOKEN_BRIDGE_LOADED__ === true) {
    console.log('[ISWEEP][TOKEN_BRIDGE] already loaded; reusing existing bridge');
    return;
  }
  globalThis.__ISWEEP_SITE_TOKEN_BRIDGE_LOADED__ = true;

  const TOKEN_KEY = 'isweep_auth_token';
  const USER_ID_KEY = 'isweep-user-id';
  const AUTH_STATE_KEY = 'auth-state';
  const SETTINGS_KEY = 'isweep-settings';
  const SITE_PREFS_CACHE_KEY = 'isweep-preferences';
  const SITE_PREFS_CACHE_USER_ID_KEY = 'isweep-preferences-user-id';
  const EXTENSION_PREFS_KEY = 'isweepPreferences';

  let lastObservedSnapshot = '';

  function safeParseJson(raw, fallback = null) {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function normalizeSavedPreferences(raw) {
    const prefs = raw && typeof raw === 'object' ? raw : null;
    if (!prefs) return null;

    const blocklistItems = Array.isArray(prefs?.blocklist?.items)
      ? prefs.blocklist.items
      : Array.isArray(prefs?.categories?.language?.items)
        ? prefs.categories.language.items
        : [];

    const cleanedItems = Array.from(new Set(
      blocklistItems
        .map((word) => typeof word === 'string' ? word.trim().toLowerCase() : '')
        .filter(Boolean)
    ));

    return {
      ...prefs,
      categories: {
        ...(prefs.categories || {}),
        language: {
          ...(prefs.categories?.language || {}),
          items: cleanedItems,
        },
      },
      blocklist: {
        ...(prefs.blocklist || {}),
        items: cleanedItems,
      },
    };
  }

  function hasExplicitWordList(raw) {
    return Array.isArray(raw?.blocklist?.items)
      || Array.isArray(raw?.categories?.language?.items)
      || Array.isArray(raw?.categories?.language?.words)
      || Array.isArray(raw?.categories?.language?.customWords)
      || Array.isArray(raw?.customWords);
  }

  function accountHint() {
    const userId = String(window.localStorage.getItem(USER_ID_KEY) || '').trim();
    if (userId) return userId;
    const auth = safeParseJson(window.localStorage.getItem(AUTH_STATE_KEY), null);
    return String(auth?.user_id || auth?.userId || '').trim() || null;
  }

  async function buildPreferencesFromSavedFilterSettings() {
    const settings = safeParseJson(
      window.localStorage.getItem(SETTINGS_KEY),
      null,
    );
    if (!settings || typeof settings !== 'object') return null;

    const wordlistUrl = new URL('wordlists/language_words.json', window.location.href).toString();
    const response = await fetch(wordlistUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`wordlist HTTP ${response.status}`);
    const payload = await response.json();
    const language = payload?.language && typeof payload.language === 'object'
      ? payload.language
      : {};
    const selections = settings?.predefined_words?.language || {};
    const selectedWords = [];

    Object.entries(language).forEach(([subKey, group]) => {
      const selectedIds = new Set(
        Array.isArray(selections?.[subKey]?.selectedIds)
          ? selections[subKey].selectedIds.map(String)
          : []
      );
      (Array.isArray(group?.items) ? group.items : []).forEach((item) => {
        if (!selectedIds.has(String(item?.id || ''))) return;
        try {
          const decoded = atob(String(item?.token || ''));
          if (decoded.trim()) selectedWords.push(decoded.trim());
        } catch (_) {}
      });
    });

    const customWords = Array.isArray(settings?.custom_words?.language)
      ? settings.custom_words.language.map((word) => String(word || '').trim()).filter(Boolean)
      : [];
    const items = Array.from(new Set([...selectedWords, ...customWords]));

    return {
      enabled: true,
      categories: {
        language: {
          enabled: settings?.filters_enabled?.language !== false,
          action: 'mute',
          duration: Number(settings?.actions?.language?.duration) || 4,
          items,
        },
      },
      blocklist: {
        enabled: settings?.filters_enabled?.language !== false,
        mode: 'whole_word',
        action: 'mute',
        duration: Number(settings?.actions?.language?.duration) || 4,
        items,
      },
    };
  }

  async function readExpectedPreferenceSnapshot() {
    try {
      const localPrefs = await buildPreferencesFromSavedFilterSettings();
      if (localPrefs) {
        return { prefs: normalizeSavedPreferences(localPrefs), source: 'saved_filter_settings', raw: localPrefs };
      }
    } catch (error) {
      console.warn('[ISWEEP][TOKEN_BRIDGE] saved Filter settings could not be expanded', {
        reason: error?.message || String(error),
      });
    }

    const cachedRaw = safeParseJson(
      window.localStorage.getItem(SITE_PREFS_CACHE_KEY),
      null,
    );
    const cachedUserId = String(
      window.localStorage.getItem(SITE_PREFS_CACHE_USER_ID_KEY) || ''
    ).trim();
    const currentUserId = accountHint();
    const cacheBelongsToCurrentAccount = Boolean(
      cachedUserId && currentUserId && cachedUserId === currentUserId
    );
    if (cachedRaw && hasExplicitWordList(cachedRaw) && cacheBelongsToCurrentAccount) {
      const prefs = normalizeSavedPreferences(cachedRaw);
      return { prefs, source: 'site_backend_cache', raw: cachedRaw };
    }

    if (cachedRaw) {
      console.warn('[ISWEEP][TOKEN_BRIDGE] saved preference cache ignored', {
        reason: !hasExplicitWordList(cachedRaw)
          ? 'saved_backend_cache_missing_word_list'
          : 'saved_backend_cache_account_mismatch',
        cachedAccountHint: cachedUserId || null,
        currentAccountHint: currentUserId,
      });
    }

    return { prefs: null, source: 'none', raw: null };
  }

  if (globalThis.__ISWEEP_TEST_MODE__) {
    globalThis.__ISWEEP_SITE_TOKEN_BRIDGE_TEST_HOOKS__ = {
      normalizeSavedPreferences,
      buildPreferencesFromSavedFilterSettings,
      readExpectedPreferenceSnapshot,
    };
  }

  function readLastSavedBackendPreferences() {
    const cached = safeParseJson(
      window.localStorage.getItem(SITE_PREFS_CACHE_KEY),
      null
    );
    const cachedUserId = String(
      window.localStorage.getItem(SITE_PREFS_CACHE_USER_ID_KEY) || ''
    ).trim();
    const currentUserId = accountHint();

    if (!cached
      || !hasExplicitWordList(cached)
      || !cachedUserId
      || !currentUserId
      || cachedUserId !== currentUserId) return null;
    return normalizeSavedPreferences(cached);
  }

  async function copyLastSavedBackendPreferencesToExtension(reason = 'cached_backend_preferences') {
    const prefs = readLastSavedBackendPreferences();

    if (!prefs) {
      console.warn('[ISWEEP][TOKEN_BRIDGE] no saved backend preference cache available', {
        reason,
      });
      return {
        ok: false,
        reason: 'missing_saved_backend_preferences',
        selectedWordCount: 0,
      };
    }

    await chrome.storage.local.set({
      [EXTENSION_PREFS_KEY]: prefs,
    });

    const selectedWordCount = Array.isArray(prefs?.blocklist?.items)
      ? prefs.blocklist.items.length
      : 0;

    console.log('[ISWEEP][TOKEN_BRIDGE] saved backend preferences copied to extension', {
      reason,
      selectedWordCount,
    });

    return {
      ok: true,
      reason,
      selectedWordCount,
    };
  }

  async function refreshExtensionFromSharedPreferences(reason = 'bridge_refresh') {
    try {
      const token = window.localStorage.getItem(TOKEN_KEY);
      const expectedSnapshot = await readExpectedPreferenceSnapshot();
      const expected = expectedSnapshot.prefs;
      const expectedItems = Array.isArray(expected?.blocklist?.items)
        ? expected.blocklist.items
        : [];
      const userId = accountHint();

      console.log('[ISWEEP][PREF_SYNC] bridge refresh start', {
        reason,
        source: expectedSnapshot.source,
        accountHint: userId,
        hasToken: Boolean(token),
        rawSelectedWordCount: Array.isArray(expectedSnapshot.raw?.blocklist?.items)
          ? expectedSnapshot.raw.blocklist.items.length
          : null,
        normalizedSelectedWordCount: expectedItems.length,
        hasHell: expectedItems.includes('hell'),
      });

      if (token) {
        // Copy the website/account token first so the background worker fetches
        // /preferences for the same signed-in account used by the Filters page.
        await chrome.storage.local.set({
          [TOKEN_KEY]: token,
          ...(userId ? { [USER_ID_KEY]: userId } : {}),
        });

        try {
          const syncResult = await chrome.runtime.sendMessage({
            type: 'isweep_sync_prefs',
            expectedPreferences: expected,
            expectedSource: expectedSnapshot.source,
            expectedUserId: userId,
          });

          if (syncResult?.ok === true || syncResult?.prefs) {
            const store = await chrome.storage.local.get([EXTENSION_PREFS_KEY]);
            const synced = normalizeSavedPreferences(store[EXTENSION_PREFS_KEY]);
            const selectedWordCount = Array.isArray(synced?.blocklist?.items)
              ? synced.blocklist.items.length
              : 0;

            console.log('[ISWEEP][TOKEN_BRIDGE] extension refreshed from shared backend preferences', {
              reason,
              source: syncResult.preferenceSource || expectedSnapshot.source,
              status: syncResult.status || null,
              selectedWordCount,
              selectedWordPreview: syncResult.selectedWordPreview || synced?.blocklist?.items?.slice(0, 10) || [],
              hasHell: Array.isArray(synced?.blocklist?.items) && synced.blocklist.items.includes('hell'),
              diagnostic: syncResult.diagnostic || null,
            });

            return {
              ok: true,
              source: 'backend',
              hasToken: true,
              selectedWordCount,
              selectedWordPreview: syncResult.selectedWordPreview || [],
              diagnostic: syncResult.diagnostic || null,
            };
          }
        } catch (error) {
          console.warn('[ISWEEP][TOKEN_BRIDGE] backend preference refresh failed; using last saved cache', {
            reason,
            error: error?.message || error,
            expectedSource: expectedSnapshot.source,
            expectedSelectedWordCount: expectedItems.length,
          });
        }
      }

      // Resilience only: use the site's cache of the LAST SUCCESSFUL
      // /preferences response. This is saved account state, not unsaved UI state.
      const fallback = await copyLastSavedBackendPreferencesToExtension(reason);

      return {
        ok: fallback.ok,
        reason: fallback.reason || (fallback.ok ? 'last_saved_backend_cache' : 'missing_saved_backend_preferences'),
        source: fallback.ok ? 'last_saved_backend_cache' : 'none',
        hasToken: Boolean(token),
        selectedWordCount: fallback.selectedWordCount || 0,
        selectedWordPreview: fallback.ok ? readLastSavedBackendPreferences()?.blocklist?.items?.slice(0, 10) || [] : [],
      };
    } catch (error) {
      console.warn('[ISWEEP][TOKEN_BRIDGE] shared preference bridge failed', {
        reason,
        error: error?.message || error,
      });

      return {
        ok: false,
        source: 'none',
        selectedWordCount: 0,
        error: error?.message || 'bridge_failed',
      };
    }
  }

  function currentSnapshot() {
    return JSON.stringify({
      token: window.localStorage.getItem(TOKEN_KEY) || '',
      userId: window.localStorage.getItem(USER_ID_KEY) || '',
      // This cache changes only when main.js receives a successful backend
      // preference response.
      savedBackendPreferences:
        window.localStorage.getItem(SITE_PREFS_CACHE_KEY) || '',
      savedBackendPreferencesUserId:
        window.localStorage.getItem(SITE_PREFS_CACHE_USER_ID_KEY) || '',
      savedFilterSettings:
        window.localStorage.getItem(SETTINGS_KEY) || '',
    });
  }

  function watchSharedPreferenceChanges() {
    lastObservedSnapshot = currentSnapshot();

    setInterval(() => {
      const nextSnapshot = currentSnapshot();
      if (nextSnapshot === lastObservedSnapshot) return;

      lastObservedSnapshot = nextSnapshot;

      console.log('[ISWEEP][TOKEN_BRIDGE] shared saved preferences changed; refreshing extension');

      refreshExtensionFromSharedPreferences('saved_preferences_changed');
    }, 500);
  }

  // Initial bridge load.
  console.log('[ISWEEP][TOKEN_BRIDGE] loaded on', window.location.href);
  refreshExtensionFromSharedPreferences('page_loaded');
  watchSharedPreferenceChanges();

  // Popup can explicitly request a refresh while an ISweep site tab is active.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'ISWEEP_PULL_TOKEN') {
      refreshExtensionFromSharedPreferences('popup_requested').then(sendResponse);
      return true;
    }

    return false;
  });
})();
