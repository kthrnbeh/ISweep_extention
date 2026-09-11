// ISweep live caption remote.
// Uses YouTube's visible caption stream for fast masking and overlay style repair.
// youtube_captions.js owns playback mute so this observer cannot create a second
// mute window for the same caption mutation.
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

  function ensureRemoteStyles() {
    if (document.getElementById('isweep-caption-remote-style')) return;
    const style = document.createElement('style');
    style.id = 'isweep-caption-remote-style';
    style.textContent = `
      [data-isweep-clean-captions="true"] {
        position: fixed !important;
        left: var(--isweep-caption-left, 50%) !important;
        top: var(--isweep-caption-top, 80%) !important;
        transform: translate(-50%, -50%) !important;
        max-width: var(--isweep-caption-max-width, 80vw) !important;
      }
      [data-isweep-clean-captions="true"][data-isweep-remote-style="transparent_white"] > div {
        color: #fff !important;
        background: rgba(0, 0, 0, 0.78) !important;
        border: 1px solid rgba(255, 255, 255, 0.9) !important;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9) !important;
      }
      [data-isweep-clean-captions="true"][data-isweep-remote-style="white_black"] > div {
        color: #111 !important;
        background: rgba(255, 255, 255, 0.94) !important;
        border: 1px solid rgba(17, 17, 17, 0.9) !important;
        text-shadow: none !important;
      }
      [data-isweep-clean-captions="true"][data-isweep-remote-style="black_white"] > div {
        color: #fff !important;
        background: #000 !important;
        border: 1px solid rgba(255, 255, 255, 0.9) !important;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getVideo() {
    return document.querySelector('video');
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
    ensureRemoteStyles();

    const overlay = document.querySelector('[data-isweep-clean-captions="true"]');
    const textNode = overlay?.firstElementChild;
    const nativeContainer = document.querySelector('.ytp-caption-window-container');

    if (!preferencesReady) {
      // Never leave a raw remote overlay visible while the shared preference
      // snapshot is loading. Native captions remain visible until the main
      // renderer has a filtered replacement.
      if (overlay?.dataset.isweepCaptionSource === 'remote') {
        overlay.style.display = 'none';
      }
      if (nativeContainer) nativeContainer.style.visibility = '';
      return;
    }

    if (!settings.cleanCaptionsEnabled || !overlay || !textNode) {
      if (nativeContainer) nativeContainer.style.visibility = '';
      return;
    }

    const cleanText = limitCaptionText(maskSelectedText(nativeCaptionText));
    const mainRendererOwnsText = Boolean(
      overlay.dataset.isweepCaptionSource
      && overlay.dataset.isweepCaptionSource !== 'remote'
      && textNode.textContent.trim()
    );
    if (cleanText && !mainRendererOwnsText && textNode.textContent !== cleanText) {
      textNode.textContent = cleanText;
      overlay.dataset.isweepCaptionSource = 'remote';
    }

    overlay.dataset.isweepRemoteStyle = settings.cleanCaptionStyle;

    const video = getVideo();
    if (video) {
      const rect = video.getBoundingClientRect();
      overlay.style.setProperty('--isweep-caption-left', `${rect.left + (rect.width * settings.cleanCaptionPosition.x)}px`);
      overlay.style.setProperty('--isweep-caption-top', `${rect.top + (rect.height * settings.cleanCaptionPosition.y)}px`);
      overlay.style.setProperty('--isweep-caption-max-width', `${Math.max(rect.width * 0.82, 220)}px`);
    }

    textNode.style.fontSize = settings.cleanCaptionTextSize === 'small'
      ? '14px'
      : settings.cleanCaptionTextSize === 'large' ? '20px' : '18px';
    textNode.style.fontWeight = '600';
    textNode.style.lineHeight = '1.3';
    textNode.style.padding = '0.18em 0.4em';
    textNode.style.borderRadius = '3px';

    if (nativeContainer) {
      nativeContainer.style.visibility = cleanText ? 'hidden' : '';
    }
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
      ensureRemoteStyles();
      startObserver();
      processCaption();
    })
    .catch((error) => {
      console.warn(LOG, 'startup failed', error?.message || error);
    });
})();
