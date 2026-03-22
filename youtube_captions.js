// ISWEEP COMPONENT: YouTube Caption Listener
// Listens to on-page caption DOM changes, sends text to the background script,
// and applies the returned decision (mute/skip/fast-forward). Safety logic keeps
// mutes aligned to caption changes with a timeout fallback.
(function () {
  'use strict';

  const LOG_PREFIX = '[ISWEEP][YT]';
  const STORAGE_KEYS = { PREFS: 'isweepPreferences' };
  // Track caption text and when it started so we can measure how long words are spoken.
  // Playback-only: ISweep never edits media or captions; it only controls live playback state (mute/unmute/seek/rate).
  let lastCaptionText = '';
  let captionStartTime = null; // When the current caption started; used to time how long it was spoken.
  let videoEl = null;
  let restoreMuteTimeout = null;
  let restoreRateTimeout = null;
  const WORD_PRE_BUFFER_MS = 160; // Lead-in before matched word
  const WORD_POST_BUFFER_MS = 220; // Tail after matched word
  const WORD_GAP_MERGE_MS = 160; // Merge close windows to avoid choppiness
  const WORD_LATENCY_COMP_MS = 120; // Pull window earlier to compensate caption/render delay
  const DEFAULT_MIN_MUTE_MS = 1000; // Floor for short words
  const PROLONGED_WORD_MIN_MUTE_MS = 1400; // Floor for stretched words
  const MAX_MUTE_MS = 2500; // Hard cap to avoid long mutes

  const LANGUAGE_KEYWORDS = ['hell'];
  const SEXUAL_KEYWORDS = ['sex', 'sexual', 'naked', 'nude', 'explicit', 'rape', 'intercourse', 'seduce', 'seduction'];
  const VIOLENCE_KEYWORDS = ['kill', 'killed', 'murder', 'shot', 'shoot', 'stab', 'blood', 'violence', 'violent', 'attack', 'fight', 'gun', 'weapon', 'death', 'die', 'dying', 'dead', 'assault', 'beat', 'beating', 'punch', 'hit'];
  const WORD_FAMILY_VARIANTS = {
    bitch: ['biiitch', 'biiiitch', 'bitchh', 'bitchhh', 'bitccch', 'biatch'],
    fuck: ['fuk', 'fuuuk', 'fuuuuk', 'fuuuuck', 'fuckk', 'fuckkk'],
    shit: ['shiiit', 'shiiiit', 'shittt'],
    sex: ['sexx', 'sexxx', 'sexy', 'sexual'],
  };

  let cachedPreferences = null;

  function normalizePreferences(prefs) {
    const raw = prefs && typeof prefs === 'object' ? prefs : {};
    const categories = raw.categories && typeof raw.categories === 'object' ? raw.categories : {};
    const lang = categories.language && typeof categories.language === 'object' ? categories.language : {};
    const words = [];
    if (Array.isArray(raw?.blocklist?.items)) words.push(...raw.blocklist.items);
    if (Array.isArray(raw?.customWords)) words.push(...raw.customWords);
    if (Array.isArray(lang.items)) words.push(...lang.items);
    if (Array.isArray(lang.words)) words.push(...lang.words);
    if (Array.isArray(lang.customWords)) words.push(...lang.customWords);
    const cleaned = words.map((w) => (typeof w === 'string' ? w.trim() : '')).filter(Boolean);
    return { ...raw, blocklist: { ...(raw.blocklist || {}), items: cleaned } };
  }

  let lastCaptionWords = [];
  let lastWordTimings = [];
  let previousMuteState = null;
  let previousRate = null;
  let muteUntilNextCaption = false;
  let muteLockUntilSec = 0; // Active mute window end (seconds, video time)
  let hardRestoreTimeout = null; // Final fail-safe unmute
  function clearMuteState(reason) {
    if (restoreMuteTimeout) clearTimeout(restoreMuteTimeout);
    if (hardRestoreTimeout) clearTimeout(hardRestoreTimeout);
    restoreMuteTimeout = null;
    hardRestoreTimeout = null;
    muteUntilNextCaption = false;
    muteLockUntilSec = 0;
    previousMuteState = null;
    muteWindowStartSec = null;
    console.log('[ISweep Timing] mute state reset', { reason });
  }

  function restoreMuteState(reason) {
    const video = findVideo();
    if (video && previousMuteState !== null) {
      video.muted = previousMuteState; // Restore prior mute state
      console.log('[ISweep Timing] mute restored', { reason });
    }
    clearMuteState(reason);
  }

  let muteWindowStartSec = null; // Last applied mute window start
  let captionBuffer = '';
  let bufferTimer = null;
  const BUFFER_DELAY_MS = 150;
  const MUTE_PRE_BUFFER_MS = 120; // Small lead-in before the word
  const MUTE_POST_BUFFER_MS = 150; // Small tail after the word
  const STALE_CAPTION_THRESHOLD_MS = 1200; // Ignore captions too far behind current playhead
  const HARD_RESTORE_GRACE_MS = 500; // Extra margin to force unmute

  function log(...args) {
    console.log(LOG_PREFIX, ...args); // Namespaced logging for debugging
  }

  function normalizeCaptionWord(word) {
    return (word || '').toLowerCase().replace(/[^a-z0-9']/g, '').trim();
  }

  function normalizeCaptionText(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^\w\s']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeFilterWord(word) {
    return (word || '').toLowerCase().replace(/[^\w*\s]/g, '').trim();
  }

  function buildStretchRegex(base) {
    const safe = base.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
    const stretched = safe.replace(/[aeiou]/gi, '$&+');
    const last = safe.slice(-1);
    return new RegExp(`\\b${stretched}${last ? `${last}+` : ''}\\b`, 'i');
  }

  function expandWordFamily(base) {
    const normalized = normalizeFilterWord(base);
    const variants = new Set();
    if (normalized) variants.add(normalized);
    const extras = WORD_FAMILY_VARIANTS[normalized] || [];
    extras.forEach((v) => {
      const nv = normalizeFilterWord(v);
      if (nv) variants.add(nv);
    });
    return Array.from(variants.values());
  }

  function isProlongedVariant(wordNorm, baseNorm) {
    if (!wordNorm || !baseNorm) return false;
    if (wordNorm.length - baseNorm.length >= 2) return true;
    if (/(aa+|ee+|ii+|oo+|uu+)/i.test(wordNorm)) return true;
    if (/([a-z])\1{2,}$/i.test(wordNorm)) return true;
    return false;
  }

  function maskToRegex(word) {
    const escaped = word.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
    const pattern = escaped.replace(/\*/g, '.*');
    return new RegExp(`\\b${pattern}\\b`, 'i');
  }

  async function loadPreferencesFromStorage() {
    try {
      const store = await chrome.storage.local.get([STORAGE_KEYS.PREFS]);
      cachedPreferences = store[STORAGE_KEYS.PREFS] || null;
    } catch (err) {
      console.warn('[ISWEEP][MATCH] failed to load prefs', err?.message || err);
      cachedPreferences = null;
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[STORAGE_KEYS.PREFS]) {
      cachedPreferences = changes[STORAGE_KEYS.PREFS].newValue || null;
    }
  });

  async function requestPrefSync() {
    try {
      await chrome.runtime.sendMessage({ type: 'isweep_sync_prefs' }); // Pull latest prefs into storage
    } catch (err) {
      console.warn('[ISWEEP][MATCH] pref sync request failed', err?.message || err);
    }
  }

  function getFilterWords() {
    const prefs = normalizePreferences(cachedPreferences);
    const blocklist = prefs && typeof prefs === 'object' ? prefs.blocklist : null;
    const languageItems = Array.isArray(prefs?.categories?.language?.items) ? prefs.categories.language.items : [];

    const blocklistEnabled = blocklist && blocklist.enabled !== false;
    const blocklistItems = blocklistEnabled && Array.isArray(blocklist?.items) ? blocklist.items : [];
    const combined = (blocklistItems.length ? blocklistItems : languageItems)
      .map((item) => normalizeFilterWord(String(item || '')))
      .filter(Boolean);
    const hasBMask = combined.some((w) => w.includes('b*'));
    if (combined.length) {
      console.log('[ISWEEP][FILTERS]', { source: blocklistItems.length ? 'prefs.blocklist' : 'prefs.categories.language.items', count: combined.length, hasBMask: hasBMask || combined.includes('bitch'), items: combined });
      return combined;
    }
    const fallback = [...LANGUAGE_KEYWORDS, ...SEXUAL_KEYWORDS, ...VIOLENCE_KEYWORDS].map(normalizeFilterWord).filter(Boolean);
    console.log('[ISWEEP][FILTERS]', { source: 'fallback', count: fallback.length, hasBMask: false, items: fallback });
    return fallback;
  }

  function findVideo() {
    if (videoEl && typeof videoEl.paused !== 'undefined') return videoEl; // Return cached video if still valid
    const candidate = document.querySelector('video'); // Grab first video element
    if (candidate) {
      videoEl = candidate;
      log('Video element attached');
    }
    return videoEl; // May return null if not found yet
  }

  function clearHardRestore() {
    if (hardRestoreTimeout) {
      clearTimeout(hardRestoreTimeout);
      hardRestoreTimeout = null;
    }
  }

  function applyMuteWindow(startSec, endSec, reason) {
    const video = findVideo();
    if (!video) return;

    const nowSec = video.currentTime || 0;
    // Skip stale windows that already ended
    if (endSec <= nowSec) {
      console.log('[ISweep Timing] skip stale window', { startSec, endSec, nowSec, reason });
      return;
    }

    // If already muted into a window, extend end only when later
    if (muteLockUntilSec > nowSec) {
      if (endSec > muteLockUntilSec) {
        console.log('[ISweep Timing] extend mute window', { prevEnd: muteLockUntilSec, newEnd: endSec, reason });
        muteLockUntilSec = endSec;
        if (restoreMuteTimeout) {
          clearTimeout(restoreMuteTimeout);
        }
      } else {
        console.log('[ISweep Timing] within existing mute window; no change', { muteLockUntilSec, reason });
        return;
      }
    } else {
      // New window
      if (previousMuteState === null) {
        previousMuteState = video.muted; // Preserve prior mute state only once
      }
      video.muted = true; // Mute start
      muteUntilNextCaption = true;
      muteWindowStartSec = startSec;
      console.log('[ISweep Timing] mute start', { startSec, endSec, wasMuted: previousMuteState, reason });
      muteLockUntilSec = endSec;
    }

    // Safety restore timers
    const remainingMs = Math.max((muteLockUntilSec - nowSec) * 1000, 0);
    if (restoreMuteTimeout) clearTimeout(restoreMuteTimeout);
    restoreMuteTimeout = setTimeout(() => {
      restoreMuteState('primary timer');
    }, remainingMs);

    // Hard fail-safe to guarantee unmute
    clearHardRestore();
    hardRestoreTimeout = setTimeout(() => {
      restoreMuteState('hard restore');
      console.log('[ISweep Timing] hard restore fired', { endSec });
    }, remainingMs + HARD_RESTORE_GRACE_MS);
  }

  function deriveWordMatches(words, captionText) {
    const matches = new Map();
    const normalizedCaption = normalizeCaptionText(captionText || words.join(' '));
    const sourceWords = Array.isArray(words) && words.length
      ? words
      : (normalizedCaption ? normalizedCaption.split(/\s+/) : []);
    const normalizedWords = sourceWords.map((w) => normalizeCaptionWord(w));
    const originalWords = sourceWords;
    const captionForFullTest = normalizedCaption.replace(/\s+/g, ' ').trim();
    const filters = getFilterWords();

    filters.forEach((rawFilter) => {
      const normalizedFilter = normalizeFilterWord(rawFilter);
      if (!normalizedFilter) return;
      const variants = expandWordFamily(normalizedFilter);
      const regexes = [maskToRegex(normalizedFilter), buildStretchRegex(normalizedFilter)];
      variants.forEach((variant) => {
        if (variant !== normalizedFilter) regexes.push(maskToRegex(variant));
      });

      const matchedIndexes = new Set();

      regexes.forEach((regex) => {
        normalizedWords.forEach((w, idx) => {
          if (!w || matches.has(idx)) return;
          if (regex.test(w)) {
            const matchedVariant = originalWords[idx] || w;
            const prolonged = isProlongedVariant(w, normalizedFilter);
            matches.set(idx, { index: idx, baseWord: rawFilter, matchedVariant, prolonged });
            matchedIndexes.add(idx);
            console.log('[ISWEEP][MATCH]', { caption: captionText || words.join(' '), matchedWord: rawFilter, matchedIndexes: Array.from(matchedIndexes.values()) });
          }
        });
        if (captionForFullTest && regex.test(captionForFullTest)) {
          console.log('[ISWEEP][MATCH]', { caption: captionText || words.join(' '), matchedWord: rawFilter, matchedIndexes: Array.from(matchedIndexes.values()) });
        }
      });
    });

    return Array.from(matches.values());
  }

  function mergeWindows(windows) {
    if (!windows.length) return [];
    windows.sort((a, b) => a.start - b.start);
    const merged = [windows[0]];
    for (let i = 1; i < windows.length; i++) {
      const curr = windows[i];
      const last = merged[merged.length - 1];
      if (curr.start <= last.end + WORD_GAP_MERGE_MS / 1000) {
        last.end = Math.max(last.end, curr.end);
      } else {
        merged.push({ ...curr });
      }
    }
    return merged;
  }

  function applyDecision(decision, payload) {
    // Apply backend decision with timing alignment using caption timing.
    const video = findVideo();
    if (!video) {
      log('No video element found for decision');
      return;
    }

    const action = decision.action || 'none';
    const backendDuration = decision.duration_seconds || 0;
    const nowSec = video.currentTime || 0;

    const words = payload.words || [];
    const wordTimings = payload.word_timings || [];
    const captionStart = payload.caption_start_sec;
    const captionDuration = payload.caption_duration_seconds || backendDuration || 0;
    const matches = deriveWordMatches(words, payload.text);
    if (matches.length) {
      console.log('[ISweep Timing] matched word indexes', matches.map((m) => m.index));
    }

    const buildWindowsFromMatches = () => {
      if (!matches.length) return [];
      if (!wordTimings.length || wordTimings.length !== words.length) return [];
      if (captionStart === null || captionStart === undefined) return [];
      const windows = matches
        .map((match) => {
          const wt = wordTimings[match.index];
          if (!wt) return null;
          let startSec = Math.max(captionStart + wt.start - (WORD_PRE_BUFFER_MS + WORD_LATENCY_COMP_MS) / 1000, 0);
          let endSec = captionStart + wt.end + WORD_POST_BUFFER_MS / 1000;
          if (startSec < nowSec && nowSec < endSec) {
            startSec = Math.max(nowSec - WORD_PRE_BUFFER_MS / 1000, 0); // If word already started, anchor mute to now
          }
          const originalMs = Math.max((endSec - startSec) * 1000, 0);
          const floorMs = match.prolonged ? PROLONGED_WORD_MIN_MUTE_MS : DEFAULT_MIN_MUTE_MS;
          let finalMs = originalMs;
          let reason = '';
          if (finalMs < floorMs) {
            finalMs = floorMs;
            endSec = startSec + finalMs / 1000;
            reason = match.prolonged ? 'prolonged variant floor' : 'floor';
          }
          if (finalMs > MAX_MUTE_MS) {
            finalMs = MAX_MUTE_MS;
            endSec = startSec + finalMs / 1000;
            reason = reason ? `${reason}; max cap` : 'max cap';
          }
          if (reason) {
            console.log('[ISweep Timing] adjusted mute window', {
              originalMs: Math.round(originalMs),
              finalMs: Math.round(finalMs),
              reason,
              baseWord: match.baseWord,
              matchedVariant: match.matchedVariant,
              prolonged: match.prolonged,
            });
          }
          return { start: startSec, end: endSec };
        })
        .filter(Boolean);
      if (!windows.length) return [];
      console.log('[ISweep Timing] raw word windows', windows);
      const merged = mergeWindows(windows);
      console.log('[ISweep Timing] merged word windows', merged);
      return merged;
    };

    const applyWindows = (windows, reason) => {
      let candidateWindows = windows;
      if (!candidateWindows.length) {
        const startSec = captionStart !== null && captionStart !== undefined
          ? Math.max(captionStart - MUTE_PRE_BUFFER_MS / 1000, 0)
          : nowSec;
        const endSec = startSec + captionDuration + MUTE_POST_BUFFER_MS / 1000;
        candidateWindows = [{ start: startSec, end: endSec }];
      }

      candidateWindows.forEach(({ start, end }) => {
        const staleMs = (nowSec - end) * 1000;
        if (staleMs > STALE_CAPTION_THRESHOLD_MS) {
          console.log('[ISweep Timing] stale window skipped', { start, end, nowSec, staleMs });
          return;
        }
        if (muteLockUntilSec > nowSec && end <= muteLockUntilSec && start >= muteWindowStartSec) {
          console.log('[ISweep Timing] window ignored (inside active)', { start, end, muteLockUntilSec });
          return;
        }
        applyMuteWindow(start, end, reason);
      });
    };

    if (action === 'mute') {
      const windows = buildWindowsFromMatches();
      applyWindows(windows, decision.reason || 'caption');
      return;
    }

    if (action === 'none' && matches.length) {
      const windows = buildWindowsFromMatches();
      console.log('[ISWEEP][MATCH]', { caption: payload.text, matchedIndexes: matches.map((m) => m.index), reason: 'local fallback' });
      applyWindows(windows, 'local match');
      return;
    }

    if (action === 'skip') {
      const jump = decision.duration_seconds || 0;
      video.currentTime = nowSec + jump;
      log('Skipped ahead by', decision.duration_seconds, 'seconds');
      return;
    }

    if (action === 'fast_forward') {
      const durationMs = (decision.duration_seconds || 0) * 1000;
      if (restoreRateTimeout) clearTimeout(restoreRateTimeout); // Clear any pending rate restore
      previousRate = video.playbackRate; // Capture current rate
      video.playbackRate = 2.0; // Speed up playback
      log('Fast-forwarding at 2x for', decision.duration_seconds, 'seconds');
      restoreRateTimeout = setTimeout(() => {
        video.playbackRate = previousRate || 1.0; // Restore rate
        log('Restored playback rate');
      }, durationMs || 8000);
      return;
    }

    muteUntilNextCaption = false; // Ensure flag cleared when no action
    log('No action applied');
  }

  async function sendCaption(payload) {
    // Send latest caption text (plus duration hint) to background for /event analysis.
    try {
      const response = await chrome.runtime
        .sendMessage({ type: 'caption', text: payload.text, caption_duration_seconds: payload.caption_duration_seconds })
        .catch((err) => {
          log('Runtime message failed:', err);
          return null;
        });
      if (!response) {
        log('No response for caption');
        return;
      }
      console.log('[ISweep Timing] decision received', response);
      applyDecision(response, payload);
    } catch (err) {
      log('Failed to send caption', err);
    }
  }

  function restoreMuteAfterCaptionChange() {
    // Caption changed: immediately restore audio and clear the safety timeout.
    if (!muteUntilNextCaption) return;
    const video = findVideo();
    if (restoreMuteTimeout) {
      clearTimeout(restoreMuteTimeout); // Cancel safety timer
      restoreMuteTimeout = null;
    }
    clearHardRestore();
    if (video && previousMuteState !== null) {
      video.muted = previousMuteState; // Restore prior mute state
      log('Restored mute state on caption change');
    }
    previousMuteState = null;
    muteUntilNextCaption = false;
    muteLockUntilSec = 0;
  }

  function processEndedCaption(text, durationSeconds, videoTime) {
    if (!text || durationSeconds === null) return; // Require both text and duration
    const words = text.split(/\s+/).filter(Boolean); // Split into words
    // Approximate per-word timing by spreading total caption duration across words; backend still decides whether to mute.
    const wordDuration = words.length > 0 ? durationSeconds / words.length : durationSeconds;
    const wordTimings = words.map((word, index) => ({
      word,
      index,
      start: index * wordDuration,
      end: (index + 1) * wordDuration
    }));
    console.log('[ISWEEP][CAPTION]', {
      text,
      duration: Number(durationSeconds || 0),
      words: words.length,
      wordDuration,
      videoTime
    });
    // Scheduling metadata for debugging: shows where each word likely lands inside the caption window.
    console.log('[ISWEEP][WORD_TIMING]', {
      text,
      captionDuration: durationSeconds,
      words: wordTimings
    });
    const startSec = videoTime !== null ? Math.max(videoTime - durationSeconds, 0) : null;
    lastCaptionWords = words;
    lastWordTimings = wordTimings;
    sendCaption({ text, caption_duration_seconds: durationSeconds, caption_start_sec: startSec, words, word_timings: wordTimings }); // Send ended caption with timing
  }

  function processBufferedCaption(rawText) {
    // YouTube captions arrive incrementally; buffer small DOM updates so we react to stabilized phrases instead of partial words.
    const text = (rawText || '').trim();
    if (!text || text.length < 2 || text === lastCaptionText) return; // Ignore empty/short/duplicate

    const video = findVideo();
    const now = video && typeof video.currentTime === 'number' ? video.currentTime : null; // Current playback time
    const prevDuration = captionStartTime !== null && now !== null ? Math.max(0, now - captionStartTime) : null; // Duration of previous caption

    // Restore audio immediately when the caption changes; safety timeout is only a fallback.
    restoreMuteAfterCaptionChange();

    // Send the caption that just ended with its measured duration so backend can align mute timing to words.
    if (lastCaptionText && prevDuration !== null) {
      processEndedCaption(lastCaptionText, prevDuration, now);
    }

    // Start timing the new caption from this moment; its duration will be computed on the next stabilized change.
    lastCaptionText = text;
    captionStartTime = now;
    log('Caption started:', text);
  }

  function extractCaptionText() {
    const segments = Array.from(document.querySelectorAll('.ytp-caption-segment')); // Collect caption spans
    if (segments.length === 0) return '';
    return segments.map((el) => el.textContent.trim()).join(' ').trim(); // Join segments into full line
  }

  const observer = new MutationObserver(() => {
    const caption = extractCaptionText();

    // If captions disappear, flush the final caption immediately and restore audio; empty snapshots should not debounce.
    if (!caption) {
      if (lastCaptionText && captionStartTime !== null) {
        const video = findVideo();
        const now = video && typeof video.currentTime === 'number' ? video.currentTime : null;
        const durationSeconds = now !== null ? Math.max(0, now - captionStartTime) : null;
        if (durationSeconds !== null) {
          console.log('[ISWEEP][CAPTION_FLUSH]', {
            text: lastCaptionText,
            duration: Number(durationSeconds || 0),
            reason: 'caption disappeared'
          });
          processEndedCaption(lastCaptionText, durationSeconds, now);
          // A disappearing caption is a boundary; restore audio immediately and rely on safety only as fallback.
          restoreMuteAfterCaptionChange();
        }
      }
      lastCaptionText = '';
      captionStartTime = null;
      captionBuffer = '';
      if (bufferTimer) {
        clearTimeout(bufferTimer);
        bufferTimer = null;
      }
      return;
    }

    // YouTube fires mutations with full caption snapshots; appending them duplicates text and breaks timing.
    // Keep only the latest observed caption and debounce processing to wait for a stabilized line.
    captionBuffer = caption;

    if (bufferTimer) clearTimeout(bufferTimer); // Reset debounce timer
    bufferTimer = setTimeout(() => {
      if (captionBuffer) {
        processBufferedCaption(captionBuffer);
      }
      captionBuffer = '';
      bufferTimer = null;
    }, BUFFER_DELAY_MS);
  });

  function startObserving() {
    // Observe the YouTube caption container instead of the whole DOM to cut down on noisy mutations and improve performance.
    const captionsRoot = document.querySelector('.ytp-caption-window-container');
    if (!captionsRoot) {
      setTimeout(startObserving, 1000); // Retry until captions container appears (e.g., when captions are toggled on).
      return;
    }
    observer.observe(captionsRoot, { childList: true, subtree: true }); // Watch caption container for changes
    log('Caption observer attached to caption container');
  }

  function init() {
    const video = findVideo(); // Cache video element if present
    if (video) {
      video.addEventListener('seeking', () => {
        restoreMuteState('seek');
      });
      video.addEventListener('ended', () => {
        restoreMuteState('ended');
      });
    }
    loadPreferencesFromStorage();
    requestPrefSync(); // Refresh prefs on load so blocklist/custom words propagate
    clearMuteState('init');
    startObserving(); // Begin observing captions
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init); // Wait for DOM if still loading
  } else {
    init(); // DOM ready; start immediately
  }
})();
