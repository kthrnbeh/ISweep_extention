// ISweep live caption remote.
// Uses YouTube's visible caption stream as a timing signal for selected-word mute.
// Playback-only: this never edits or saves media; it only controls live mute state.
(function () {
  'use strict';

  const LOG = '[ISWEEP][CAPTION_REMOTE]';
  const STORAGE_KEYS = {
    PREFS: 'isweepPreferences',
    CLEAN_CAPTION_SETTINGS: 'isweepCleanCaptionSettings',
  };

  let preferences = null;
  let settings = {
    cleanCaptionsEnabled: true,
    cleanCaptionStyle: 'transparent_white',
    cleanCaptionTextSize: 'medium',
    cleanCaptionWordMuteMode: 'captions_only',
    cleanCaptionPosition: { x: 0.5, y: 0.8 },
  };

  let previousCaptionText = '';
  let previousTokens = [];
  let activeMute = null;
  let restoreTimer = null;
  let hardRestoreTimer = null;
  let observer = null;

  function normalizePhrase(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(text) {
    return normalizePhrase(text).split(/\s+/).filter(Boolean);
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
      cleanCaptionStyle: data.cleanCaptionStyle === 'white_black' ? 'white_black' : 'transparent_white',
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
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getVideo() {
    return document.querySelector('video');
  }

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function setMuted(targetMuted, reason) {
    const video = getVideo();
    if (!video) return false;

    const player = getPlayer();
    try {
      if (player && typeof player.isMuted === 'function') {
        const before = Boolean(player.isMuted());
        if (targetMuted && !before && typeof player.mute === 'function') player.mute();
        if (!targetMuted && before && typeof player.unMute === 'function') player.unMute();
        if (Boolean(player.isMuted()) === Boolean(targetMuted)) {
          console.log(LOG, 'mute control', { method: 'player_api', targetMuted, reason });
          return true;
        }
      }
    } catch (_) {}

    const button = document.querySelector('.ytp-mute-button');
    if (button && Boolean(video.muted) !== Boolean(targetMuted)) {
      try { button.click(); } catch (_) {}
    }
    if (Boolean(video.muted) === Boolean(targetMuted)) {
      console.log(LOG, 'mute control', { method: 'youtube_button', targetMuted, reason });
      return true;
    }

    video.muted = Boolean(targetMuted);
    const success = Boolean(video.muted) === Boolean(targetMuted);
    if (success) {
      console.log(LOG, 'mute control', { method: 'video_property', targetMuted, reason });
    }
    return success;
  }

  function clearRestoreTimers() {
    if (restoreTimer) clearTimeout(restoreTimer);
    if (hardRestoreTimer) clearTimeout(hardRestoreTimer);
    restoreTimer = null;
    hardRestoreTimer = null;
  }

  function restoreMute(reason) {
    if (!activeMute) return;
    const state = activeMute;
    activeMute = null;
    clearRestoreTimers();

    setMuted(state.wasMuted === true, `restore:${reason}`);
    console.log('[ISWEEP][WORD_MUTE]', 'mute end', {
      reason,
      matched_word: state.phrase,
      restore_to_muted: state.wasMuted === true,
    });
  }

  function dynamicMuteDurationMs(phrase) {
    const words = tokenize(phrase);
    const chars = words.join('').length;
    const estimated = 260 + (chars * 30) + (Math.max(words.length - 1, 0) * 120);
    return Math.max(320, Math.min(900, estimated));
  }

  function estimatedDelayToWordMs(tokens, matchStart, wasAppended) {
    if (wasAppended || matchStart <= 0) return 0;
    const estimatedWordMs = 290;
    return Math.min(matchStart * estimatedWordMs, 1400);
  }

  function findPhraseMatches(tokens, selectedPhrases) {
    const matches = [];

    selectedPhrases.forEach((phrase) => {
      const phraseTokens = tokenize(phrase);
      if (!phraseTokens.length || phraseTokens.length > tokens.length) return;

      for (let start = 0; start <= tokens.length - phraseTokens.length; start += 1) {
        const slice = tokens.slice(start, start + phraseTokens.length);
        if (slice.every((token, index) => token === phraseTokens[index])) {
          matches.push({
            phrase,
            start,
            end: start + phraseTokens.length - 1,
          });
        }
      }
    });

    return matches;
  }

  function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let index = 0;
    while (index < max && a[index] === b[index]) index += 1;
    return index;
  }

  function beginMute(match, tokens, prefixLength) {
    if (settings.cleanCaptionWordMuteMode !== 'captions_word_mute') return;
    if (!preferences?.enabled || !preferences.words.length) return;

    const video = getVideo();
    if (!video) return;

    const matchWasAlreadyVisible = match.end < prefixLength;
    if (matchWasAlreadyVisible) return;

    const signature = `${match.phrase}|${tokens.join(' ')}`;
    if (activeMute?.signature === signature) return;

    const wasAppended = prefixLength > 0 && match.start >= prefixLength;
    const delayMs = estimatedDelayToWordMs(tokens, match.start, wasAppended);
    const durationMs = dynamicMuteDurationMs(match.phrase);

    const scheduleStart = () => {
      const currentVideo = getVideo();
      if (!currentVideo) return;

      const currentCaption = tokenize(extractCaptionText());
      const currentMatches = findPhraseMatches(currentCaption, [match.phrase]);
      if (!currentMatches.length) return;

      if (activeMute) restoreMute('new_selected_word');

      const wasMuted = Boolean(currentVideo.muted);
      if (wasMuted) {
        console.log(LOG, 'selected word detected but viewer already muted', { phrase: match.phrase });
        return;
      }

      if (!setMuted(true, `selected_word:${match.phrase}`)) return;

      activeMute = {
        signature,
        phrase: match.phrase,
        wasMuted,
        tokenCountAtStart: currentCaption.length,
        startedAtMs: Date.now(),
      };

      restoreTimer = setTimeout(() => restoreMute('dynamic_word_window'), durationMs);
      hardRestoreTimer = setTimeout(() => restoreMute('hard_timeout'), Math.min(durationMs + 450, 1350));

      console.log('[ISWEEP][WORD_MUTE]', 'mute start', {
        matched_word: match.phrase,
        delay_ms: delayMs,
        duration_ms: durationMs,
        source: 'youtube_caption_dom',
      });
    };

    if (delayMs > 0) {
      setTimeout(scheduleStart, delayMs);
    } else {
      scheduleStart();
    }
  }

  function maybeRestoreOnCleanWord(tokens) {
    if (!activeMute) return;
    if (tokens.length <= activeMute.tokenCountAtStart) return;

    const appended = tokens.slice(activeMute.tokenCountAtStart);
    const selected = new Set((preferences?.words || []).flatMap(tokenize));
    const hasCleanWord = appended.some((token) => token && !selected.has(token));

    if (hasCleanWord && (Date.now() - activeMute.startedAtMs) >= 180) {
      setTimeout(() => restoreMute('next_clean_caption_word'), 60);
    }
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

  function updateCleanOverlay(nativeCaptionText) {
    ensureRemoteStyles();

    const overlay = document.querySelector('[data-isweep-clean-captions="true"]');
    const textNode = overlay?.firstElementChild;
    const nativeContainer = document.querySelector('.ytp-caption-window-container');

    if (!settings.cleanCaptionsEnabled || !overlay || !textNode) {
      if (nativeContainer) nativeContainer.style.visibility = '';
      return;
    }

    const cleanText = maskSelectedText(nativeCaptionText);
    if (cleanText && textNode.textContent !== cleanText) {
      textNode.textContent = cleanText;
    }

    overlay.dataset.isweepRemoteStyle = settings.cleanCaptionStyle;

    const video = getVideo();
    if (video) {
      const rect = video.getBoundingClientRect();
      overlay.style.setProperty('--isweep-caption-left', `${rect.left + (rect.width * settings.cleanCaptionPosition.x)}px`);
      overlay.style.setProperty('--isweep-caption-top', `${rect.top + (rect.height * settings.cleanCaptionPosition.y)}px`);
      overlay.style.setProperty('--isweep-caption-max-width', `${Math.max(rect.width * 0.82, 220)}px`);
    }

    textNode.style.fontSize = settings.cleanCaptionTextSize === 'large'
      ? '1.8rem'
      : settings.cleanCaptionTextSize === 'small' ? '1rem' : '1.4rem';
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
      previousCaptionText = '';
      previousTokens = [];
      updateCleanOverlay('');
      return;
    }

    const tokens = tokenize(text);
    const prefixLength = commonPrefixLength(previousTokens, tokens);
    const matches = findPhraseMatches(tokens, preferences?.words || []);

    maybeRestoreOnCleanWord(tokens);

    if (settings.cleanCaptionWordMuteMode === 'captions_word_mute') {
      const newlyRelevant = matches.filter((match) => match.end >= prefixLength);
      if (newlyRelevant.length) {
        beginMute(newlyRelevant[newlyRelevant.length - 1], tokens, prefixLength);
      }
    }

    updateCleanOverlay(text);
    previousCaptionText = text;
    previousTokens = tokens;
  }

  async function loadState() {
    const values = await chrome.storage.local.get([
      STORAGE_KEYS.PREFS,
      STORAGE_KEYS.CLEAN_CAPTION_SETTINGS,
    ]);
    preferences = normalizePreferences(values[STORAGE_KEYS.PREFS]);
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
