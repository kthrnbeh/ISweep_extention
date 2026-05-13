// ISWEEP COMPONENT: YouTube Caption Listener
// Listens to on-page caption DOM changes, sends text to the background script,
// and applies the returned decision (mute/skip/fast-forward). Safety logic keeps
// mutes aligned to caption changes with a timeout fallback.
(function () {
  'use strict';

  const LOG_PREFIX = '[ISWEEP][YT]';
  const MARKER_LOG_PREFIX = '[ISWEEP][MARKERS]';
  const STORAGE_KEYS = {
    PREFS: 'isweepPreferences',
    CLEAN_CAPTION_SETTINGS: 'isweepCleanCaptionSettings',
    AUDIO_FILTERING_ENABLED: 'audioFilteringEnabled',
  };
  // Track caption text and when it started so we can measure how long words are spoken.
  // Playback-only: ISweep never edits media or captions; it only controls live playback state (mute/unmute/seek/rate).
  let lastCaptionText = '';
  let captionStartTime = null; // When the current caption started; used to time how long it was spoken.
  let videoEl = null;
  let restoreMuteTimeout = null;
  let restoreRateTimeout = null;
  const WORD_PRE_BUFFER_MS = 200; // Lead-in before matched word
  const WORD_POST_BUFFER_MS = 320; // Tail after matched word
  const WORD_GAP_MERGE_MS = 160; // Merge close windows to avoid choppiness
  const WORD_LATENCY_COMPENSATION_MS = 120; // Pull window earlier to compensate caption/render delay
  const DEFAULT_MIN_MUTE_MS = 2000; // Floor for short words (2s target)
  const PROLONGED_WORD_MIN_MUTE_MS = 2400; // Floor for stretched words (~2.4s)
  const MAX_MUTE_MS = 3200; // Hard cap to avoid long mutes (~3.2s)
  const REDACTED_PLACEHOLDER_MUTE_SECONDS = 3; // Fallback mute when captions redact profanity as [ __ ]
  const FALLBACK_PREROLL_SEC = 0.20; // Pull placeholder fallback slightly earlier so mute lands before the spoken word
  const PLACEHOLDER_WORD_PREROLL_SEC = 0.18; // Lead-in targeted to the hidden placeholder word, not the full caption line
  const PLACEHOLDER_BLEED_SEC = 0.08; // Small tail so mute ends near the first clean word boundary
  const MIN_PLACEHOLDER_MUTE_SEC = 0.22; // Prevent too-short windows from missing the redacted word onset
  const MAX_PLACEHOLDER_MUTE_SEC = 0.65; // Cap fallback windows to avoid muting well into clean speech
  const PLACEHOLDER_WORD_ESTIMATED_SEC = 0.30; // Fallback per-word estimate when caption duration is missing
  const FALLBACK_PLACEHOLDER_MAX_DELAY_SEC = 0.45; // Ignore delayed backend placeholder fallbacks once the word onset has already passed
  const REDACTED_PLACEHOLDER_PATTERN = /\[\s*[\u00A0_\s]{2,}\s*\]/; // Matches bracketed underscore placeholders from auto-captions

  const LANGUAGE_KEYWORDS = [
    'fuck', 'fucking', 'fucked',
    'bitch', 'b*tch',
    'shit', 'asshole', 'bastard',
    'damn', 'crap', 'hell'
  ];
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
    const cleaned = Array.from(
      new Set(
        words
          .map((w) => (typeof w === 'string' ? w.trim().toLowerCase() : ''))
          .filter(Boolean)
      )
    );
    const normalizedLang = {
      enabled: lang.enabled !== false,
      action: lang.action || 'mute',
      duration: lang.duration || 4,
      items: cleaned,
    };
    const normalized = {
      enabled: raw.enabled !== false,
      sensitivity: typeof raw.sensitivity === 'number' ? raw.sensitivity : 0.9,
      categories: {
        language: normalizedLang,
        sexual: categories.sexual || {},
        violence: categories.violence || {},
      },
      blocklist: { ...(raw.blocklist || {}), items: cleaned },
    };
    return normalized;
  }

  let lastCaptionWords = [];
  let lastWordTimings = [];
  let previousMuteState = null;
  let isweepMuteActive = false;
  let userWasMutedBeforeIsweepMute = false;
  let lastMuteOwner = 'none';
  let muteEnforceInterval = null;
  let previousRate = null;
  let muteUntilNextCaption = false;
  let muteLockUntilSec = 0; // Active mute window end (seconds, video time)
  let hardRestoreTimeout = null; // Final fail-safe unmute
  let extensionContextInvalidated = false;
  function clearMuteState(reason) {
    if (restoreMuteTimeout) clearTimeout(restoreMuteTimeout);
    if (hardRestoreTimeout) clearTimeout(hardRestoreTimeout);
    if (muteEnforceInterval) clearInterval(muteEnforceInterval);
    restoreMuteTimeout = null;
    hardRestoreTimeout = null;
    muteEnforceInterval = null;
    muteUntilNextCaption = false;
    muteLockUntilSec = 0;
    previousMuteState = null;
    isweepMuteActive = false;
    userWasMutedBeforeIsweepMute = false;
    lastMuteOwner = 'none';
    muteWindowStartSec = null;
    console.log('[ISweep Timing] mute state reset', { reason });
  }

  function isExtensionContextInvalidatedError(error) {
    const text = String(error?.message || error || '').trim().toLowerCase();
    return text.includes('extension context invalidated') || text.includes('receiving end does not exist');
  }

  function stopLocalCaptionTimers(reason) {
    if (restoreMuteTimeout) clearTimeout(restoreMuteTimeout);
    if (hardRestoreTimeout) clearTimeout(hardRestoreTimeout);
    if (muteEnforceInterval) clearInterval(muteEnforceInterval);
    if (markerSchedulerInterval) clearInterval(markerSchedulerInterval);
    if (markerVideoWatchInterval) clearInterval(markerVideoWatchInterval);
    if (bufferTimer) clearTimeout(bufferTimer);
    restoreMuteTimeout = null;
    hardRestoreTimeout = null;
    muteEnforceInterval = null;
    markerSchedulerInterval = null;
    markerVideoWatchInterval = null;
    bufferTimer = null;
    console.log('[ISWEEP][AUDIO_CAPTIONS]', 'local timers stopped', { reason });
  }

  function freezeAudioCaptionOverlay() {
    if (cleanCaptionTextEl) {
      cleanCaptionTextEl.textContent = '';
      cleanCaptionTextEl.style.opacity = '0';
    }
    if (cleanCaptionOverlayEl) {
      cleanCaptionOverlayEl.style.visibility = 'hidden';
      cleanCaptionOverlayEl.style.display = 'none';
      cleanCaptionOverlayEl.dataset.source = 'invalidated';
    }
    lastRenderedCleanCaptionKey = 'invalidated';
    lastRenderedOverlayText = '';
    lastRenderedOverlaySource = 'invalidated';
  }

  function handleExtensionContextInvalidated() {
    if (extensionContextInvalidated) return null;
    extensionContextInvalidated = true;
    console.warn('[ISWEEP][AUDIO_CAPTIONS] extension context invalidated; refresh page required');
    stopLocalCaptionTimers('extension_context_invalidated');
    clearMuteState('extension_context_invalidated');
    try {
      stopAudioCapture('extension_context_invalidated');
    } catch (_) {}
    freezeAudioCaptionOverlay();
    return null;
  }

  async function safeRuntimeSendMessage(message) {
    if (extensionContextInvalidated || !chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
      return handleExtensionContextInvalidated();
    }
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        return handleExtensionContextInvalidated();
      }
      throw error;
    }
  }

  function findMuteButton() {
    return document.querySelector('.ytp-mute-button');
  }

  function getYouTubePlayer() {
    const player = document.getElementById('movie_player');
    if (!player) return null;
    return player;
  }

  function setMutedViaPlayerApi(targetMuted) {
    const player = getYouTubePlayer();
    if (!player || typeof player.isMuted !== 'function') return null;
    try {
      const before = Boolean(player.isMuted());
      if (targetMuted && !before && typeof player.mute === 'function') player.mute();
      if (!targetMuted && before && typeof player.unMute === 'function') player.unMute();
      const after = Boolean(player.isMuted());
      return { before, after, method: 'player_api' };
    } catch (err) {
      console.warn('[ISweep Timing] player api mute failed', err?.message || err);
      return null;
    }
  }

  function setMutedState(targetMuted, reason) {
    const video = findVideo();
    if (!video) return false;

    const apiResult = setMutedViaPlayerApi(targetMuted);
    if (apiResult && Boolean(video.muted) === Boolean(targetMuted)) {
      console.log('[ISweep Timing] mute control', { reason, method: apiResult.method, before: apiResult.before, after: apiResult.after, targetMuted });
      return true;
    }

    const button = findMuteButton();
    if (button && Boolean(video.muted) !== Boolean(targetMuted)) {
      button.click();
    }
    if (Boolean(video.muted) === Boolean(targetMuted)) {
      console.log('[ISweep Timing] mute control', { reason, method: 'button_click', targetMuted });
      return true;
    }

    // Final fallback if YouTube UI API paths fail in this page state.
    video.muted = Boolean(targetMuted);
    if (Boolean(video.muted) === Boolean(targetMuted)) {
      console.log('[ISweep Timing] mute control', { reason, method: 'video_property_fallback', targetMuted });
      return true;
    }

    console.warn('[ISweep Timing] mute control failed', { reason, targetMuted });
    return false;
  }

  function clickMuteButtonTo(targetMuted) {
    const video = findVideo();
    const button = findMuteButton();
    if (!video || !button) return false;
    if (Boolean(video.muted) === Boolean(targetMuted)) return true;
    button.click();
    return Boolean(video.muted) === Boolean(targetMuted);
  }

  function shouldISweepUnmute(previousMutedState) {
    return previousMutedState === false;
  }

  function shouldSkipMuteBecauseUserMuted(videoMuted, activeMuteOwnedByISweep) {
    return Boolean(videoMuted) && !Boolean(activeMuteOwnedByISweep);
  }

  function restoreMuteState(reason) {
    const video = findVideo();
    if (video && previousMuteState !== null && isweepMuteActive && lastMuteOwner === 'isweep') {
      const targetMuted = shouldISweepUnmute(previousMuteState) ? false : true;
      setMutedState(targetMuted, `restore:${reason}`);
      console.log('[ISweep Timing] mute restored', { reason });
    }
    clearMuteState(reason);
  }

  function startMuteEnforcement() {
    if (muteEnforceInterval) return;
    muteEnforceInterval = setInterval(() => {
      const video = findVideo();
      if (!video) return;
      const nowSec = video.currentTime || 0;
      if (muteLockUntilSec <= nowSec) return;
      // Re-apply mute via player control if site logic flips it back.
      if (isweepMuteActive && !video.muted) setMutedState(true, 'enforcement');
    }, 120);
  }

  let muteWindowStartSec = null; // Last applied mute window start
  let captionBuffer = '';
  let bufferTimer = null;
  const BUFFER_DELAY_MS = 150;
  const MUTE_PRE_BUFFER_MS = 180; // Small lead-in before the word
  const MUTE_POST_BUFFER_MS = 280; // Small tail after the word
  const STALE_CAPTION_THRESHOLD_MS = 1200; // Ignore captions too far behind current playhead
  const HARD_RESTORE_GRACE_MS = 500; // Extra margin to force unmute
  const CLEAN_CAPTION_STALE_MS = 1200;
  const CLEAN_CAPTION_LOOKAHEAD_SEC = 0.15;
  const CLEAN_CC_BRIDGE_GAP_MS = 250;
  const CLEAN_CC_FADE_MS = 120;
  const CLEAN_CC_LOG_PREFIX = '[ISWEEP][CAPTIONS]';
  const CLEAN_CC_PLACEHOLDER_TEXT = 'ISweep captions listening...';
  const CLEAN_CC_STT_DISABLED_TEXT = 'ISweep Captions need speech-to-text enabled.';

  // Audio watch-ahead constants.
  const AUDIO_AHEAD_LOG_PREFIX = '[ISWEEP][AUDIO_AHEAD]';
  const AUDIO_LOG_PREFIX = '[ISWEEP][AUDIO]';
  const AUDIO_CAPTURE_LOG_PREFIX = '[ISWEEP][AUDIO_CAPTIONS]';
  const WORD_MUTE_LOG_PREFIX = '[ISWEEP][WORD_MUTE]';
  const FALLBACK_LOG_PREFIX = '[ISWEEP][FALLBACK]';
  const AUDIO_CHUNK_SEC = 2.0;
  const AUDIO_CHUNK_OVERLAP_SEC = 0.5;
  const AUDIO_SAMPLE_RATE = 16000;    // 16 kHz mono — standard for speech recognition
  const MARKER_SCHEDULER_INTERVAL_MS = 100;
  const AUDIO_PREROLL_MS = 120;
  // Audio-derived mute markers already include backend pre-roll, so keep the
  // scheduler lead short and specific to profanity muting.
  const PROFANITY_MARKER_FIRE_EARLY_SEC = AUDIO_PREROLL_MS / 1000;
  const AUDIO_MARKER_FALLBACK_SKIP_WINDOW_SEC = 0.75;

  // Marker engine state. Future audio watch-ahead analyzers can emit the same marker shape.
  let activeVideoId = null;
  let markerEvents = [];
  let firedMarkerIds = new Set();
  let markerSchedulerInterval = null;
  let markerVideoWatchInterval = null;
  let markerModeActive = false;
  let markerFallbackReason = 'scheduler_not_started';
  let markerFallbackLogVideoId = null;
  let markerPastEndLogged = false;

  // Clean caption overlay state.
  const CLEAN_CAPTION_DEFAULTS = {
    cleanCaptionsEnabled: true,
    cleanCaptionStyle: 'transparent_white',
    cleanCaptionTextSize: 'medium',
    cleanCaptionPosition: { x: 0.5, y: 0.8 },
  };
  let cleanCaptionSettings = { ...CLEAN_CAPTION_DEFAULTS };
  let cleanCaptionOverlayEl = null;
  let cleanCaptionTextEl = null;
  let cleanCaptionDragState = null;
  let preAnalyzedCleanCaptions = [];
  let preCachedAudioCleanCaptions = [];
  let liveAudioCleanCaptions = [];
  let lastLiveCaptionObservedAtMs = 0;
  let lastRenderedCleanCaptionKey = '';
  let lastRenderedOverlayText = '';
  let lastRenderedOverlaySource = 'none';
  let lastRenderedOverlayAtMs = 0;
  let cleanCaptionOverlayEnabledLogged = false;
  let cleanCaptionWaitingLogged = false;
  let cleanCaptionNativeWarningLogged = false;
  let lastAppliedCleanCaptionStyle = null;
  let lastAppliedCleanCaptionSize = null;
  let lastAudioCaptionSource = null;
  let lastAudioCaptionText = '';
  let lastAudioCaptionReceivedAtMs = 0;
  let lastAudioCaptionFailureReason = null;

  // Audio watch-ahead state.
  let audioCtx = null;
  let audioProcessor = null;
  let audioSampleBufs = [];    // Float32Arrays accumulated for the current chunk
  let audioChunkWarm = false;
  let audioChunkStartSec = 0; // video.currentTime when the current chunk began
  let audioAheadActive = false;
  let audioAheadVideoId = null;
  let audioCapturePermissionDenied = false; // true after explicit permission denial until user resets capture
  let audioInputStream = null;
  let audioCaptureSource = null;
  let tabAudioCaptureState = 'idle'; // idle|starting|ready|unavailable|stopped
  let audioFilteringEnabled = true;

  function getAudioCaptionMode() {
    const disabledReasons = new Set([
      'stt_disabled',
      'stt_unavailable',
      'transcription_unavailable',
      'audio_pipeline_disabled',
    ]);
    if (lastAudioCaptionSource === 'audio_stt_disabled') return 'stt_disabled';
    if (disabledReasons.has(String(lastAudioCaptionFailureReason || '').trim())) return 'stt_disabled';
    return 'listening';
  }

  function getCurrentVideoId() {
    try {
      const url = new URL(window.location.href);
      return (url.searchParams.get('v') || '').trim();
    } catch (err) {
      return '';
    }
  }

  function normalizeMarkerEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const start = Number(raw.start_seconds);
    const end = Number(raw.end_seconds);
    const duration = Number(raw.duration_seconds);
    if (!Number.isFinite(start) || start < 0) return null;
    const action = String(raw.action || 'none');
    const hasDisplayText = Boolean(getCleanCaptionDisplayText(raw));
    // Some markers are display-only: they carry replacement text for clean captions
    // but do not trigger playback actions like mute/skip/fast_forward. Keep those
    // markers valid so caption cleanup can work independently of playback control.
    if (!['mute', 'skip', 'fast_forward'].includes(action) && !hasDisplayText) return null;
    const computedEnd = Number.isFinite(end) && end > start
      ? end
      : start + (Number.isFinite(duration) && duration > 0 ? duration : 0);
    if (!Number.isFinite(computedEnd) || computedEnd <= start) return null;

    return {
      id: String(raw.id || `${action}-${start}-${computedEnd}`),
      start_seconds: start,
      end_seconds: computedEnd,
      action,
      duration_seconds: computedEnd - start,
      matched_category: raw.matched_category || null,
      reason: raw.reason || '',
      source: raw.source || null,
      text: typeof raw.text === 'string' ? raw.text : null,
      clean_text: typeof raw.clean_text === 'string' ? raw.clean_text : null,
      cleaned_text: typeof raw.cleaned_text === 'string' ? raw.cleaned_text : null,
      caption_text: typeof raw.caption_text === 'string' ? raw.caption_text : null,
      clean_resume_time: Number.isFinite(Number(raw.clean_resume_time))
        ? Number(raw.clean_resume_time)
        : null,
      blocked_word_end: Number.isFinite(Number(raw.blocked_word_end))
        ? Number(raw.blocked_word_end)
        : null,
      blocked_word_start: Number.isFinite(Number(raw.blocked_word_start))
        ? Number(raw.blocked_word_start)
        : null,
      words: normalizeTimedWords(raw.words),
    };
  }

  function isActionableMarker(marker) {
    return Boolean(marker && ['mute', 'skip', 'fast_forward'].includes(marker.action));
  }

  function getCleanCaptionDisplayText(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const cleanCandidates = [entry.clean_text, entry.cleaned_text];
    const cleanMatch = cleanCandidates.find((value) => typeof value === 'string' && value.trim());
      if (cleanMatch) return stripCategoryLabelsFromCaption(cleanMatch.trim());
    const rawCandidates = [entry.caption_text, entry.text];
    const rawMatch = rawCandidates.find((value) => typeof value === 'string' && value.trim());
    if (!rawMatch) return '';
      return stripCategoryLabelsFromCaption(toCleanCaptionText(rawMatch.trim()));
  }

  function normalizeTimedWords(words) {
    if (!Array.isArray(words)) return [];
    return words
      .map((wordEntry) => {
        if (!wordEntry || typeof wordEntry !== 'object') return null;
        const start = Number(wordEntry.start);
        const end = Number(wordEntry.end);
        const word = String(wordEntry.word || '').trim();
        if (!word || !Number.isFinite(start) || !Number.isFinite(end)) return null;
        if (end < start) return null;
        return { word, start, end };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  function getEntryTimingBounds(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const fallbackStart = Number(entry.start_seconds);
    const fallbackEnd = Number(entry.end_seconds);
    const words = normalizeTimedWords(entry.words);

    if (words.length) {
      return {
        start_seconds: words[0].start,
        end_seconds: words[words.length - 1].end,
      };
    }

    if (!Number.isFinite(fallbackStart) || !Number.isFinite(fallbackEnd) || fallbackEnd <= fallbackStart) {
      return null;
    }

    return {
      start_seconds: fallbackStart,
      end_seconds: fallbackEnd,
    };
  }

  function normalizePreAnalyzedCaptions(captions) {
    if (!Array.isArray(captions)) return [];
    return captions
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const start = Number(entry.start_seconds);
        const end = Number(entry.end_seconds);
        const displayText = getCleanCaptionDisplayText(entry);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !displayText) return null;
        return {
          start_seconds: start,
          end_seconds: end,
          text: typeof entry.text === 'string' ? entry.text : displayText,
          clean_text: typeof entry.clean_text === 'string' && entry.clean_text.trim()
            ? entry.clean_text
            : displayText,
          cleaned_text: typeof entry.cleaned_text === 'string' ? entry.cleaned_text : null,
          caption_text: typeof entry.caption_text === 'string' ? entry.caption_text : null,
          clean_resume_time: Number.isFinite(Number(entry.clean_resume_time))
            ? Number(entry.clean_resume_time)
            : null,
          words: normalizeTimedWords(entry.words),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start_seconds - b.start_seconds);
  }

  function buildFromWords(words) {
    if (!Array.isArray(words)) return null;
    const text = words
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        return String(entry.word || entry.text || '').trim();
      })
      .filter(Boolean)
      .join(' ')
      .trim();
    return text || null;
  }

  function extractDisplayText(payload) {
    if (!payload || typeof payload !== 'object') return null;
    return payload.clean_text
      || payload.cleaned_text
      || payload.caption_text
      || payload.text
      || buildFromWords(payload.words)
      || null;
  }

  function buildAudioResponseCaptions(response, fallbackStartSec, fallbackEndSec) {
    const payload = response && typeof response === 'object' ? response : {};
    const normalizedStart = Number.isFinite(Number(payload.start_seconds))
      ? Number(payload.start_seconds)
      : (Number.isFinite(Number(fallbackStartSec)) ? Number(fallbackStartSec) : 0);
    const normalizedEnd = Number.isFinite(Number(payload.end_seconds))
      ? Math.max(Number(payload.end_seconds), normalizedStart)
      : (Number.isFinite(Number(fallbackEndSec)) ? Math.max(Number(fallbackEndSec), normalizedStart) : normalizedStart);

    if (Array.isArray(payload.cleaned_captions) && payload.cleaned_captions.length > 0) {
      return normalizePreAnalyzedCaptions(payload.cleaned_captions);
    }
    if (Array.isArray(payload.clean_captions) && payload.clean_captions.length > 0) {
      return normalizePreAnalyzedCaptions(payload.clean_captions);
    }

    const topLevelText = extractDisplayText(payload);
    const normalizedWords = normalizeTimedWords(payload.words);
    const wordsFallbackText = !topLevelText ? buildFromWords(normalizedWords) : null;
    const displayText = topLevelText || wordsFallbackText || '';
    if (!displayText) return [];

    return normalizePreAnalyzedCaptions([
      {
        start_seconds: normalizedStart,
        end_seconds: normalizedEnd,
        text: typeof payload.text === 'string' ? payload.text : displayText,
        clean_text: typeof payload.clean_text === 'string' ? payload.clean_text : null,
        cleaned_text: typeof payload.cleaned_text === 'string' ? payload.cleaned_text : null,
        caption_text: typeof payload.caption_text === 'string' ? payload.caption_text : null,
        words: normalizedWords,
      },
    ]);
  }

  function findTimedCleanCaptionEntry(entries, nowSec, lookaheadSec = CLEAN_CAPTION_LOOKAHEAD_SEC) {
    if (!Array.isArray(entries) || !Number.isFinite(Number(nowSec))) return null;
    const now = Number(nowSec);
    const exact = entries.find((entry) => {
      const displayText = getCleanCaptionDisplayText(entry);
      const bounds = getEntryTimingBounds(entry);
      return displayText && bounds && now >= bounds.start_seconds && now <= bounds.end_seconds;
    });
    if (exact) return exact;
    return entries.find((entry) => {
      const displayText = getCleanCaptionDisplayText(entry);
      const bounds = getEntryTimingBounds(entry);
      return displayText
        && bounds
        && now >= bounds.start_seconds - lookaheadSec
        && now <= bounds.end_seconds + lookaheadSec;
    }) || null;
  }

  function getBestCleanCaptionText(liveText, nowSec, options = {}) {
    // Priority order: pre-analyzed transcript -> marker text -> audio STT -> live caption fallback.
    const preCachedAudioCaptions = Array.isArray(options.preCachedAudioCaptions)
      ? options.preCachedAudioCaptions
      : preCachedAudioCleanCaptions;
    const liveAudioCaptions = Array.isArray(options.liveAudioCaptions)
      ? options.liveAudioCaptions
      : liveAudioCleanCaptions;
    const preAnalyzedCaptions = Array.isArray(options.preAnalyzedCaptions) ? options.preAnalyzedCaptions : preAnalyzedCleanCaptions;
    const markers = Array.isArray(options.markerEntries) ? options.markerEntries : markerEvents;
    const liveCaptionObservedAtMs = Number.isFinite(Number(options.liveCaptionObservedAtMs))
      ? Number(options.liveCaptionObservedAtMs)
      : lastLiveCaptionObservedAtMs;
    const audioCaptionText = typeof options.audioCaptionText === 'string'
      ? options.audioCaptionText
      : lastAudioCaptionText;
    const audioCaptionSource = typeof options.audioCaptionSource === 'string'
      ? options.audioCaptionSource
      : lastAudioCaptionSource;
    const audioCaptionObservedAtMs = Number.isFinite(Number(options.audioCaptionObservedAtMs))
      ? Number(options.audioCaptionObservedAtMs)
      : lastAudioCaptionReceivedAtMs;
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const lookaheadSec = Number.isFinite(Number(options.lookaheadSec)) ? Number(options.lookaheadSec) : CLEAN_CAPTION_LOOKAHEAD_SEC;
    const staleMs = Number.isFinite(Number(options.staleMs)) ? Number(options.staleMs) : CLEAN_CAPTION_STALE_MS;

    const preAnalyzedEntry = findTimedCleanCaptionEntry(preAnalyzedCaptions, nowSec, lookaheadSec);
    if (preAnalyzedEntry) {
      return {
        text: getCleanCaptionDisplayText(preAnalyzedEntry),
        source: 'pre_analyzed',
        stale: false,
        cleanResumeTime: Number.isFinite(Number(preAnalyzedEntry.clean_resume_time))
          ? Number(preAnalyzedEntry.clean_resume_time)
          : null,
      };
    }

    const markerTextEntry = findTimedCleanCaptionEntry(markers, nowSec, lookaheadSec);
    if (markerTextEntry) {
      return {
        text: getCleanCaptionDisplayText(markerTextEntry),
        source: 'marker_text',
        stale: false,
        cleanResumeTime: Number.isFinite(Number(markerTextEntry.clean_resume_time))
          ? Number(markerTextEntry.clean_resume_time)
          : null,
      };
    }

    const preCachedAudioEntry = findTimedCleanCaptionEntry(preCachedAudioCaptions, nowSec, lookaheadSec);
    if (preCachedAudioEntry) {
      return {
        text: getCleanCaptionDisplayText(preCachedAudioEntry),
        source: 'audio_stt_cached',
        stale: false,
        cleanResumeTime: Number.isFinite(Number(preCachedAudioEntry.clean_resume_time))
          ? Number(preCachedAudioEntry.clean_resume_time)
          : null,
      };
    }

    const liveAudioEntry = findTimedCleanCaptionEntry(liveAudioCaptions, nowSec, lookaheadSec);
    if (liveAudioEntry) {
      return {
        text: getCleanCaptionDisplayText(liveAudioEntry),
        source: 'audio_stt_live',
        stale: false,
        cleanResumeTime: Number.isFinite(Number(liveAudioEntry.clean_resume_time))
          ? Number(liveAudioEntry.clean_resume_time)
          : null,
      };
    }

    const normalizedAudioSource = String(audioCaptionSource || '').toLowerCase();
    const freshAudioText = String(audioCaptionText || '').trim();
    const audioAgeMs = audioCaptionObservedAtMs > 0 ? nowMs - audioCaptionObservedAtMs : Number.POSITIVE_INFINITY;
    if (freshAudioText && normalizedAudioSource.startsWith('audio_stt') && audioAgeMs <= staleMs) {
      return {
        text: freshAudioText,
        source: normalizedAudioSource.includes('cached') ? 'audio_stt_cached' : 'audio_stt_live',
        stale: false,
        cleanResumeTime: null,
      };
    }

    const maskedLiveText = toCleanCaptionText(String(liveText || ''));
    if (maskedLiveText) {
      const isStale = liveCaptionObservedAtMs > 0 && (nowMs - liveCaptionObservedAtMs) > staleMs;
      if (isStale) {
        return {
          text: '',
          source: 'live_masked',
          stale: true,
        };
      }
      return {
        text: maskedLiveText,
        source: 'live_masked',
        stale: false,
        cleanResumeTime: null,
      };
    }

    return {
      text: '',
      source: null,
      stale: false,
      cleanResumeTime: null,
    };
  }

  function resetMarkerEngine(reason) {
    markerEvents = [];
    firedMarkerIds = new Set();
    markerModeActive = false;
    markerFallbackReason = reason || 'reset';
    markerPastEndLogged = false;
    console.log(MARKER_LOG_PREFIX, 'engine reset', { reason });
  }

  function markerSourcePriority(source) {
    const value = String(source || '').toLowerCase();
    if (value.startsWith('audio')) return 0;
    if (value.startsWith('transcript') || value.startsWith('pre')) return 1;
    return 2;
  }

  function shouldDedupAudioMarker(existing, incoming) {
    if (!existing || !incoming) return false;
    if (existing.action !== incoming.action) return false;
    const overlapStart = Math.max(Number(existing.start_seconds) || 0, Number(incoming.start_seconds) || 0);
    const overlapEnd = Math.min(Number(existing.end_seconds) || 0, Number(incoming.end_seconds) || 0);
    if (overlapEnd <= overlapStart) return false;
    const existingDur = Math.max((Number(existing.end_seconds) || 0) - (Number(existing.start_seconds) || 0), 0.001);
    const incomingDur = Math.max((Number(incoming.end_seconds) || 0) - (Number(incoming.start_seconds) || 0), 0.001);
    const overlapDur = overlapEnd - overlapStart;
    const overlapRatio = overlapDur / Math.min(existingDur, incomingDur);
    return overlapRatio >= 0.7;
  }

  function takeTailSampleBuffers(sampleBufs, tailSamples) {
    const target = Math.max(Math.floor(Number(tailSamples) || 0), 0);
    if (!target || !Array.isArray(sampleBufs) || sampleBufs.length === 0) return [];
    const out = [];
    let remaining = target;
    for (let i = sampleBufs.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const buf = sampleBufs[i];
      if (!buf || !buf.length) continue;
      if (buf.length <= remaining) {
        out.unshift(new Float32Array(buf));
        remaining -= buf.length;
      } else {
        out.unshift(new Float32Array(buf.slice(buf.length - remaining)));
        remaining = 0;
      }
    }
    return out;
  }

  function setMarkerEvents(events, source) {
    const normalized = (Array.isArray(events) ? events : [])
      .map(normalizeMarkerEvent)
      .map((event) => (event ? { ...event, source: event.source || source || null } : null))
      .filter(Boolean)
      .sort((a, b) => a.start_seconds - b.start_seconds);
    markerEvents = normalized;
    firedMarkerIds = new Set();
    markerModeActive = markerEvents.length > 0;
    markerFallbackReason = markerModeActive ? 'markers_loaded' : 'marker_list_empty';
    markerFallbackLogVideoId = null;
    markerPastEndLogged = false;
    console.log(MARKER_LOG_PREFIX, 'events loaded', { source, count: markerEvents.length });
    if (!markerModeActive) {
      console.log(MARKER_LOG_PREFIX, 'marker list empty; live caption fallback active', { videoId: activeVideoId });
    }
  }

  function applyMarkerEvent(marker, nowSec) {
    const video = findVideo();
    if (!video) return;

    // ISweep does not edit media; it only applies temporary playback controls and separate overlay captions.

    if (marker.action === 'mute') {
      const muteWindow = getMuteWindowFromMarker(marker);
      const markerStartSec = muteWindow.start_seconds;
      const markerEndSec = muteWindow.end_seconds;
      console.log(WORD_MUTE_LOG_PREFIX, 'applied', {
        id: marker.id,
        source: marker.source || 'unknown',
        blocked_word_start: marker.blocked_word_start || markerStartSec,
        clean_resume_time: marker.clean_resume_time || markerEndSec,
      });
      applyMuteWindow(markerStartSec, markerEndSec, `marker:${marker.id}`);
      console.log(MARKER_LOG_PREFIX, 'marker applied', {
        id: marker.id,
        action: 'mute',
        start: markerStartSec,
        end: markerEndSec,
        clean_resume_time: marker.clean_resume_time || null,
        blocked_word_start: marker.blocked_word_start || null,
        source: marker.source || 'unknown',
      });
      if (String(marker.source || '').toLowerCase().startsWith('audio')) {
        console.log(AUDIO_LOG_PREFIX, 'marker applied', {
          id: marker.id,
          start_seconds: markerStartSec,
          end_seconds: markerEndSec,
          source: marker.source || 'audio',
        });
      }
      if (Number.isFinite(Number(marker.clean_resume_time))) {
        console.log(WORD_MUTE_LOG_PREFIX, 'clean resume', {
          id: marker.id,
          clean_resume_time: marker.clean_resume_time,
        });
      }
      return;
    }

    if (marker.action === 'skip') {
      const jump = Math.max(Number(marker.duration_seconds) || 0, 0);
      if (jump > 0) {
        let targetTime = nowSec + jump;
        if (Number.isFinite(video.duration) && video.duration > 0) {
          targetTime = Math.min(targetTime, Math.max(video.duration - 0.05, 0));
        }
        if (Number.isFinite(targetTime) && targetTime > nowSec) {
          video.currentTime = targetTime;
        }
      }
      console.log(MARKER_LOG_PREFIX, 'marker fired', { id: marker.id, action: 'skip', jump });
      return;
    }

    if (marker.action === 'fast_forward') {
      const durationMs = Math.max((marker.duration_seconds || 0) * 1000, 0);
      if (restoreRateTimeout) clearTimeout(restoreRateTimeout);
      const restoreRate = Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1.0;
      previousRate = restoreRate;
      video.playbackRate = 2.0;
      const rateVideo = video;
      restoreRateTimeout = setTimeout(() => {
        if (rateVideo && typeof rateVideo.playbackRate === 'number') {
          rateVideo.playbackRate = restoreRate;
        }
      }, durationMs || 8000);
      console.log(MARKER_LOG_PREFIX, 'marker fired', { id: marker.id, action: 'fast_forward', durationMs, restoreRate });
    }
  }

  function getMuteWindowFromMarker(marker) {
    const markerStartSec = Math.max(Number(marker && marker.start_seconds) || 0, 0);
    let markerEndSec = Number(marker && marker.end_seconds) || markerStartSec;
    if (Number.isFinite(Number(marker && marker.clean_resume_time))) {
      const resumeSec = Number(marker.clean_resume_time);
      if (resumeSec > markerStartSec) {
        markerEndSec = Math.min(markerEndSec, resumeSec);
      }
    }
    return {
      start_seconds: markerStartSec,
      end_seconds: Math.max(markerEndSec, markerStartSec),
    };
  }

  function tickMarkerScheduler() {
    if (extensionContextInvalidated) return;
    const video = findVideo();
    if (!video) return;
    const nowSec = video.currentTime || 0;

    updateCleanOverlay(lastCaptionText, nowSec);

    if (!markerEvents.length) return;

    markerEvents.forEach((marker) => {
      if (!isActionableMarker(marker)) return;
      if (firedMarkerIds.has(marker.id)) return;
      // Mute markers fire slightly before their start so the
      // audio is silent before the viewer hears the word. Skip/fast_forward
      // fire exactly on-time (earlyWindowSec = 0).
      const earlyWindowSec = getMarkerEarlyWindowSec(marker.action);
      if (!shouldFireMarker(marker, nowSec, firedMarkerIds)) return;
      firedMarkerIds.add(marker.id); // De-dupe: each marker fires at most once.
      console.log(MARKER_LOG_PREFIX, 'marker fired', {
        id: marker.id,
        action: marker.action,
        start_seconds: marker.start_seconds,
        original_start_seconds: marker.start_seconds,
        scheduler_nowSec: +nowSec.toFixed(3),
        lead_time_used: earlyWindowSec,
        leadSec: +(marker.start_seconds - nowSec).toFixed(3),
        source: marker.source || 'unknown',
      });
      applyMarkerEvent(marker, nowSec);
    });

    if (!markerPastEndLogged && markerEvents.length > 0) {
      const last = markerEvents[markerEvents.length - 1];
      if (nowSec > last.end_seconds + 0.25 && firedMarkerIds.size === 0) {
        markerPastEndLogged = true;
        console.warn(MARKER_LOG_PREFIX, 'markers loaded but none fired by end window', {
          videoId: activeVideoId,
          markerCount: markerEvents.length,
          nowSec,
          lastEnd: last.end_seconds,
        });
      }
    }
  }

  function ensureMarkerSchedulerRunning() {
    if (markerSchedulerInterval) return;
    console.log(MARKER_LOG_PREFIX, 'scheduler started', { intervalMs: MARKER_SCHEDULER_INTERVAL_MS });
    markerSchedulerInterval = setInterval(() => {
      tickMarkerScheduler();
    }, MARKER_SCHEDULER_INTERVAL_MS);
  }

  async function analyzeCurrentVideoMarkers(forceRefresh = false) {
    const videoId = getCurrentVideoId();
    if (!videoId) {
      resetMarkerEngine('missing_video_id');
      return;
    }

    try {
      console.log(MARKER_LOG_PREFIX, 'analyze request start', { videoId, forceRefresh });
      const response = await safeRuntimeSendMessage({
        type: 'isweep_markers_analyze',
        video_id: videoId,
        force_refresh: forceRefresh,
      });

      // Ignore stale results that arrive after YouTube SPA navigation changed videos.
      if (activeVideoId !== videoId || getCurrentVideoId() !== videoId) {
        console.log(MARKER_LOG_PREFIX, 'stale analyze result ignored', {
          failure_reason: 'stale_analyze_response_ignored',
          requestVideoId: videoId,
          activeVideoId,
          currentVideoId: getCurrentVideoId(),
        });
        return;
      }

      console.log(MARKER_LOG_PREFIX, 'analyze result', {
        videoId,
        status: response?.status || 'unknown',
        source: response?.source || null,
        events: Array.isArray(response?.events) ? response.events.length : 0,
        failure_reason: response?.failure_reason || null,
      });

      if (!response || response.status !== 'ready') {
        const fallbackReason = response?.failure_reason || `status:${response?.status || 'unknown'}`;
        resetMarkerEngine(fallbackReason);
        preAnalyzedCleanCaptions = [];
        console.log(MARKER_LOG_PREFIX, 'watch-ahead unavailable; live caption fallback active', {
          videoId,
          status: response?.status || 'unknown',
          failure_reason: response?.failure_reason || null,
        });
        return;
      }

      preAnalyzedCleanCaptions = normalizePreAnalyzedCaptions(
        response.cleaned_captions || response.clean_captions || []
      );

      setMarkerEvents(response.events, response.source || 'transcript');
    } catch (err) {
      resetMarkerEngine('analyze_exception');
      console.warn(MARKER_LOG_PREFIX, 'analyze request failed', {
        videoId,
        failure_reason: 'analyze_exception',
        error: err?.message || err,
      });
    }
  }

  // ── Audio watch-ahead helpers ────────────────────────────────────────────

  // Converts a list of Float32Array PCM buffers + sample rate into a raw WAV ArrayBuffer.
  function encodeWAV(sampleBufs, sampleRate) {
    const totalSamples = sampleBufs.reduce((n, b) => n + b.length, 0);
    const dataBytes = totalSamples * 2; // 16-bit
    const out = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(out);
    const w = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };
    w(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true);
    w(8, 'WAVE'); w(12, 'fmt ');
    view.setUint32(16, 16, true);             // PCM chunk size
    view.setUint16(20, 1, true);              // PCM format
    view.setUint16(22, 1, true);              // mono
    view.setUint32(24, sampleRate, true);     // sample rate
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);              // block align
    view.setUint16(34, 16, true);             // bits per sample
    w(36, 'data'); view.setUint32(40, dataBytes, true);
    let offset = 44;
    sampleBufs.forEach((buf) => {
      for (let i = 0; i < buf.length; i++) {
        const s = Math.max(-1, Math.min(1, buf[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    });
    return out;
  }

  // Safely base64-encodes an ArrayBuffer in 8 KB chunks (avoids call-stack overflow).
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const parts = [];
    for (let i = 0; i < bytes.length; i += 8192) {
      parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length))));
    }
    return btoa(parts.join(''));
  }

  function flattenSampleBuffers(sampleBufs) {
    const total = (sampleBufs || []).reduce((sum, buf) => sum + (buf?.length || 0), 0);
    const merged = new Float32Array(total);
    let offset = 0;
    (sampleBufs || []).forEach((buf) => {
      if (!(buf instanceof Float32Array) || !buf.length) return;
      merged.set(buf, offset);
      offset += buf.length;
    });
    return Array.from(merged);
  }

  function stopAudioCapture(reason) {
    if (!audioAheadActive && !audioCtx && !audioInputStream) return;
    audioAheadActive = false;
    if (audioProcessor) {
      try { audioProcessor.disconnect(); } catch (_) {}
      audioProcessor = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
    }
    if (audioInputStream && typeof audioInputStream.getTracks === 'function') {
      audioInputStream.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) {}
      });
    }
    try {
      void safeRuntimeSendMessage({ type: 'isweep_release_tab_capture_stream', reason });
    } catch (_) {}
    audioInputStream = null;
    audioCaptureSource = null;
    audioSampleBufs = [];
    audioAheadVideoId = null;
    if (reason === 'captions_disabled') {
      lastAudioCaptionSource = null;
      lastAudioCaptionText = '';
      lastAudioCaptionReceivedAtMs = 0;
      lastAudioCaptionFailureReason = null;
      audioCapturePermissionDenied = false;
      tabAudioCaptureState = 'idle';
    }
    console.log(AUDIO_AHEAD_LOG_PREFIX, 'audio capture stopped', { reason });
  }

  function classifyCaptureFailure(errorOrMessage) {
    const text = String(errorOrMessage?.message || errorOrMessage || '').trim();
    if (/notallowederror|permission|denied|not allowed/i.test(text)) {
      return 'audio_capture_permission_denied';
    }
    return 'audio_capture_unavailable';
  }

  async function requestTabCaptureAudioStream() {
    console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture start requested', { videoId: activeVideoId });
    let response;
    try {
      response = await safeRuntimeSendMessage({
        type: 'isweep_request_tab_capture_stream',
        video_id: activeVideoId,
      });
    } catch (err) {
      return {
        stream: null,
        failureReason: classifyCaptureFailure(err),
      };
    }

    if (!response?.ok || !response?.streamId) {
      return {
        stream: null,
        failureReason: response?.failure_reason || 'audio_capture_unavailable',
      };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: response.streamId,
          },
        },
        video: false,
      });
      const tracks = typeof stream?.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
      if (!tracks.length) {
        return { stream: null, failureReason: 'audio_capture_unavailable' };
      }
      console.log('[ISWEEP][AUDIO_CAPTIONS] tab capture stream ready', {
        videoId: activeVideoId,
        tracks: tracks.length,
      });
      return { stream, failureReason: null };
    } catch (err) {
      return {
        stream: null,
        failureReason: classifyCaptureFailure(err),
      };
    }
  }

  function requestVideoCaptureStream(video) {
    const captureMethod = typeof video.captureStream === 'function'
      ? 'captureStream'
      : (typeof video.mozCaptureStream === 'function' ? 'mozCaptureStream' : null);
    if (!captureMethod) {
      return { stream: null, failureReason: 'audio_capture_unavailable', captureMethod: null };
    }

    let stream;
    try {
      stream = video[captureMethod]();
    } catch (err) {
      return {
        stream: null,
        failureReason: classifyCaptureFailure(err),
        captureMethod,
      };
    }

    const audioTracks = typeof stream?.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
    if (!audioTracks.length) {
      return {
        stream: null,
        failureReason: 'audio_capture_unavailable',
        captureMethod,
      };
    }

    console.log('[ISWEEP][AUDIO_CAPTIONS] using video.captureStream fallback', {
      videoId: activeVideoId,
      method: captureMethod,
    });
    return {
      stream: new MediaStream(audioTracks),
      failureReason: null,
      captureMethod,
    };
  }

  async function startAudioPipeline(audioStream, sourceLabel, video, captureMethod = null) {
    try {
      audioCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
      console.log(AUDIO_AHEAD_LOG_PREFIX, 'audio context state before resume', {
        state: audioCtx.state,
      });
      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
          console.log(AUDIO_AHEAD_LOG_PREFIX, 'audio context resumed', {
            state: audioCtx.state,
          });
        } catch (err) {
          const reason = classifyCaptureFailure(err);
          stopAudioCapture('resume_failed');
          if (reason === 'audio_capture_permission_denied') {
            audioCapturePermissionDenied = true;
          }
          throw err;
        }
      }
      if (audioCtx.state === 'suspended') {
        stopAudioCapture('context_still_suspended');
        return false;
      }

      const workletUrl = chrome.runtime.getURL('audio_chunk_processor.js');
      console.log(AUDIO_AHEAD_LOG_PREFIX, 'audio worklet load start', { workletUrl });
      await audioCtx.audioWorklet.addModule(workletUrl);
      console.log(AUDIO_AHEAD_LOG_PREFIX, 'audio worklet loaded successfully', { workletUrl });

      const source = audioCtx.createMediaStreamSource(audioStream);
      const workletNode = new AudioWorkletNode(audioCtx, 'audio-chunk-processor');
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;

      workletNode.port.onmessage = (e) => {
        if (!audioAheadActive) return;
        const vid = findVideo();
        if (!vid || vid.paused) return;
        audioSampleBufs.push(new Float32Array(e.data));
        const total = audioSampleBufs.reduce((n, b) => n + b.length, 0);
        const required = (audioChunkWarm ? (AUDIO_CHUNK_SEC - AUDIO_CHUNK_OVERLAP_SEC) : AUDIO_CHUNK_SEC) * audioCtx.sampleRate;
        if (total >= required) flushAudioChunk();
      };

      source.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      audioProcessor = workletNode;
      audioInputStream = audioStream;
      audioCaptureSource = sourceLabel;
      audioAheadActive = true;
      audioAheadVideoId = activeVideoId;
      audioChunkStartSec = video.currentTime || 0;
      audioSampleBufs = [];
      audioChunkWarm = false;
      console.log(AUDIO_CAPTURE_LOG_PREFIX, 'capture started', {
        videoId: activeVideoId,
        chunkSec: AUDIO_CHUNK_SEC,
      });
      console.log(AUDIO_CAPTURE_LOG_PREFIX, 'captions_required=false', {
        videoId: activeVideoId,
      });
      console.log(AUDIO_CAPTURE_LOG_PREFIX, `source=${sourceLabel}`, {
        videoId: activeVideoId,
      });
      console.log(AUDIO_CAPTURE_LOG_PREFIX, 'microphone_used=false', {
        videoId: activeVideoId,
      });
      console.log(AUDIO_AHEAD_LOG_PREFIX, 'audio capture started', {
        videoId: activeVideoId,
        source: sourceLabel,
        method: captureMethod,
        readyState: video.readyState || 0,
        sampleRate: audioCtx.sampleRate,
        chunkSec: AUDIO_CHUNK_SEC,
        processor: 'AudioWorkletNode',
      });
      return true;
    } catch (err) {
      const reason = classifyCaptureFailure(err);
      console.warn(AUDIO_AHEAD_LOG_PREFIX, `failure_reason: ${reason}`, {
        error: err?.message || String(err),
      });
      stopAudioCapture('init_failed');
      if (reason === 'audio_capture_permission_denied') {
        audioCapturePermissionDenied = true;
      }
      return false;
    }
  }

  function flushAudioChunk() {
    if (!audioSampleBufs.length) return;
    const bufs = audioSampleBufs.slice();
    const chunkStartSec = audioChunkStartSec;
    const videoId = audioAheadVideoId;
    if (!videoId) return;

    const sampleRate = audioCtx ? audioCtx.sampleRate : AUDIO_SAMPLE_RATE;
    const sampleCount = bufs.reduce((n, b) => n + b.length, 0);
    const measuredDurationSec = sampleRate > 0 ? (sampleCount / sampleRate) : 0;
    let chunkEndSec = chunkStartSec + measuredDurationSec;

    const video = findVideo();
    const nowSec = video ? (video.currentTime || 0) : chunkEndSec;
    if (Number.isFinite(nowSec) && nowSec > chunkStartSec) {
      // Prefer real playback clock when available; fall back to measured sample duration.
      chunkEndSec = nowSec;
    }
    if (!(chunkEndSec > chunkStartSec)) {
      chunkEndSec = chunkStartSec + Math.max(measuredDurationSec, 0.05);
    }

    const overlapSamples = Math.floor(Math.max(AUDIO_CHUNK_OVERLAP_SEC, 0) * sampleRate);
    const overlapBufs = takeTailSampleBuffers(bufs, overlapSamples);
    const overlapCount = overlapBufs.reduce((n, b) => n + b.length, 0);
    const overlapDurationSec = sampleRate > 0 ? (overlapCount / sampleRate) : 0;
    audioSampleBufs = overlapBufs;
    audioChunkStartSec = Math.max(chunkEndSec - overlapDurationSec, 0);
    audioChunkWarm = true;

    const wavBuf = encodeWAV(bufs, sampleRate);
    const audioChunk = arrayBufferToBase64(wavBuf);
    const audioSamples = flattenSampleBuffers(bufs);
    console.log(AUDIO_AHEAD_LOG_PREFIX, 'chunk ready', {
      videoId, start_seconds: chunkStartSec, end_seconds: chunkEndSec,
      samplesCollected: sampleCount,
      wavBytes: wavBuf.byteLength,
    });
    console.log(AUDIO_CAPTURE_LOG_PREFIX, 'chunk ready', {
      videoId, chunk_start_seconds: chunkStartSec, chunk_end_seconds: chunkEndSec,
    });
    console.log(AUDIO_AHEAD_LOG_PREFIX, 'sending chunk', {
      videoId, start_seconds: chunkStartSec, end_seconds: chunkEndSec,
    });
    console.log(AUDIO_LOG_PREFIX, 'chunk sent', {
      videoId, start_seconds: chunkStartSec, end_seconds: chunkEndSec,
    });
    console.log(AUDIO_CAPTURE_LOG_PREFIX, 'chunk sent', {
      videoId, chunk_start_seconds: chunkStartSec, chunk_end_seconds: chunkEndSec,
    });
    safeRuntimeSendMessage({
      type: 'isweep_audio_chunk',
      video_id: videoId,
      audio_chunk: audioChunk,
      audio: audioSamples,
      sampleRate,
      channels: 1,
      mime_type: 'audio/wav',
      start_seconds: chunkStartSec,
      end_seconds: chunkEndSec,
    }).then((response) => {
      if (!response) {
        console.warn(AUDIO_AHEAD_LOG_PREFIX, 'failure_reason: analyze_exception', {
          videoId, start_seconds: chunkStartSec, end_seconds: chunkEndSec,
        });
        return;
      }
      console.log(AUDIO_CAPTURE_LOG_PREFIX, 'response received', {
        videoId,
        chunk_start_seconds: chunkStartSec,
        chunk_end_seconds: chunkEndSec,
        status: response.status || 'unknown',
      });
      lastAudioCaptionSource = response.source || null;
      lastAudioCaptionFailureReason = response.failure_reason || null;
      if (response.source === 'audio_stt_disabled' || response.failure_reason === 'stt_disabled') {
        console.warn(AUDIO_CAPTURE_LOG_PREFIX, 'STT disabled', {
          videoId,
          failure_reason: response.failure_reason || null,
        });
      }
      if (response.failure_reason === 'backend_not_running') {
        console.warn(AUDIO_CAPTURE_LOG_PREFIX, 'backend offline', { videoId });
      }
      if (typeof response.text === 'string' && response.text.trim()) {
        console.log(AUDIO_CAPTURE_LOG_PREFIX, 'transcript received', {
          videoId,
          textPreview: response.text.slice(0, 80),
        });
      }
      console.log(AUDIO_AHEAD_LOG_PREFIX, 'chunk result', {
        videoId, start_seconds: chunkStartSec, end_seconds: chunkEndSec,
        status: response.status,
        events: Array.isArray(response.events) ? response.events.length : 0,
        failure_reason: response.failure_reason || null,
      });
      if (response.status === 'ready' && Array.isArray(response.events) && response.events.length > 0) {
        ingestAudioMarkers(response.events, videoId);
      }
      const normalizedAudioCaptions = buildAudioResponseCaptions(response, chunkStartSec, chunkEndSec);
      if (response.status === 'ready' && normalizedAudioCaptions.length > 0) {
        if (response.cached === true) {
          preCachedAudioCleanCaptions = normalizedAudioCaptions;
        } else {
          liveAudioCleanCaptions = normalizedAudioCaptions;
        }
        console.log(CLEAN_CC_LOG_PREFIX, 'audio caption stored', {
          source: response.cached === true ? 'audio_stt_cached' : 'audio_stt_live',
          count: normalizedAudioCaptions.length,
        });
      }
      updateCleanOverlay(lastCaptionText, findVideo()?.currentTime || 0);
    }).catch((err) => {
      console.warn(AUDIO_AHEAD_LOG_PREFIX, 'failure_reason: analyze_exception', {
        videoId, start_seconds: chunkStartSec, end_seconds: chunkEndSec,
        error: err?.message || String(err),
      });
      lastAudioCaptionSource = 'audio_stt';
      lastAudioCaptionFailureReason = 'analyze_exception';
      updateCleanOverlay(lastCaptionText, findVideo()?.currentTime || 0);
    });
  }

  function ingestAudioMarkers(newEvents, videoId) {
    if (videoId !== activeVideoId) {
      console.log(AUDIO_AHEAD_LOG_PREFIX, 'failure_reason: stale_audio_response_ignored', {
        responseVideoId: videoId, activeVideoId,
      });
      return;
    }
    const normalized = (Array.isArray(newEvents) ? newEvents : [])
      .map(normalizeMarkerEvent)
      .map((event) => (event ? { ...event, source: event.source || 'audio_stt' } : null))
      .filter(Boolean)
      .filter((e) => !firedMarkerIds.has(e.id));
    if (!normalized.length) return;
    const firedBefore = new Set(firedMarkerIds);
    const merged = [...markerEvents];
    normalized.forEach((e) => {
      const exact = merged.some((m) => m.id === e.id);
      const overlapDup = merged.some((m) => shouldDedupAudioMarker(m, e));
      if (!exact && !overlapDup) merged.push(e);
    });
    merged.sort((a, b) => {
      const delta = a.start_seconds - b.start_seconds;
      if (Math.abs(delta) > 1e-6) return delta;
      return markerSourcePriority(a.source) - markerSourcePriority(b.source);
    });
    markerEvents = merged;
    markerModeActive = markerEvents.length > 0;
    markerFallbackReason = markerModeActive ? 'markers_loaded' : 'marker_list_empty';
    markerFallbackLogVideoId = null;
    firedMarkerIds = firedBefore; // Preserve one-time semantics for already-fired markers.
    console.log(MARKER_LOG_PREFIX, 'events merged', {
      source: 'audio_chunk',
      total: markerEvents.length,
      added: normalized.map((event) => ({
        id: event.id,
        start_seconds: event.start_seconds,
        end_seconds: event.end_seconds,
        source: event.source || 'audio_chunk',
      })),
    });
    console.log(AUDIO_AHEAD_LOG_PREFIX, 'audio markers merged', {
      videoId: activeVideoId,
      addedCount: normalized.length,
      totalCount: markerEvents.length,
    });
    console.log(AUDIO_LOG_PREFIX, 'markers received', {
      videoId: activeVideoId,
      addedCount: normalized.length,
      totalCount: markerEvents.length,
    });
    normalized.forEach((event) => {
      if (event.action === 'mute') {
        console.log(WORD_MUTE_LOG_PREFIX, 'marker scheduled', {
          id: event.id,
          source: event.source || 'audio_stt',
          blocked_word_start: event.blocked_word_start || event.start_seconds,
          clean_resume_time: event.clean_resume_time || event.end_seconds,
        });
      }
    });
  }

  async function startAudioCapture() {
    const video = findVideo();
    console.log(AUDIO_AHEAD_LOG_PREFIX, 'start requested', {
      videoId: activeVideoId,
      hasVideo: Boolean(video),
      audioAheadActive,
      audioCapturePermissionDenied,
      audioFilteringEnabled,
      readyState: video?.readyState ?? null,
      paused: video?.paused ?? null,
      currentTime: video?.currentTime ?? null,
    });
    if (!cleanCaptionSettings.cleanCaptionsEnabled) return;
    if (tabAudioCaptureState === 'starting' || tabAudioCaptureState === 'ready') return;
    if (!video || audioAheadActive || audioCapturePermissionDenied) return;

    const minReadyState = typeof HTMLMediaElement !== 'undefined'
      ? HTMLMediaElement.HAVE_CURRENT_DATA
      : 2;
    if (!video.currentSrc || (video.readyState || 0) < minReadyState) {
      console.log(AUDIO_AHEAD_LOG_PREFIX, 'waiting for video/audio tracks', {
        videoId: activeVideoId,
        readyState: video.readyState || 0,
        currentSrc: video.currentSrc || null,
      });
      return;
    }

    const tabCapture = await requestTabCaptureAudioStream();
    if (tabCapture.stream) {
      await startAudioPipeline(tabCapture.stream, 'tab_capture', video, 'tabCapture');
      return;
    }

    const videoCapture = requestVideoCaptureStream(video);
    if (videoCapture.stream) {
      await startAudioPipeline(videoCapture.stream, 'video_capture_stream', video, videoCapture.captureMethod);
      return;
    }

    const reasons = [tabCapture.failureReason, videoCapture.failureReason].filter(Boolean);
    const finalReason = reasons.includes('audio_capture_permission_denied')
      ? 'audio_capture_permission_denied'
      : 'audio_capture_unavailable';
    if (finalReason === 'audio_capture_permission_denied') {
      audioCapturePermissionDenied = true;
    }
    lastAudioCaptionSource = 'audio_stt';
    lastAudioCaptionFailureReason = finalReason;
    console.warn('[ISWEEP][AUDIO_CAPTIONS] audio_capture_unavailable', {
      videoId: activeVideoId,
      failure_reason: finalReason,
      tab_failure_reason: tabCapture.failureReason || null,
      video_failure_reason: videoCapture.failureReason || null,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────

  function handleVideoIdChange(newVideoId) {
    if (!newVideoId) {
      if (activeVideoId) {
        console.log(MARKER_LOG_PREFIX, 'video id change', { from: activeVideoId, to: null });
      }
      activeVideoId = null;
      preAnalyzedCleanCaptions = [];
      stopAudioCapture('video_id_lost');
      resetMarkerEngine('missing_video_id');
      updateCleanOverlay('', 0);
      return;
    }
    if (newVideoId === activeVideoId) return;
    console.log(MARKER_LOG_PREFIX, 'video id change', { from: activeVideoId, to: newVideoId });
    activeVideoId = newVideoId;
    preAnalyzedCleanCaptions = [];
    preCachedAudioCleanCaptions = [];
    liveAudioCleanCaptions = [];
    lastAudioCaptionSource = null;
    lastAudioCaptionText = '';
    lastAudioCaptionReceivedAtMs = 0;
    lastAudioCaptionFailureReason = null;
    audioCapturePermissionDenied = false; // Reset capture state for navigation changes
    tabAudioCaptureState = 'idle';
    stopAudioCapture('video_changed');
    resetMarkerEngine('video changed');
    analyzeCurrentVideoMarkers(false);
    if (cleanCaptionSettings.cleanCaptionsEnabled) {
      setTimeout(startAudioCapture, 1500); // Give the player 1.5 s to start before capturing
    }
  }

  function startVideoWatchLoop() {
    handleVideoIdChange(getCurrentVideoId());
    if (markerVideoWatchInterval) return;
    console.log(MARKER_LOG_PREFIX, 'video watch loop started', { intervalMs: 1000 });
    markerVideoWatchInterval = setInterval(() => {
      handleVideoIdChange(getCurrentVideoId());
      // Retry audio capture each tick if tracks weren't available on the first attempt.
      if (tabAudioCaptureState !== 'ready' && tabAudioCaptureState !== 'starting' && activeVideoId && cleanCaptionSettings.cleanCaptionsEnabled && !audioAheadActive && !audioCapturePermissionDenied) startAudioCapture();
    }, 1000);
  }

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

  function hasRedactedPlaceholder(text) {
    return REDACTED_PLACEHOLDER_PATTERN.test(text || '');
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
      const store = await chrome.storage.local.get([
        STORAGE_KEYS.PREFS,
        STORAGE_KEYS.AUDIO_FILTERING_ENABLED,
      ]);
      cachedPreferences = store[STORAGE_KEYS.PREFS] || null;
      audioFilteringEnabled = store[STORAGE_KEYS.AUDIO_FILTERING_ENABLED] !== false;
    } catch (err) {
      console.warn('[ISWEEP][MATCH] failed to load prefs', err?.message || err);
      cachedPreferences = null;
      audioFilteringEnabled = true;
    }
  }

  if (typeof chrome !== 'undefined' && chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[STORAGE_KEYS.PREFS]) {
        cachedPreferences = changes[STORAGE_KEYS.PREFS].newValue || null;
      }
      if (changes[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]) {
        const previousSettings = normalizeCleanCaptionSettings(changes[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS].oldValue);
        cleanCaptionSettings = normalizeCleanCaptionSettings(changes[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS].newValue);
        if (!cleanCaptionSettings.cleanCaptionsEnabled) {
          stopAudioCapture('captions_disabled');
        } else {
          if (previousSettings.cleanCaptionsEnabled === false) {
            audioCapturePermissionDenied = false;
          }
          if (tabAudioCaptureState !== 'ready' && tabAudioCaptureState !== 'starting' && activeVideoId && !audioAheadActive && !audioCapturePermissionDenied) {
            startAudioCapture();
          }
        }
        applyCleanCaptionOverlayStyles();
        updateCleanOverlay(lastCaptionText, findVideo()?.currentTime || 0);
      }
      if (changes[STORAGE_KEYS.AUDIO_FILTERING_ENABLED]) {
        audioFilteringEnabled = changes[STORAGE_KEYS.AUDIO_FILTERING_ENABLED].newValue !== false;
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === 'isweep_get_caption_runtime_status') {
        const overlaySource = String(lastRenderedOverlaySource || 'none');
        const status = {
          ok: true,
          cleanCaptionsEnabled: cleanCaptionSettings.cleanCaptionsEnabled !== false,
          overlaySource,
          audioCaptionMode: getAudioCaptionMode(),
          usingAudioStt: overlaySource.startsWith('audio_stt'),
          usingYoutubeFallback: overlaySource === 'live_masked',
        };
        console.log(CLEAN_CC_LOG_PREFIX, 'runtime status reported', status);
        sendResponse(status);
        return true;
      }
      if (message?.type === 'isweep_caption_capture_start') {
        audioCapturePermissionDenied = false;
        tabAudioCaptureState = 'starting';
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === 'isweep_caption_capture_stop') {
        tabAudioCaptureState = 'stopped';
        stopAudioCapture('captions_disabled');
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === 'isweep_tab_audio_capture_status') {
        const state = String(message.state || 'idle');
        tabAudioCaptureState = state;
        if (state === 'ready') {
          stopAudioCapture('tab_capture_external_ready');
          lastAudioCaptionFailureReason = null;
        } else if (state === 'unavailable') {
          lastAudioCaptionFailureReason = message.failure_reason || 'audio_capture_unavailable';
          if (activeVideoId && cleanCaptionSettings.cleanCaptionsEnabled && !audioAheadActive && !audioCapturePermissionDenied) {
            startAudioCapture();
          }
        } else if (state === 'stopped') {
          stopAudioCapture('captions_disabled');
        }
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === 'isweep_audio_caption_text') {
        lastAudioCaptionSource = message.cached === true ? 'audio_stt_cached' : (message.source || 'audio_stt_live');
        lastAudioCaptionText = String(message.text || message.clean_text || message.cleaned_text || '').trim();
        lastAudioCaptionReceivedAtMs = Date.now();
        lastAudioCaptionFailureReason = message.failure_reason || null;
        console.log(CLEAN_CC_LOG_PREFIX, 'audio_stt message received', {
          source: lastAudioCaptionSource,
          textPreview: lastAudioCaptionText.slice(0, 80),
          cached: message.cached === true,
        });
        const startSec = Number.isFinite(Number(message.start_seconds)) ? Number(message.start_seconds) : (findVideo()?.currentTime || 0);
        const endSec = Number.isFinite(Number(message.end_seconds)) ? Number(message.end_seconds) : startSec + 2;
        if (Array.isArray(message.events) && message.events.length > 0) {
          ingestAudioMarkers(message.events, activeVideoId || getCurrentVideoId());
        }
        const normalizedAudioCaptions = buildAudioResponseCaptions({
          status: message.status || 'ready',
          source: message.source || 'audio_stt',
          cleaned_captions: message.cleaned_captions,
          clean_captions: message.clean_captions,
          text: message.text,
          clean_text: message.clean_text,
          cleaned_text: message.cleaned_text,
          words: message.words,
          cached: message.cached === true,
        }, startSec, endSec);
        if (normalizedAudioCaptions.length > 0) {
          if (message.cached === true) {
            preCachedAudioCleanCaptions = normalizedAudioCaptions;
          } else {
            liveAudioCleanCaptions = normalizedAudioCaptions;
          }
          console.log(CLEAN_CC_LOG_PREFIX, 'overlay source', message.cached === true ? 'audio_stt_cached' : 'audio_stt_live');
          updateCleanOverlay(lastCaptionText, findVideo()?.currentTime || 0);
        }
        sendResponse({ ok: true });
        return true;
      }
      if (!message || message.type !== 'isweep_clean_caption_settings_changed') return;
      cleanCaptionSettings = normalizeCleanCaptionSettings(message.settings);
      if (!cleanCaptionSettings.cleanCaptionsEnabled) {
        stopAudioCapture('captions_disabled');
        audioCapturePermissionDenied = false;
      } else {
        audioCapturePermissionDenied = false;
      }
      if (cleanCaptionSettings.cleanCaptionsEnabled && tabAudioCaptureState !== 'ready' && tabAudioCaptureState !== 'starting' && activeVideoId && !audioAheadActive && !audioCapturePermissionDenied) {
        startAudioCapture();
      }
      applyCleanCaptionOverlayStyles();
      updateCleanOverlay(lastCaptionText, findVideo()?.currentTime || 0);
      sendResponse({ ok: true });
      return true;
    });
  }

  async function requestPrefSync() {
    try {
      await safeRuntimeSendMessage({ type: 'isweep_sync_prefs' }); // Pull latest prefs into storage
    } catch (err) {
      console.warn('[ISWEEP][MATCH] pref sync request failed', err?.message || err);
    }
  }

  function getFilterWords() {
    const prefs = normalizePreferences(cachedPreferences);
    const blocklistItems = Array.isArray(prefs?.blocklist?.items) ? prefs.blocklist.items : [];
    const languageItems = Array.isArray(prefs?.categories?.language?.items) ? prefs.categories.language.items : [];
    const customCount = blocklistItems.length;
    const categoryCount = languageItems.length;

    const combined = Array.from(
      new Set(
        [...blocklistItems, ...languageItems]
          .map((item) => normalizeFilterWord(String(item || '')))
          .filter(Boolean)
      )
    );

    if (combined.length) {
      console.log('[ISWEEP][FILTERS]', {
        source: 'prefs',
        count: combined.length,
        customCount,
        categoryCount,
      });
      return { words: combined, source: 'prefs', customCount, categoryCount };
    }
    console.log('[ISWEEP][FILTERS]', {
      source: 'prefs_missing',
      count: 0,
      customCount,
      categoryCount,
      note: 'no saved words loaded; masking uses preferences only',
    });
    return { words: [], source: 'prefs_missing', customCount, categoryCount };
  }

  function normalizeCleanCaptionSettings(raw) {
    const settings = raw && typeof raw === 'object' ? raw : {};
    const style = settings.cleanCaptionStyle === 'white_black' ? 'white_black' : 'transparent_white';
    const textSize = ['small', 'medium', 'large'].includes(settings.cleanCaptionTextSize)
      ? settings.cleanCaptionTextSize
      : 'medium';
    const enabled = settings.cleanCaptionsEnabled !== false;
    let position = { ...CLEAN_CAPTION_DEFAULTS.cleanCaptionPosition };
    if (
      settings.cleanCaptionPosition
      && Number.isFinite(Number(settings.cleanCaptionPosition.x))
      && Number.isFinite(Number(settings.cleanCaptionPosition.y))
    ) {
      const rawX = Number(settings.cleanCaptionPosition.x);
      const rawY = Number(settings.cleanCaptionPosition.y);
      if (rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1) {
        position = { x: rawX, y: rawY };
      } else if (typeof window !== 'undefined' && window.innerWidth > 0 && window.innerHeight > 0) {
        position = {
          x: Math.max(0, Math.min(1, rawX / window.innerWidth)),
          y: Math.max(0, Math.min(1, rawY / window.innerHeight)),
        };
      }
    }
    return {
      cleanCaptionsEnabled: enabled,
      cleanCaptionStyle: style,
      cleanCaptionTextSize: textSize,
      cleanCaptionPosition: position,
    };
  }

  function clampCaptionOverlayBounds(left, top, overlayWidth, overlayHeight) {
    const maxLeft = Math.max(window.innerWidth - overlayWidth - 8, 8);
    const maxTop = Math.max(window.innerHeight - overlayHeight - 8, 8);
    return {
      left: Math.max(8, Math.min(left, maxLeft)),
      top: Math.max(8, Math.min(top, maxTop)),
    };
  }

  function getCaptionOverlayScreenPosition(position, overlayWidth, overlayHeight) {
    const normalized = position || CLEAN_CAPTION_DEFAULTS.cleanCaptionPosition;
    const centeredLeft = window.innerWidth * normalized.x - (overlayWidth / 2);
    const centeredTop = window.innerHeight * normalized.y - (overlayHeight / 2);
    return clampCaptionOverlayBounds(centeredLeft, centeredTop, overlayWidth, overlayHeight);
  }

  function getNormalizedCaptionPosition(left, top, overlayWidth, overlayHeight) {
    const centerX = left + (overlayWidth / 2);
    const centerY = top + (overlayHeight / 2);
    return {
      x: Math.max(0, Math.min(1, centerX / Math.max(window.innerWidth, 1))),
      y: Math.max(0, Math.min(1, centerY / Math.max(window.innerHeight, 1))),
    };
  }

    // Remove category labels and filter metadata from caption text.
    // Ensures the overlay never displays internal ISweep labels like:
    // - profanity, language, sexual, violence, crude, custom, blocked
    // - filter reason, matched_category, or similar metadata strings
    // Replaces category-labeled words with simple underscores only.
    function stripCategoryLabelsFromCaption(text) {
      if (!text || typeof text !== 'string') return text;
      let cleaned = String(text);
    
      // List of category/metadata labels to remove (case-insensitive).
      const categoryLabels = [
        'profanity', 'language', 'sexual', 'violence', 'crude',
        'custom', 'blocked', 'filter.?reason', 'matched.?category',
        'category.?name', 'reason:',
      ];
    
      // Remove category label patterns without stripping the visible placeholder.
      // Handles cases like "[profanity]", "(language)", "sexual___", etc.
      categoryLabels.forEach((label) => {
        // Match category name with surrounding brackets, parens, or directly.
        const pattern = new RegExp(
          `(?:\\[|\\()??${label}(?:\\]|\\))?(?=\\s*___|\\b)`,
          'gi'
        );
        cleaned = cleaned.replace(pattern, '');
      });

      // Normalize any leftover placeholder width without removing it.
      cleaned = cleaned.replace(/_+/g, '___');

      // Tidy spacing left behind after removing metadata labels.
      cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
      cleaned = cleaned.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').trim();

      return cleaned;
    }

  function maskCaptionWord(word) {
    const length = Math.max(String(word || '').replace(/[^A-Za-z0-9']/g, '').length, 3);
    return '_'.repeat(length);
  }

  function toCleanCaptionText(text) {
    const raw = String(text || '');
    if (!raw.trim()) return '';
    const filterMeta = getFilterWords();
    const filters = filterMeta.words || [];
    return raw
      .replace(REDACTED_PLACEHOLDER_PATTERN, '___')
      .replace(/[A-Za-z0-9']+/g, (word) => {
        const normalizedWord = normalizeCaptionWord(word);
        if (!normalizedWord) return word;
        const blocked = filters.some((rawFilter) => {
          const normalizedFilter = normalizeFilterWord(rawFilter);
          if (!normalizedFilter) return false;
          const variants = expandWordFamily(normalizedFilter);
          const regexes = [maskToRegex(normalizedFilter), buildStretchRegex(normalizedFilter)];
          variants.forEach((variant) => {
            if (variant !== normalizedFilter) regexes.push(maskToRegex(variant));
          });
          return regexes.some((regex) => regex.test(normalizedWord));
        });
          return blocked ? '___' : word;
      });
  }

  function applyCleanCaptionOverlayStyles() {
    if (!cleanCaptionOverlayEl || !cleanCaptionTextEl) return;

    cleanCaptionOverlayEl.style.display = cleanCaptionSettings.cleanCaptionsEnabled ? 'block' : 'none';
    cleanCaptionOverlayEl.style.background = cleanCaptionSettings.cleanCaptionStyle === 'white_black'
      ? 'rgba(255, 255, 255, 0.96)'
      : 'rgba(0, 0, 0, 0.30)';
    cleanCaptionTextEl.style.color = cleanCaptionSettings.cleanCaptionStyle === 'white_black' ? '#111111' : '#ffffff';

    const sizeMap = { small: '14px', medium: '18px', large: '24px' };
    cleanCaptionTextEl.style.fontSize = sizeMap[cleanCaptionSettings.cleanCaptionTextSize] || sizeMap.medium;

    if (lastAppliedCleanCaptionStyle !== cleanCaptionSettings.cleanCaptionStyle) {
      lastAppliedCleanCaptionStyle = cleanCaptionSettings.cleanCaptionStyle;
      console.log(CLEAN_CC_LOG_PREFIX, 'style applied', {
        style: cleanCaptionSettings.cleanCaptionStyle,
      });
    }
    if (lastAppliedCleanCaptionSize !== cleanCaptionSettings.cleanCaptionTextSize) {
      lastAppliedCleanCaptionSize = cleanCaptionSettings.cleanCaptionTextSize;
      console.log(CLEAN_CC_LOG_PREFIX, 'size applied', {
        size: cleanCaptionSettings.cleanCaptionTextSize,
      });
    }

    const rect = getCaptionOverlayScreenPosition(
      cleanCaptionSettings.cleanCaptionPosition,
      cleanCaptionOverlayEl.offsetWidth,
      cleanCaptionOverlayEl.offsetHeight
    );
    cleanCaptionOverlayEl.style.left = `${rect.left}px`;
    cleanCaptionOverlayEl.style.top = `${rect.top}px`;
    cleanCaptionOverlayEl.style.bottom = 'auto';
    cleanCaptionOverlayEl.style.transform = 'none';
  }

  function ensureCleanCaptionOverlay() {
    if (cleanCaptionOverlayEl && document.body.contains(cleanCaptionOverlayEl)) {
      applyCleanCaptionOverlayStyles();
      return;
    }

    const existing = document.getElementById('isweep-caption-overlay')
      || document.getElementById('isweep-clean-caption-overlay');
    if (existing) {
      existing.id = 'isweep-caption-overlay';
      cleanCaptionOverlayEl = existing;
      cleanCaptionTextEl = existing.querySelector('.isweep-clean-caption-text');
      applyCleanCaptionOverlayStyles();
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'isweep-caption-overlay';
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.transform = 'none';
    overlay.style.maxWidth = '70vw';
    overlay.style.padding = '10px 14px';
    overlay.style.borderRadius = '10px';
    overlay.style.zIndex = '2147483647';
    overlay.style.cursor = 'grab';
    overlay.style.pointerEvents = 'auto';
    overlay.style.userSelect = 'none';
    overlay.style.webkitUserSelect = 'none';
    overlay.style.touchAction = 'none';
    overlay.style.boxShadow = '0 2px 10px rgba(0,0,0,0.22)';

    const text = document.createElement('div');
    text.className = 'isweep-clean-caption-text';
    text.style.fontWeight = '600';
    text.style.lineHeight = '1.35';
    text.style.textAlign = 'center';
    text.style.letterSpacing = '0.2px';
    text.style.minWidth = '140px';
    text.style.wordBreak = 'break-word';
    text.style.pointerEvents = 'none';
    text.style.opacity = '1';
    text.style.transition = `opacity ${CLEAN_CC_FADE_MS}ms ease`;

    overlay.appendChild(text);
    document.body.appendChild(overlay);
    console.log(CLEAN_CC_LOG_PREFIX, 'overlay created');

    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      overlay.setPointerCapture(event.pointerId);
      const rect = overlay.getBoundingClientRect();
      cleanCaptionDragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      console.log(CLEAN_CC_LOG_PREFIX, 'drag start');
      overlay.style.cursor = 'grabbing';
      overlay.style.transform = 'none';
      overlay.style.bottom = 'auto';
    });

    overlay.addEventListener('pointermove', (event) => {
      if (!cleanCaptionDragState || cleanCaptionDragState.pointerId !== event.pointerId) return;
      const rect = clampCaptionOverlayBounds(
        event.clientX - cleanCaptionDragState.offsetX,
        event.clientY - cleanCaptionDragState.offsetY,
        overlay.offsetWidth,
        overlay.offsetHeight
      );
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
    });

    overlay.addEventListener('pointerup', async (event) => {
      if (!cleanCaptionDragState || cleanCaptionDragState.pointerId !== event.pointerId) return;
      overlay.releasePointerCapture(event.pointerId);
      cleanCaptionDragState = null;
      overlay.style.cursor = 'grab';
      const rect = overlay.getBoundingClientRect();
      cleanCaptionSettings = {
        ...cleanCaptionSettings,
        cleanCaptionPosition: getNormalizedCaptionPosition(rect.left, rect.top, rect.width, rect.height),
      };
      await chrome.storage.local.set({
        [STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]: cleanCaptionSettings,
      });
      console.log(CLEAN_CC_LOG_PREFIX, 'drag saved', {
        position: cleanCaptionSettings.cleanCaptionPosition,
      });
    });

    cleanCaptionOverlayEl = overlay;
    cleanCaptionTextEl = text;
    applyCleanCaptionOverlayStyles();
  }

  function resolveOverlayDisplayState(overlayState, previousState, nowMs, bridgeGapMs = CLEAN_CC_BRIDGE_GAP_MS, options = {}) {
    const cleanCaptionsEnabled = options.cleanCaptionsEnabled !== false;
    const placeholderText = typeof options.placeholderText === 'string' ? options.placeholderText : CLEAN_CC_PLACEHOLDER_TEXT;
    const sttDisabledText = typeof options.sttDisabledText === 'string' ? options.sttDisabledText : CLEAN_CC_STT_DISABLED_TEXT;
    const audioCaptionMode = typeof options.audioCaptionMode === 'string' ? options.audioCaptionMode : 'listening';
    const prior = previousState && typeof previousState === 'object'
      ? previousState
      : { text: '', source: 'none', visible: false, updatedAtMs: 0 };

    if (!cleanCaptionsEnabled) {
      return { text: '', source: 'disabled', visible: false, stale: false, bridged: false };
    }

    if (overlayState.stale) {
      return { text: '', source: 'stale', visible: false, stale: true, bridged: false };
    }

    if (overlayState.text) {
      return {
        text: overlayState.text,
        source: overlayState.source || 'live_masked',
        visible: true,
        stale: false,
        bridged: false,
      };
    }

    const ageMs = Math.max(0, nowMs - Number(prior.updatedAtMs || 0));
    if (prior.visible && prior.text && ageMs <= bridgeGapMs) {
      return {
        text: prior.text,
        source: prior.source || 'bridge',
        visible: true,
        stale: false,
        bridged: true,
      };
    }

    if (audioCaptionMode === 'stt_disabled') {
      return {
        text: sttDisabledText,
        source: 'audio_stt_disabled',
        visible: true,
        stale: false,
        bridged: false,
        waiting: false,
      };
    }

    // No real text available yet — show waiting placeholder so CC can appear
    // immediately without requiring YouTube native captions.
    return {
      text: placeholderText,
      source: 'waiting_audio_text',
      visible: true,
      stale: false,
      bridged: false,
      waiting: true,
    };
  }

  function maybeLogNativeCaptionOverlayWarning() {
    if (cleanCaptionNativeWarningLogged) return;
    const nativeCaptionVisible = Boolean(document.querySelector('.ytp-caption-window-container .ytp-caption-segment'));
    if (!nativeCaptionVisible) return;
    cleanCaptionNativeWarningLogged = true;
    console.log(CLEAN_CC_LOG_PREFIX, 'YouTube captions may still be visible; ISweep overlay is separate');
  }

  function updateCleanOverlay(liveText, nowSec) {
    if (extensionContextInvalidated) return;
    ensureCleanCaptionOverlay();
    if (!cleanCaptionOverlayEl || !cleanCaptionTextEl) return;

    const overlayState = getBestCleanCaptionText(liveText, nowSec);
    const nowMs = Date.now();
    const resolved = resolveOverlayDisplayState(
      overlayState,
      {
        text: lastRenderedOverlayText,
        source: lastRenderedOverlaySource,
        visible: Boolean(lastRenderedOverlayText),
        updatedAtMs: lastRenderedOverlayAtMs,
      },
      nowMs,
      CLEAN_CC_BRIDGE_GAP_MS,
      {
        cleanCaptionsEnabled: cleanCaptionSettings.cleanCaptionsEnabled,
        placeholderText: CLEAN_CC_PLACEHOLDER_TEXT,
        sttDisabledText: CLEAN_CC_STT_DISABLED_TEXT,
        audioCaptionMode: getAudioCaptionMode(),
        audioCaptionText: lastAudioCaptionText,
        audioCaptionSource: lastAudioCaptionSource,
        audioCaptionObservedAtMs: lastAudioCaptionReceivedAtMs,
      },
    );
    const nextKey = `${resolved.source || 'none'}:${resolved.text}`;

    if (resolved.stale) {
      if (lastRenderedCleanCaptionKey !== 'stale') {
        console.log(CLEAN_CC_LOG_PREFIX, 'stale clear', {
          source: overlayState.source || 'live_masked',
          nowSec,
        });
      }
      cleanCaptionTextEl.textContent = '';
      cleanCaptionTextEl.style.opacity = '0';
      cleanCaptionOverlayEl.style.visibility = 'hidden';
      cleanCaptionOverlayEl.dataset.source = 'stale';
      lastRenderedCleanCaptionKey = 'stale';
      lastRenderedOverlayText = '';
      lastRenderedOverlaySource = 'stale';
      lastRenderedOverlayAtMs = nowMs;
    } else if (!resolved.visible) {
      if (lastRenderedCleanCaptionKey !== 'none') {
        console.log(CLEAN_CC_LOG_PREFIX, 'no active caption text', { nowSec });
      }
      cleanCaptionTextEl.textContent = '';
      cleanCaptionTextEl.style.opacity = '0';
      cleanCaptionOverlayEl.style.visibility = 'hidden';
      cleanCaptionOverlayEl.dataset.source = 'none';
      lastRenderedCleanCaptionKey = 'none';
      lastRenderedOverlayText = '';
      lastRenderedOverlaySource = 'none';
      lastRenderedOverlayAtMs = nowMs;
    } else {
      if (!cleanCaptionOverlayEnabledLogged && cleanCaptionSettings.cleanCaptionsEnabled) {
        console.log(CLEAN_CC_LOG_PREFIX, 'overlay enabled');
        cleanCaptionOverlayEnabledLogged = true;
      }

      if (resolved.source === 'waiting_audio_text') {
        if (!cleanCaptionWaitingLogged) {
          console.log(CLEAN_CC_LOG_PREFIX, 'placeholder shown');
          cleanCaptionWaitingLogged = true;
        }
      } else {
        cleanCaptionWaitingLogged = false;
      }

      if (resolved.bridged && lastRenderedCleanCaptionKey !== nextKey) {
        console.log(CLEAN_CC_LOG_PREFIX, 'bridge gap', {
          source: resolved.source,
          bridge_ms: CLEAN_CC_BRIDGE_GAP_MS,
        });
      }

      cleanCaptionTextEl.style.opacity = '0';
      cleanCaptionTextEl.textContent = resolved.text;
      cleanCaptionOverlayEl.style.visibility = 'visible';
      cleanCaptionOverlayEl.dataset.source = resolved.source || 'live_masked';
      if (lastRenderedCleanCaptionKey !== nextKey) {
        const sourceLabel = String(resolved.source || 'live_masked');
        console.log(CLEAN_CC_LOG_PREFIX, 'text updated');
        console.log(CLEAN_CC_LOG_PREFIX, 'overlay text rendered');
        if (resolved.text.includes('___')) {
          console.log('[ISWEEP][CLEAN_CC]', 'masked word rendered', {
            source: resolved.source || 'unknown',
            clean_resume_time: resolved.cleanResumeTime || null,
          });
        }
        if (sourceLabel === 'pre_analyzed') {
          console.log(CLEAN_CC_LOG_PREFIX, 'source pre_analyzed');
        } else if (sourceLabel === 'marker_text') {
          console.log(CLEAN_CC_LOG_PREFIX, 'source marker_text');
        } else if (sourceLabel === 'audio_stt_cached') {
          console.log(CLEAN_CC_LOG_PREFIX, 'source audio_stt_cached');
        } else if (sourceLabel === 'audio_stt_live' || sourceLabel === 'audio_stt') {
          console.log(CLEAN_CC_LOG_PREFIX, 'source audio_stt_live');
        } else if (sourceLabel === 'live_masked') {
          console.log(CLEAN_CC_LOG_PREFIX, 'source live_masked');
        }
        console.log(CLEAN_CC_LOG_PREFIX, 'fade update', {
          source: resolved.source || 'live_masked',
          fade_ms: CLEAN_CC_FADE_MS,
        });
        console.log(CLEAN_CC_LOG_PREFIX, 'overlay source', resolved.source || 'live_masked');
        if (resolved.source !== 'waiting_audio_text') {
          console.log('[ISWEEP][CAPTION_UI] showing:', resolved.text);
        }
      }
      requestAnimationFrame(() => {
        if (extensionContextInvalidated) return;
        if (cleanCaptionTextEl) cleanCaptionTextEl.style.opacity = '1';
      });
      lastRenderedCleanCaptionKey = nextKey;
      lastRenderedOverlayText = resolved.text;
      lastRenderedOverlaySource = resolved.source || 'live_masked';
      lastRenderedOverlayAtMs = nowMs;
      maybeLogNativeCaptionOverlayWarning();
    }

    if (!cleanCaptionSettings.cleanCaptionsEnabled) {
      cleanCaptionOverlayEl.style.display = 'none';
      cleanCaptionOverlayEnabledLogged = false;
      cleanCaptionWaitingLogged = false;
    }
  }

  async function loadCleanCaptionSettingsFromStorage() {
    try {
      const store = await chrome.storage.local.get([STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]);
      cleanCaptionSettings = normalizeCleanCaptionSettings(store[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]);
    } catch (err) {
      console.warn('[ISWEEP][FALLBACK] clean caption settings load failed', err?.message || err);
      cleanCaptionSettings = { ...CLEAN_CAPTION_DEFAULTS };
    }
    ensureCleanCaptionOverlay();
    updateCleanOverlay('', findVideo()?.currentTime || 0);
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

  function countCaptionWords(text) {
    const matches = String(text || '').match(/[A-Za-z0-9']+/g);
    return matches ? matches.length : 0;
  }

  function isWordFilteredByCurrentRules(word) {
    const normalizedWord = normalizeCaptionWord(word);
    if (!normalizedWord) return false;
    const filterMeta = getFilterWords();
    const filters = filterMeta.words || [];
    return filters.some((rawFilter) => {
      const normalizedFilter = normalizeFilterWord(rawFilter);
      if (!normalizedFilter) return false;
      const variants = expandWordFamily(normalizedFilter);
      const regexes = [maskToRegex(normalizedFilter), buildStretchRegex(normalizedFilter)];
      variants.forEach((variant) => {
        if (variant !== normalizedFilter) regexes.push(maskToRegex(variant));
      });
      return regexes.some((regex) => regex.test(normalizedWord));
    });
  }

  function estimatePlaceholderMuteWindow(text, captionStartSec, captionDurationSec, currentVideoTime, source) {
    const rawText = String(text || '');
    const placeholderMatch = REDACTED_PLACEHOLDER_PATTERN.exec(rawText);
    if (!placeholderMatch) return null;

    const beforeText = rawText.slice(0, placeholderMatch.index);
    const afterText = rawText.slice(placeholderMatch.index + placeholderMatch[0].length);
    const beforeWords = beforeText.match(/[A-Za-z0-9']+/g) || [];
    const afterWords = afterText.match(/[A-Za-z0-9']+/g) || [];
    const wordsBeforePlaceholder = beforeWords.length;
    const wordsAfterPlaceholder = afterWords.length;
    const totalWords = Math.max(wordsBeforePlaceholder + 1 + wordsAfterPlaceholder, 1);

    const hasCaptionDuration = Number.isFinite(Number(captionDurationSec)) && Number(captionDurationSec) > 0;
    const estimatedCaptionDurationSec = Math.max(totalWords * PLACEHOLDER_WORD_ESTIMATED_SEC, MAX_PLACEHOLDER_MUTE_SEC);
    const effectiveCaptionDurationSec = hasCaptionDuration
      ? Number(captionDurationSec)
      : estimatedCaptionDurationSec;

    const currentSec = Number.isFinite(Number(currentVideoTime)) ? Number(currentVideoTime) : 0;
    const hasCaptionStart = Number.isFinite(Number(captionStartSec)) && Number(captionStartSec) >= 0;
    const providedCaptionStartSec = hasCaptionStart ? Number(captionStartSec) : null;
    // Immediate placeholder fallback often only knows "now" (detection time), not true caption start.
    // When duration is missing and start ~= now, back-calculate a likely start from word count.
    const startLooksLikeObservationTime = (
      !hasCaptionDuration
      && hasCaptionStart
      && Math.abs(providedCaptionStartSec - currentSec) <= 0.08
    );
    let effectiveCaptionStartSec = startLooksLikeObservationTime
      ? Math.max(currentSec - effectiveCaptionDurationSec, 0)
      : (hasCaptionStart ? providedCaptionStartSec : Math.max(currentSec - effectiveCaptionDurationSec, 0));
    if (!Number.isFinite(effectiveCaptionStartSec)) effectiveCaptionStartSec = 0;

    const estimatedOffsetSec = (wordsBeforePlaceholder / totalWords) * effectiveCaptionDurationSec;
    const estimatedPlaceholderStartSec = Math.max(effectiveCaptionStartSec + estimatedOffsetSec, 0);
    const adjustedStart = Math.max(estimatedPlaceholderStartSec - PLACEHOLDER_WORD_PREROLL_SEC, 0);
    const firstCleanAfterIndex = afterWords.findIndex((word) => !isWordFilteredByCurrentRules(word));
    const hasCleanAfter = firstCleanAfterIndex >= 0;
    const estimatedNextCleanWordStartSec = hasCleanAfter
      ? Math.max(
        effectiveCaptionStartSec + ((wordsBeforePlaceholder + 1 + firstCleanAfterIndex) / totalWords) * effectiveCaptionDurationSec,
        adjustedStart
      )
      : null;

    let muteEndSec = hasCleanAfter
      ? estimatedNextCleanWordStartSec + PLACEHOLDER_BLEED_SEC
      : adjustedStart + MAX_PLACEHOLDER_MUTE_SEC;
    let muteEndSource = hasCleanAfter ? 'clean_word_anchor' : 'short_fallback_duration';

    const minMuteEndSec = adjustedStart + MIN_PLACEHOLDER_MUTE_SEC;
    const maxMuteEndSec = adjustedStart + MAX_PLACEHOLDER_MUTE_SEC;
    if (muteEndSec < minMuteEndSec) {
      muteEndSec = minMuteEndSec;
    }
    if (muteEndSec > maxMuteEndSec) {
      muteEndSec = maxMuteEndSec;
      if (muteEndSource === 'clean_word_anchor') muteEndSource = 'short_fallback_duration';
    }

    return {
      text: rawText,
      source,
      captionStartSec: effectiveCaptionStartSec,
      captionDurationSec: effectiveCaptionDurationSec,
      wordsBeforePlaceholder,
      wordsAfterPlaceholder,
      totalWords,
      estimatedPlaceholderStartSec,
      estimatedNextCleanWordStartSec,
      adjustedStart,
      muteEndSec,
      muteEndSource,
      currentVideoTime: Number.isFinite(Number(currentVideoTime)) ? Number(currentVideoTime) : 0,
    };
  }

  function estimatePlaceholderWordWindow(text, captionStartSec, captionDurationSec, currentVideoTime, source) {
    return estimatePlaceholderMuteWindow(text, captionStartSec, captionDurationSec, currentVideoTime, source);
  }

  function hasNearbyAudioMuteMarker(markers, adjustedStart, muteEndSec, estimatedPlaceholderStartSec) {
    return (Array.isArray(markers) ? markers : []).some((marker) => {
      if (!marker || marker.action !== 'mute' || !String(marker.source || '').toLowerCase().startsWith('audio')) return false;
      const overlapsWindow = marker.start_seconds <= muteEndSec && marker.end_seconds >= adjustedStart;
      const nearStart = Math.abs(marker.start_seconds - estimatedPlaceholderStartSec) <= AUDIO_MARKER_FALLBACK_SKIP_WINDOW_SEC;
      return overlapsWindow || nearStart;
    });
  }

  function getMarkerEarlyWindowSec(action) {
    return action === 'mute' ? PROFANITY_MARKER_FIRE_EARLY_SEC : 0;
  }

  function shouldFireMarker(marker, nowSec, firedIds) {
    if (!marker || !marker.id) return false;
    if (firedIds && typeof firedIds.has === 'function' && firedIds.has(marker.id)) return false;
    const earlyWindowSec = getMarkerEarlyWindowSec(marker.action);
    return nowSec >= marker.start_seconds - earlyWindowSec;
  }

  function rescheduleMuteRestoreTimers(nowSec) {
    const remainingMs = Math.max((muteLockUntilSec - nowSec) * 1000, 0);
    if (restoreMuteTimeout) clearTimeout(restoreMuteTimeout);
    restoreMuteTimeout = setTimeout(() => {
      restoreMuteState('primary timer');
    }, remainingMs);

    clearHardRestore();
    hardRestoreTimeout = setTimeout(() => {
      restoreMuteState('hard restore');
      console.log('[ISweep Timing] hard restore fired', { endSec: muteLockUntilSec });
    }, remainingMs + HARD_RESTORE_GRACE_MS);
  }

  function applyMuteWindow(startSec, endSec, reason) {
    const video = findVideo();
    if (!video) return;

    // Clamp mute windows to avoid over- or under-muting.
    const clampedDurationSec = Math.min(Math.max(endSec - startSec, 0.3), 2.5);
    endSec = startSec + clampedDurationSec;

    const nowSec = video.currentTime || 0;
    // Skip stale windows that already ended
    if (endSec <= nowSec) {
      console.log('[ISweep Timing] skip stale window', { startSec, endSec, nowSec, reason });
      return;
    }

    if (muteLockUntilSec <= nowSec && shouldSkipMuteBecauseUserMuted(video.muted, isweepMuteActive)) {
      userWasMutedBeforeIsweepMute = true;
      lastMuteOwner = 'user';
      console.log(WORD_MUTE_LOG_PREFIX, 'skipped because user muted', {
        start_seconds: startSec,
        end_seconds: endSec,
        reason,
      });
      return;
    }

    // If already muted into a window, ignore fully contained windows; extend only when later
    const durationMs = Math.max((endSec - startSec) * 1000, 0);

    if (muteLockUntilSec > nowSec) {
      const activeStart = muteWindowStartSec ?? -Infinity;
      const insideActive = startSec >= activeStart && endSec <= muteLockUntilSec;
      if (insideActive) {
        console.log('[ISweep Timing] window ignored (inside active)', { startSec, endSec, muteWindowStartSec, muteLockUntilSec, reason });
        return;
      }
      if (endSec > muteLockUntilSec) {
        console.log('[ISweep Timing] extend mute window', {
          prevEnd: muteLockUntilSec,
          newEnd: endSec,
          reason,
          durationMs,
        });
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
      const muteApplied = setMutedState(true, `start:${reason}`);
      if (!muteApplied) return;
      isweepMuteActive = true;
      userWasMutedBeforeIsweepMute = Boolean(previousMuteState);
      lastMuteOwner = 'isweep';
      muteUntilNextCaption = true;
      muteWindowStartSec = startSec;
      console.log('[ISweep Timing] mute start', {
        startSec,
        endSec,
        durationMs,
        wasMuted: previousMuteState,
        reason,
      });
      muteLockUntilSec = endSec;
      startMuteEnforcement();
    }

    // Safety restore timers
    rescheduleMuteRestoreTimers(nowSec);
  }

  function requestPlaceholderFallbackMute(text, captionStartSec, captionDurationSec, currentVideoTime, reason, source) {
    const window = estimatePlaceholderMuteWindow(text, captionStartSec, captionDurationSec, currentVideoTime, source);
    if (!window) return;
    const { adjustedStart, muteEndSec, estimatedPlaceholderStartSec } = window;
    const video = findVideo();
    const nowSec = Number.isFinite(Number(currentVideoTime))
      ? Number(currentVideoTime)
      : (video ? (video.currentTime || 0) : 0);
    const onsetDelaySec = Math.max(nowSec - estimatedPlaceholderStartSec, 0);
    console.log(FALLBACK_LOG_PREFIX, 'placeholder detected', {
      text: window.text,
      captionStartSec: window.captionStartSec,
      captionDurationSec: window.captionDurationSec,
      wordsBeforePlaceholder: window.wordsBeforePlaceholder,
      wordsAfterPlaceholder: window.wordsAfterPlaceholder,
      totalWords: window.totalWords,
      estimatedPlaceholderStartSec,
      estimatedNextCleanWordStartSec: window.estimatedNextCleanWordStartSec,
      adjustedStart,
      muteEndSec,
      muteEndSource: window.muteEndSource,
      currentVideoTime: nowSec,
      source,
      reason,
    });
    if (onsetDelaySec > FALLBACK_PLACEHOLDER_MAX_DELAY_SEC) {
      console.log(FALLBACK_LOG_PREFIX, 'mute skipped', {
        text: window.text,
        captionStartSec: window.captionStartSec,
        captionDurationSec: window.captionDurationSec,
        wordsBeforePlaceholder: window.wordsBeforePlaceholder,
        wordsAfterPlaceholder: window.wordsAfterPlaceholder,
        totalWords: window.totalWords,
        estimatedPlaceholderStartSec,
        estimatedNextCleanWordStartSec: window.estimatedNextCleanWordStartSec,
        adjustedStart,
        muteEndSec,
        muteEndSource: window.muteEndSource,
        currentVideoTime: nowSec,
        onsetDelaySec,
        maxDelaySec: FALLBACK_PLACEHOLDER_MAX_DELAY_SEC,
        source,
        reason,
      });
      return;
    }
    const audioMarkerNearby = hasNearbyAudioMuteMarker(markerEvents, adjustedStart, muteEndSec, estimatedPlaceholderStartSec);
    if (audioMarkerNearby) {
      console.log(FALLBACK_LOG_PREFIX, 'mute skipped', {
        text: window.text,
        captionStartSec: window.captionStartSec,
        captionDurationSec: window.captionDurationSec,
        wordsBeforePlaceholder: window.wordsBeforePlaceholder,
        wordsAfterPlaceholder: window.wordsAfterPlaceholder,
        totalWords: window.totalWords,
        estimatedPlaceholderStartSec,
        estimatedNextCleanWordStartSec: window.estimatedNextCleanWordStartSec,
        adjustedStart,
        muteEndSec,
        muteEndSource: window.muteEndSource,
        currentVideoTime: nowSec,
        source,
        reason,
        skippedBecause: 'audio_marker_exists_nearby',
      });
      return;
    }

    if (
      muteLockUntilSec > nowSec
      && window.muteEndSource === 'clean_word_anchor'
      && muteEndSec > muteLockUntilSec + 0.01
    ) {
      console.log(FALLBACK_LOG_PREFIX, 'mute skipped', {
        text: window.text,
        captionStartSec: window.captionStartSec,
        captionDurationSec: window.captionDurationSec,
        wordsBeforePlaceholder: window.wordsBeforePlaceholder,
        wordsAfterPlaceholder: window.wordsAfterPlaceholder,
        totalWords: window.totalWords,
        estimatedPlaceholderStartSec,
        estimatedNextCleanWordStartSec: window.estimatedNextCleanWordStartSec,
        adjustedStart,
        muteEndSec,
        muteEndSource: window.muteEndSource,
        currentVideoTime: nowSec,
        source,
        reason,
        skippedBecause: 'would_extend_into_clean_speech',
        activeMuteEndSec: muteLockUntilSec,
      });
      return;
    }

    if (
      muteLockUntilSec > nowSec
      && window.muteEndSource === 'clean_word_anchor'
      && muteEndSec < muteLockUntilSec - 0.05
      && muteEndSec > nowSec + 0.05
    ) {
      const prevEnd = muteLockUntilSec;
      muteLockUntilSec = muteEndSec;
      rescheduleMuteRestoreTimers(nowSec);
      console.log(FALLBACK_LOG_PREFIX, 'mute refined', {
        text: window.text,
        captionStartSec: window.captionStartSec,
        captionDurationSec: window.captionDurationSec,
        wordsBeforePlaceholder: window.wordsBeforePlaceholder,
        wordsAfterPlaceholder: window.wordsAfterPlaceholder,
        totalWords: window.totalWords,
        estimatedPlaceholderStartSec,
        estimatedNextCleanWordStartSec: window.estimatedNextCleanWordStartSec,
        adjustedStart,
        previousMuteEndSec: prevEnd,
        muteEndSec,
        muteEndSource: window.muteEndSource,
        currentVideoTime: nowSec,
        source,
        reason,
      });
      return;
    }

    console.log(FALLBACK_LOG_PREFIX, 'mute requested', {
      text: window.text,
      captionStartSec: window.captionStartSec,
      captionDurationSec: window.captionDurationSec,
      wordsBeforePlaceholder: window.wordsBeforePlaceholder,
      wordsAfterPlaceholder: window.wordsAfterPlaceholder,
      totalWords: window.totalWords,
      estimatedPlaceholderStartSec,
      estimatedNextCleanWordStartSec: window.estimatedNextCleanWordStartSec,
      adjustedStart,
      muteEndSec,
      muteEndSource: window.muteEndSource,
      currentVideoTime: nowSec,
      onsetDelaySec,
      source,
      reason,
    });
    applyMuteWindow(adjustedStart, muteEndSec, reason);
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
    const filterMeta = getFilterWords();
    const filters = filterMeta.words || [];

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
            matches.set(idx, { index: idx, baseWord: rawFilter, matchedVariant, prolonged, source: filterMeta.source });
            matchedIndexes.add(idx);
            console.log('[ISWEEP][MATCH]', {
              matchedWord: rawFilter,
              matchedVariant,
              wordIndex: idx,
              source: filterMeta.source,
              caption: captionText || words.join(' '),
              prolonged,
            });
          }
        });
        if (captionForFullTest && regex.test(captionForFullTest)) {
          console.log('[ISWEEP][MATCH]', {
            matchedWord: rawFilter,
            matchedVariant: normalizedFilter,
            wordIndex: -1,
            source: filterMeta.source,
            caption: captionText || words.join(' '),
            prolonged: false,
          });
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
          let startSec = Math.max(captionStart + wt.start - (WORD_PRE_BUFFER_MS + WORD_LATENCY_COMPENSATION_MS) / 1000, 0);
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
      console.log('[ISweep Timing] raw word windows', windows.map((w) => ({ ...w, durationMs: Math.round((w.end - w.start) * 1000) })));
      const merged = mergeWindows(windows);
      console.log('[ISweep Timing] merged word windows', merged.map((w) => ({ ...w, durationMs: Math.round((w.end - w.start) * 1000) })));
      return merged;
    };

    const applyWindows = (windows, reason) => {
      let candidateWindows = windows;
      if (!candidateWindows.length) {
        console.log('[ISweep Timing] no word windows; skip mute fallback', { reason, captionDuration });
        return;
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

    if (action === 'none' && hasRedactedPlaceholder(payload.text)) {
      requestPlaceholderFallbackMute(
        payload.text,
        payload.caption_start_sec,
        payload.caption_duration_seconds,
        nowSec,
        'redacted placeholder',
        'backend'
      );
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
    if (!markerSchedulerInterval) {
      markerFallbackReason = 'scheduler_not_started';
      console.warn(MARKER_LOG_PREFIX, 'fallback to live captions', {
        videoId: activeVideoId,
        reason: markerFallbackReason,
      });
    }

    if (markerModeActive && markerEvents.length > 0) {
      if (markerFallbackLogVideoId !== activeVideoId) {
        markerFallbackLogVideoId = activeVideoId;
        console.log(MARKER_LOG_PREFIX, 'marker mode active; live caption fallback idle', {
          videoId: activeVideoId,
          markerCount: markerEvents.length,
        });
      }
      return;
    }

    if (markerFallbackLogVideoId !== activeVideoId) {
      markerFallbackLogVideoId = activeVideoId;
      console.log(MARKER_LOG_PREFIX, 'fallback to live captions', {
        videoId: activeVideoId,
        reason: markerFallbackReason,
      });
    }

    try {
      const response = await safeRuntimeSendMessage({ type: 'caption', text: payload.text, caption_duration_seconds: payload.caption_duration_seconds })
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
      if (isweepMuteActive && lastMuteOwner === 'isweep') {
        const targetMuted = shouldISweepUnmute(previousMuteState) ? false : true;
        setMutedState(targetMuted, 'caption_change_restore');
        log('Restored mute state on caption change');
      }
    }
    previousMuteState = null;
    isweepMuteActive = false;
    userWasMutedBeforeIsweepMute = false;
    lastMuteOwner = 'none';
    muteUntilNextCaption = false;
    muteLockUntilSec = 0;
    if (muteEnforceInterval) {
      clearInterval(muteEnforceInterval);
      muteEnforceInterval = null;
    }
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
    // Record when a live caption was last seen so getBestCleanCaptionText can ignore stale caption text.
    const now = video && typeof video.currentTime === 'number' ? video.currentTime : null; // Current playback time
    const prevDuration = captionStartTime !== null && now !== null ? Math.max(0, now - captionStartTime) : null; // Duration of previous caption
    let appliedMuteThisCycle = false;
    lastLiveCaptionObservedAtMs = Date.now();

    // Immediate local fallback: when [ __ ] appears, mute right away instead of waiting for backend round-trip.
    if (hasRedactedPlaceholder(text) && now !== null) {
      // Backup path only: estimate hidden-word timing inside this caption line
      // and avoid anchoring mute to full-line start or raw detection time.
      requestPlaceholderFallbackMute(
        text,
        now,
        null,
        now,
        'redacted placeholder immediate',
        'immediate'
      );
      appliedMuteThisCycle = true;
    }

    updateCleanOverlay(text, now || 0);

    // Restore audio on caption change only when this cycle didn't apply a new mute.
    if (!appliedMuteThisCycle) {
      restoreMuteAfterCaptionChange();
    }

    // Send the caption that just ended with its measured duration so backend can align mute timing to words.
    if (lastCaptionText && prevDuration !== null) {
      processEndedCaption(lastCaptionText, prevDuration, now);
    }

    // Start timing the new caption from this moment; its duration will be computed on the next stabilized change.
    lastCaptionText = text;
    captionStartTime = now;
    console.log('[ISweep Timing] caption observed', { text, startSec: now });
  }

  function extractCaptionText() {
    const segments = Array.from(document.querySelectorAll('.ytp-caption-segment')); // Collect caption spans
    if (segments.length === 0) return '';
    return segments.map((el) => el.textContent.trim()).join(' ').trim(); // Join segments into full line
  }

  if (typeof globalThis !== 'undefined' && globalThis.__ISWEEP_TEST_MODE__) {
    globalThis.__ISWEEP_YT_TEST_HOOKS__ = {
      estimatePlaceholderMuteWindow,
      estimatePlaceholderWordWindow,
      getCleanCaptionDisplayText,
      normalizeTimedWords,
      getEntryTimingBounds,
      findTimedCleanCaptionEntry,
      getBestCleanCaptionText,
      getMuteWindowFromMarker,
      shouldISweepUnmute,
      shouldSkipMuteBecauseUserMuted,
      resolveOverlayDisplayState,
      normalizePreAnalyzedCaptions,
      buildAudioResponseCaptions,
      getNormalizedCaptionPosition,
      normalizeCleanCaptionSettings,
      toCleanCaptionText,
      stripCategoryLabelsFromCaption,
      getAudioCaptionMode,
      hasNearbyAudioMuteMarker,
      getMarkerEarlyWindowSec,
      shouldFireMarker,
      shouldDedupAudioMarker,
      markerSourcePriority,
      constants: {
        CLEAN_CAPTION_STALE_MS,
        CLEAN_CAPTION_LOOKAHEAD_SEC,
        CLEAN_CC_BRIDGE_GAP_MS,
        CLEAN_CC_FADE_MS,
        CLEAN_CC_STT_DISABLED_TEXT,
        PLACEHOLDER_WORD_PREROLL_SEC,
        PLACEHOLDER_BLEED_SEC,
        MIN_PLACEHOLDER_MUTE_SEC,
        MAX_PLACEHOLDER_MUTE_SEC,
        PLACEHOLDER_WORD_ESTIMATED_SEC,
        PROFANITY_MARKER_FIRE_EARLY_SEC,
        AUDIO_MARKER_FALLBACK_SKIP_WINDOW_SEC,
        AUDIO_CHUNK_SEC,
        AUDIO_CHUNK_OVERLAP_SEC,
        AUDIO_PREROLL_MS,
      },
      setCachedPreferences: (prefs) => {
        cachedPreferences = prefs || null;
      },
      setMuteOwnershipState: (state = {}) => {
        isweepMuteActive = Boolean(state.isweepMuteActive);
        userWasMutedBeforeIsweepMute = Boolean(state.userWasMutedBeforeIsweepMute);
        lastMuteOwner = state.lastMuteOwner || 'none';
      },
    };
    return;
  }

  const observer = new MutationObserver(() => {
    ensureCleanCaptionOverlay();
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
          lastLiveCaptionObservedAtMs = 0;
        }
      }
      lastCaptionText = '';
      captionStartTime = null;
      lastLiveCaptionObservedAtMs = 0;
      updateCleanOverlay('', 0);
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
    loadCleanCaptionSettingsFromStorage();
    clearMuteState('init');
    ensureMarkerSchedulerRunning();
    startVideoWatchLoop();
    startObserving(); // Begin observing captions
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init); // Wait for DOM if still loading
  } else {
    init(); // DOM ready; start immediately
  }
})();
