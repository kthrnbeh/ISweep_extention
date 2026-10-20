// ISweep live caption remote.
// Observes YouTube's visible caption stream for compatibility and diagnostics.
// youtube_captions.js is the sole visible ISweep overlay owner; this observer
// must not create or mutate that shared overlay.
(function () {
  'use strict';

  const LOG = '[ISWEEP][CAPTION_REMOTE]';
  const STORAGE_KEYS = {
    PREFS: 'isweepPreferences',
    CLEAN_CAPTION_SETTINGS: 'isweepCleanCaptionSettings',
  };

  let preferencesReady = typeof chrome === 'undefined' || !chrome.storage?.local;
  let preferences = null;
  let settings = {
    cleanCaptionsEnabled: true,
    cleanCaptionStyle: 'black_white',
    cleanCaptionTextSize: 'medium',
    cleanCaptionWordMuteMode: 'captions_only',
    cleanCaptionPosition: { x: 0.5, y: 0.8 },
  };

  let observer = null;

  function normalizePhrase(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizePreferences(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const language = data.categories?.language && typeof data.categories.language === 'object'
      ? data.categories.language
      : {};
    const words = [];

    if (Array.isArray(data.blocklist?.items)) words.push(...data.blocklist.items);
    if (Array.isArray(language.items)) words.push(...language.items);
    if (Array.isArray(language.words)) words.push(...language.words);
    if (Array.isArray(language.customWords)) words.push(...language.customWords);
    if (Array.isArray(data.customWords)) words.push(...data.customWords);

    return {
      enabled: data.enabled !== false
        && data.blocklist?.enabled !== false
        && language.enabled !== false,
      words: Array.from(new Set(words.map(normalizePhrase).filter(Boolean))),
    };
  }

  function normalizeSettings(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const position = data.cleanCaptionPosition && typeof data.cleanCaptionPosition === 'object'
      ? data.cleanCaptionPosition
      : {};

    return {
      cleanCaptionsEnabled: data.cleanCaptionsEnabled !== false,
      cleanCaptionStyle: ['black_white', 'white_black', 'transparent_white'].includes(data.cleanCaptionStyle)
        ? data.cleanCaptionStyle
        : 'black_white',
      cleanCaptionTextSize: ['small', 'medium', 'large'].includes(data.cleanCaptionTextSize)
        ? data.cleanCaptionTextSize
        : 'medium',
      cleanCaptionWordMuteMode: data.cleanCaptionWordMuteMode === 'captions_word_mute'
        ? 'captions_word_mute'
        : 'captions_only',
      cleanCaptionPosition: {
        x: Math.max(0, Math.min(1, Number(position.x) || 0.5)),
        y: Math.max(0, Math.min(1, Number(position.y) || 0.8)),
      },
    };
  }

  function extractCaptionText() {
    return Array.from(document.querySelectorAll('.ytp-caption-segment'))
      .map((node) => String(node.textContent || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function maskSelectedText(text) {
    const raw = String(text || '');
    if (!preferences?.enabled || !preferences.words.length) return raw;

    let masked = raw;
    const phrases = [...preferences.words].sort((a, b) => b.length - a.length);
    phrases.forEach((phrase) => {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
      masked = masked.replace(regex, '___');
    });
    return masked;
  }

  function limitCaptionText(text) {
    const normalized = String(text || '')
      .replace(/\s*>>+\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return '';

    const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean)
      || [];

    if (sentences.length > 2) {
      return sentences.slice(-2).join(' ');
    }

    // Keep an in-progress caption from growing into a transcript when the
    // page does not provide punctuation yet.
    if (sentences.length === 1 && !/[.!?]\s*$/.test(normalized)) {
      const tokens = normalized.split(/\s+/).filter(Boolean);
      if (tokens.length > 32) return tokens.slice(-32).join(' ');
    }

    return normalized;
  }

  function updateCleanOverlay(nativeCaptionText) {
    // youtube_captions.js polls the same native caption stream and owns the
    // shared overlay, native visibility, styling, positioning, and timing.
    // Keep this return value for diagnostics and test hooks without creating a
    // second renderer or competing over the overlay DOM.
    if (!preferencesReady || !settings.cleanCaptionsEnabled) return '';
    return limitCaptionText(maskSelectedText(nativeCaptionText));
  }

  function processCaption() {
    const text = extractCaptionText();
    if (!text) {
      updateCleanOverlay('');
      return;
    }

    // youtube_captions.js is the single playback-mute owner. This observer
    // remains responsible for fast caption masking/style repair, but must not
    // create a second mute window for the same DOM mutation.

    updateCleanOverlay(text);
  }

  async function loadState() {
    const values = await chrome.storage.local.get([
      STORAGE_KEYS.PREFS,
      STORAGE_KEYS.CLEAN_CAPTION_SETTINGS,
    ]);
    preferences = normalizePreferences(values[STORAGE_KEYS.PREFS]);
    preferencesReady = true;
    settings = normalizeSettings(values[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]);

    console.log(LOG, 'ready', {
      selectedWordCount: preferences.words.length,
      mode: settings.cleanCaptionWordMuteMode,
    });
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => processCaption());
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    setInterval(processCaption, 120);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes[STORAGE_KEYS.PREFS]) {
      preferences = normalizePreferences(changes[STORAGE_KEYS.PREFS].newValue);
      preferencesReady = true;
      console.log(LOG, 'preferences updated live', {
        selectedWordCount: preferences.words.length,
      });
      processCaption();
    }

    if (changes[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]) {
      settings = normalizeSettings(changes[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS].newValue);
      console.log(LOG, 'caption settings updated live', {
        mode: settings.cleanCaptionWordMuteMode,
        style: settings.cleanCaptionStyle,
      });
      processCaption();
    }
  });

  if (typeof globalThis !== 'undefined' && globalThis.__ISWEEP_TEST_MODE__) {
    globalThis.__ISWEEP_CAPTION_REMOTE_TEST_HOOKS__ = {
      normalizePreferences,
      maskSelectedText,
      limitCaptionText,
      setPreferencesForTest(raw) {
        preferences = normalizePreferences(raw);
        preferencesReady = true;
      },
    };
  }

  loadState()
    .then(() => {
      startObserver();
      processCaption();
    })
    .catch((error) => {
      console.warn(LOG, 'startup failed', error?.message || error);
    });
})();
