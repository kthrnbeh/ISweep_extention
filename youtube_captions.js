// ISWEEP COMPONENT: YouTube Caption Listener
// Listens to on-page caption DOM changes, sends text to the background script,
// and applies the returned decision (mute/skip/fast-forward). Safety logic keeps
// mutes aligned to caption changes with a timeout fallback.
(function () {
  'use strict';

  const ISWEEP_CAPTION_REPAIR_VERSION = 'v5-selected-word-remote-mute';
  console.log('[ISWEEP][CAPTION_REPAIR]', ISWEEP_CAPTION_REPAIR_VERSION, 'loaded');

  const LOG_PREFIX = '[ISWEEP][YT]';
  const MARKER_LOG_PREFIX = '[ISWEEP][MARKERS]';
  const STORAGE_KEYS = {
    PREFS: 'isweepPreferences',
    CLEAN_CAPTION_SETTINGS: 'isweepCleanCaptionSettings',
    AUDIO_FILTERING_ENABLED: 'audioFilteringEnabled',
    LOCAL_REFERENCES: 'isweepLocalReferences',
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

  // Do not render raw page/STT text through the ISweep overlay until the
  // extension preference snapshot has arrived. Native captions remain
  // visible during this initialization window and are hidden only after a
  // filtered replacement is ready.
  let cachedPreferencesReady = typeof chrome === 'undefined' || !chrome.storage?.local;
  let cachedPreferences = null;
  let cachedLocalReferences = {};

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
  let muteControlInProgress = 0;
  let suppressMuteChangeEventsUntilMs = 0;
  let muteStateVideo = null;
  let muteStateVolumeHandler = null;
  let userChangedMuteDuringWindow = false;

  function watchVideoMuteChanges(video) {
    if (!video || typeof video.addEventListener !== 'function') return;
    if (muteStateVideo === video) return;
    if (muteStateVideo && muteStateVolumeHandler && typeof muteStateVideo.removeEventListener === 'function') {
      muteStateVideo.removeEventListener('volumechange', muteStateVolumeHandler);
    }
    muteStateVideo = video;
    muteStateVolumeHandler = () => {
      if (muteControlInProgress > 0 || Date.now() <= suppressMuteChangeEventsUntilMs) return;
      // volumechange also fires for ordinary volume-slider changes. Only
      // release ISweep's ownership when the user actually unmutes the video.
      if (isweepMuteActive && !Boolean(video.muted)) {
        userChangedMuteDuringWindow = true;
        lastMuteOwner = 'user';
        console.log('[ISWEEP][WORD_MUTE] user changed mute during ISweep window; playback ownership released');
      }
    };
    video.addEventListener('volumechange', muteStateVolumeHandler);
  }

  function clearMuteState(reason) {
    if (restoreMuteTimeout) clearTimeout(restoreMuteTimeout);
    if (hardRestoreTimeout) clearTimeout(hardRestoreTimeout);
    if (muteEnforceInterval) clearInterval(muteEnforceInterval);
    if (pageSelectedWordMuteTimer) clearTimeout(pageSelectedWordMuteTimer);
    restoreMuteTimeout = null;
    hardRestoreTimeout = null;
    muteEnforceInterval = null;
    pageSelectedWordMuteTimer = null;
    muteUntilNextCaption = false;
    muteLockUntilSec = 0;
    previousMuteState = null;
    isweepMuteActive = false;
    userWasMutedBeforeIsweepMute = false;
    lastMuteOwner = 'none';
    muteWindowStartSec = null;
    userChangedMuteDuringWindow = false;
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
    if (captionVideoWatchInterval) clearInterval(captionVideoWatchInterval);
    if (bufferTimer) clearTimeout(bufferTimer);
    restoreMuteTimeout = null;
    hardRestoreTimeout = null;
    muteEnforceInterval = null;
    markerSchedulerInterval = null;
    markerVideoWatchInterval = null;
    captionVideoWatchInterval = null;
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

    watchVideoMuteChanges(video);
    muteControlInProgress += 1;
    try {
      const apiResult = setMutedViaPlayerApi(targetMuted);
      if (apiResult && Boolean(video.muted) === Boolean(targetMuted)) {
        console.log('[ISweep Timing] mute control', {
          reason,
          method: apiResult.method,
          before: apiResult.before,
          after: apiResult.after,
          targetMuted
        });
        return true;
      }

      const button = findMuteButton();
      if (button && Boolean(video.muted) !== Boolean(targetMuted)) {
        button.click();
      }
      if (Boolean(video.muted) === Boolean(targetMuted)) {
        console.log('[ISweep Timing] mute control', {
          reason,
          method: 'button_click',
          targetMuted
        });
        return true;
      }

      // Final fallback if YouTube UI API paths fail in this page state.
      video.muted = Boolean(targetMuted);
      if (Boolean(video.muted) === Boolean(targetMuted)) {
        console.log('[ISweep Timing] mute control', {
          reason,
          method: 'video_property_fallback',
          targetMuted
        });
        return true;
      }

      console.warn('[ISweep Timing] mute control failed', { reason, targetMuted });
      return false;
    } finally {
      muteControlInProgress = Math.max(muteControlInProgress - 1, 0);
      suppressMuteChangeEventsUntilMs = Date.now() + 100;
    }
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
    if (video && previousMuteState !== null && isweepMuteActive
      && lastMuteOwner === 'isweep' && !userChangedMuteDuringWindow) {
      const targetMuted = shouldISweepUnmute(previousMuteState) ? false : true;
      setMutedState(targetMuted, `restore:${reason}`);
      console.log('[ISweep Timing] mute restored', { reason });
      console.log('[ISWEEP][WORD_MUTE] mute end', {
        reason,
        restore_to_muted: targetMuted,
      });
    } else if (userChangedMuteDuringWindow) {
      console.log('[ISWEEP][WORD_MUTE] restore skipped after user mute change', { reason });
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
      if (userChangedMuteDuringWindow) return;
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
  const CAPTION_LATENCY_LOG = '[ISWEEP][CAPTION_LATENCY]';

  // Audio watch-ahead constants.
  const AUDIO_AHEAD_LOG_PREFIX = '[ISWEEP][AUDIO_AHEAD]';
  const AUDIO_LOG_PREFIX = '[ISWEEP][AUDIO]';
  const AUDIO_CAPTURE_LOG_PREFIX = '[ISWEEP][AUDIO_CAPTIONS]';
  const WORD_MUTE_LOG_PREFIX = '[ISWEEP][WORD_MUTE]';
  const FALLBACK_LOG_PREFIX = '[ISWEEP][FALLBACK]';
  const AUDIO_CHUNK_SEC = 3.0;
  const AUDIO_CHUNK_OVERLAP_SEC = 0.5;
  const AUDIO_SAMPLE_RATE = 16000;    // 16 kHz mono — standard for speech recognition
  const WORD_MUTE_PRE_PAD_SEC = 0.08;
  const WORD_MUTE_POST_PAD_SEC = 0.12;

  // Step 2 remote-control mute:
  // When a newly appearing selected word is observed in the trusted YouTube/page
  // caption stream, mute immediately for a tight window. This never edits media.
  const PAGE_SELECTED_WORD_MUTE_MIN_SEC = 0.28;
  const PAGE_SELECTED_WORD_MUTE_MAX_SEC = 0.8;
  const PAGE_SELECTED_WORD_MUTE_DEFAULT_WORD_SEC = 0.30;
  const PAGE_SELECTED_WORD_MUTE_RETRIGGER_MS = 900;

  const MARKER_SCHEDULER_INTERVAL_MS = 100;
  const WATCH_AHEAD_SECONDS = 30;
  const AUDIO_PREROLL_MS = 120;
  // Audio-derived mute markers already include backend pre-roll, so keep the
  // scheduler lead short and specific to profanity muting.
  const PROFANITY_MARKER_FIRE_EARLY_SEC = AUDIO_PREROLL_MS / 1000;
  const AUDIO_MARKER_FALLBACK_SKIP_WINDOW_SEC = 0.75;
  const ISWEEP_AUDIO_STT_PRIMARY = false;

  // Recovery rule: visible/timed page captions are allowed to drive the overlay.
  // Raw live STT is only displayed after it agrees with page evidence or a local reference.
  const ISWEEP_YOUTUBE_DOM_FALLBACK_ENABLED = true;
  const AUDIO_STT_DISPLAY_REQUIRES_ALIGNMENT = true;
  const ISWEEP_CONTENT_SCRIPT_AUDIO_AHEAD_ENABLED = false;
  const AUDIO_STT_MIN_VISIBLE_MS = 1200;
  const AUDIO_STT_HOLD_MS = 2500;
  const AUDIO_STT_STALE_MS = 3500;
  const CAPTION_RESULT_ID_CACHE_LIMIT = 160;
  const CAPTION_RESULT_ID_CACHE_TTL_MS = 2 * 60 * 1000;
  const REFERENCE_ALIGNMENT_CONTEXT_SEC = 7.0;

  // Marker engine state. Future audio watch-ahead analyzers can emit the same marker shape.
  let activeVideoId = null;
  let markerEvents = [];
  let firedMarkerIds = new Set();
  let markerSchedulerInterval = null;
  let markerVideoWatchInterval = null;
  let captionVideoWatchInterval = null;
  let markerModeActive = false;
  let markerFallbackReason = 'scheduler_not_started';
  let markerFallbackLogVideoId = null;
  let markerPastEndLogged = false;

  // Clean caption overlay state.
  const CLEAN_CAPTION_DEFAULTS = {
    cleanCaptionsEnabled: true,
    cleanCaptionStyle: 'black_white',
    cleanCaptionTextSize: 'medium',
    cleanCaptionWordMuteMode: 'captions_only',
    cleanCaptionPosition: { x: 0.5, y: 0.8 },
  };
  const CLEAN_CAPTION_SIZE_PX = Object.freeze({
    small: '14px',
    medium: '18px',
    large: '20px',
  });
  const CLEAN_CAPTION_CONTROL_SAFE_BOTTOM_PX = 46;
  const CLEAN_CAPTION_DRAG_THRESHOLD_PX = 3;
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
  let lastSelectedWordsLogSignature = '';
  let lastPageSelectedWordMuteSignature = '';
  let lastPageSelectedWordMuteAtMs = 0;
  let lastPageCaptionText = '';
  let lastPageCaptionVideoTime = null;
  let pageSelectedWordMuteTimer = null;
  const nativeCaptionStyleCache = new Map();

  const CAPTION_STATE_LOG = '[ISWEEP][CAPTION_STATE]';
  const EVIDENCE_LOG = '[ISWEEP][EVIDENCE]';
  const FAST_GUARD_LOG = '[ISWEEP][FAST_GUARD]';
  const SPEECH_END_CLEAR_DELAY_MS = 420;
  let speechEndedClearTimer = null;
  let currentVadState = 'unknown';
  let pageTextAssistLastState = 'unavailable';
  let lastSttPageAgreement = 'unavailable';

  let lastReferenceAlignment = {
    status: 'searching',
    score: 0,
    audio_anchor_count: 0,
    reference_coverage: 0,
    time_alignment_score: 0,
    source: 'none',
    reason: 'not_started',
  };

  const captionTimelineState = {
    sessionId: null,
    tabId: null,
    videoId: null,
    lastAcceptedAudioWindowEndMs: -1,
    lastAcceptedWindowKey: '',
    lastAcceptedTextNormByWindow: new Map(),
    currentChunkId: null,
    sequenceNumber: 0,
    lastDroppedReason: null,
    recentAcceptedResultIds: new Map(),
    speechEndedAtMs: 0,
    captionState: 'Listening',
    assist: {
      source: 'none',
      text: '',
      cue_start_seconds: null,
      cue_end_seconds: null,
      observed_video_time: 0,
      confidence: 'context_only',
    },
    referenceLineIndex: null,
    referenceLineId: null,
    referenceVideoTime: null,
    lastObservedVideoTimeSec: null,
  };

  let lastAudioRelaySignature = '';
  let lastAudioRelayAtMs = 0;
  const AUDIO_RELAY_DEDUPE_WINDOW_MS = 1200;
  const STT_SELF_AGREEMENT_WINDOW_MS = 9000;
  const STT_SELF_AGREEMENT_MIN_SCORE = 0.46;
  const STT_SELF_AGREEMENT_MIN_CHARS = 18;
  const recentSttDrafts = [];

  function normalizeCaptionStateText(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function sttAgreementTokens(text) {
    return normalizeCaptionStateText(text)
      .replace(/[^a-z0-9' ]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
  }

  function scoreSttTextAgreement(a, b) {
    const aTokens = Array.from(new Set(sttAgreementTokens(a)));
    const bTokens = Array.from(new Set(sttAgreementTokens(b)));
    if (!aTokens.length || !bTokens.length) return 0;
    const bSet = new Set(bTokens);
    const shared = aTokens.filter((token) => bSet.has(token)).length;
    return shared / Math.max(Math.min(aTokens.length, bTokens.length), 1);
  }

  function trimRecentSttDrafts(nowMs = Date.now()) {
    while (
      recentSttDrafts.length
      && (nowMs - Number(recentSttDrafts[0].observedAtMs || 0)) > STT_SELF_AGREEMENT_WINDOW_MS
    ) {
      recentSttDrafts.shift();
    }

    while (recentSttDrafts.length > 8) {
      recentSttDrafts.shift();
    }
  }

  function evaluateSelfAgreedStt(text, windowEndMs) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const nowMs = Date.now();
    trimRecentSttDrafts(nowMs);

    if (clean.length < STT_SELF_AGREEMENT_MIN_CHARS) {
      recentSttDrafts.push({
        text: clean,
        windowEndMs,
        observedAtMs: nowMs
      });
      trimRecentSttDrafts(nowMs);
      return {
        approved: false,
        score: 0,
        reason: 'too_short'
      };
    }

    let bestScore = 0;
    let bestText = '';

    for (const prior of recentSttDrafts) {
      const score = scoreSttTextAgreement(clean, prior.text);
      if (score > bestScore) {
        bestScore = score;
        bestText = prior.text;
      }
    }

    recentSttDrafts.push({
      text: clean,
      windowEndMs,
      observedAtMs: nowMs
    });
    trimRecentSttDrafts(nowMs);

    if (bestScore >= STT_SELF_AGREEMENT_MIN_SCORE) {
      return {
        approved: true,
        score: bestScore,
        text: clean,
        sourceLabel: 'audio_stt_self_agreed',
        reason: 'repeated_stt_overlap',
        previousPreview: bestText.slice(0, 80),
      };
    }

    return {
      approved: false,
      score: bestScore,
      reason: 'not_repeated_enough',
      previousPreview: bestText.slice(0, 80),
    };
  }

  function buildCaptionResultId(message = {}) {
    const tabId = Number.isFinite(Number(message.tab_id))
      ? Number(message.tab_id)
      : 0;

    const sessionId = String(message.session_id || '').trim() || 'no_session';
    const chunkId = String(message.chunk_id || '').trim() || 'no_chunk';

    const windowEndMs = Number.isFinite(Number(message.audio_window_end_ms))
      ? Number(message.audio_window_end_ms)
      : -1;

    return `${tabId}|${sessionId}|${chunkId}|${windowEndMs}`;
  }

  function trimRecentAcceptedResultIds() {
    const cache = captionTimelineState.recentAcceptedResultIds;
    if (!(cache instanceof Map)) return;

    const now = Date.now();

    for (const [key, seenAt] of cache.entries()) {
      if ((now - Number(seenAt || 0)) > CAPTION_RESULT_ID_CACHE_TTL_MS) {
        cache.delete(key);
      }
    }

    while (cache.size > CAPTION_RESULT_ID_CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      if (typeof oldestKey === 'undefined') break;
      cache.delete(oldestKey);
    }
  }

  function shouldDropDuplicateRender(message = {}) {
    trimRecentAcceptedResultIds();

    const cache = captionTimelineState.recentAcceptedResultIds;
    if (!(cache instanceof Map)) return false;

    const resultId = buildCaptionResultId(message);

    if (cache.has(resultId)) {
      captionTimelineState.lastDroppedReason = 'duplicate_render_result_id';

      console.log(CAPTION_STATE_LOG, 'duplicate render dropped', {
        result_id: resultId,
        chunk_id: String(message.chunk_id || '').trim() || null,
        audio_window_end_ms: Number.isFinite(Number(message.audio_window_end_ms))
          ? Number(message.audio_window_end_ms)
          : null,
      });

      return true;
    }

    cache.set(resultId, Date.now());
    trimRecentAcceptedResultIds();
    return false;
  }

  function clearSpeechEndTimer() {
    if (speechEndedClearTimer) {
      clearTimeout(speechEndedClearTimer);
      speechEndedClearTimer = null;
    }
  }

  function resetCaptionTimelineState(reason = 'reset') {
    clearSpeechEndTimer();

    captionTimelineState.sessionId = null;
    captionTimelineState.tabId = null;
    captionTimelineState.videoId = null;
    captionTimelineState.lastAcceptedAudioWindowEndMs = -1;
    captionTimelineState.lastAcceptedWindowKey = '';
    captionTimelineState.lastAcceptedTextNormByWindow = new Map();
    captionTimelineState.currentChunkId = null;
    captionTimelineState.sequenceNumber = 0;
    captionTimelineState.lastDroppedReason = reason;
    captionTimelineState.recentAcceptedResultIds = new Map();
    captionTimelineState.speechEndedAtMs = 0;
    captionTimelineState.captionState = 'Listening';

    lastAudioCaptionSource = null;
    lastAudioCaptionText = '';
    lastAudioCaptionReceivedAtMs = 0;
    lastAudioRelaySignature = '';
    lastAudioRelayAtMs = 0;

    recentSttDrafts.length = 0;

    lastPageSelectedWordMuteSignature = '';
    lastPageSelectedWordMuteAtMs = 0;
    lastPageCaptionText = '';
    lastPageCaptionVideoTime = null;
    if (pageSelectedWordMuteTimer) {
      clearTimeout(pageSelectedWordMuteTimer);
      pageSelectedWordMuteTimer = null;
    }

    captionTimelineState.referenceLineIndex = null;
    captionTimelineState.referenceLineId = null;
    captionTimelineState.referenceVideoTime = null;
    captionTimelineState.lastObservedVideoTimeSec = null;

    liveAudioCleanCaptions = [];

    updateCleanOverlay('', findVideo()?.currentTime || 0);

    console.log(CAPTION_STATE_LOG, 'state reset', {
      reason,
      videoId: activeVideoId
    });
  }

  function scheduleSpeechEndedOverlayClear(reason = 'speech_ended') {
    clearSpeechEndTimer();

    speechEndedClearTimer = setTimeout(() => {
      lastAudioCaptionText = '';
      lastAudioCaptionSource = 'silence';
      captionTimelineState.speechEndedAtMs = Date.now();
      captionTimelineState.captionState = 'Speech ended';
      captionTimelineState.lastDroppedReason = reason;

      updateCleanOverlay('', findVideo()?.currentTime || 0);

      console.log(CAPTION_STATE_LOG, 'speech ended; overlay cleared', {
        reason,
        chunk_id: captionTimelineState.currentChunkId,
      });
    }, SPEECH_END_CLEAR_DELAY_MS);
  }

  function markCaptionStateListening() {
    captionTimelineState.captionState = 'Listening';
    captionTimelineState.speechEndedAtMs = 0;
  }

  function markCaptionStateLiveStt() {
    captionTimelineState.captionState = 'Live STT';
    captionTimelineState.speechEndedAtMs = 0;
  }

  // Audio watch-ahead state.
  let audioCtx = null;
  let audioProcessor = null;
  let audioSampleBufs = []; // Float32Arrays accumulated for the current chunk
  let audioChunkWarm = false;
  let audioChunkStartSec = 0; // video.currentTime when the current chunk began
  let audioAheadActive = false;
  let audioAheadVideoId = null;
  let audioCapturePermissionDenied = false; // true after explicit permission denial until user resets capture
  let audioInputStream = null;
  let audioCaptureSource = null;
  let tabAudioCaptureState = 'idle'; // idle|starting|ready|unavailable|stopped
  let audioFilteringEnabled = true;
  let lastKnownVideoTimeSec = 0;

  function getAudioCaptionMode() {
    const disabledReasons = new Set([
      'stt_disabled',
      'stt_unavailable',
      'transcription_unavailable',
      'audio_pipeline_disabled',
    ]);

    if (lastAudioCaptionSource === 'audio_stt_disabled') {
      return 'stt_disabled';
    }

    if (disabledReasons.has(String(lastAudioCaptionFailureReason || '').trim())) {
      return 'stt_disabled';
    }

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
    if (!['mute', 'skip', 'fast_forward'].includes(action) && !hasDisplayText) {
      return null;
    }

    const computedEnd = Number.isFinite(end) && end > start
      ? end
      : start + (Number.isFinite(duration) && duration > 0 ? duration : 0);

    if (!Number.isFinite(computedEnd) || computedEnd <= start) {
      return null;
    }

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
      cleaned_text: typeof raw.cleaned_text === 'string'
        ? raw.cleaned_text
        : null,
      caption_text: typeof raw.caption_text === 'string'
        ? raw.caption_text
        : null,
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
    return Boolean(
      marker
      && ['mute', 'skip', 'fast_forward'].includes(marker.action)
    );
  }

  function getVideoClockSnapshot() {
    const video = findVideo();
    const currentTime = Number(video?.currentTime);
    return {
      ok: Boolean(video) && Number.isFinite(currentTime),
      video_id: getCurrentVideoId(),
      current_time: Number.isFinite(currentTime) ? currentTime : null,
      paused: video?.paused === true,
      playback_rate: Number.isFinite(Number(video?.playbackRate))
        ? Number(video.playbackRate)
        : null,
    };
  }

  function shouldAllowMarkerAction(marker, nowSec = 0, settings = cleanCaptionSettings) {
    if (!isActionableMarker(marker)) return false;

    // Clean captions may use the transcript watch-ahead data for captions and
    // temporary mutes, but never for seeking or playback-rate changes.
    if (settings?.cleanCaptionsEnabled === true) {
      if (!isSelectedWordMuteModeEnabled(settings) || marker.action !== 'mute') {
        return false;
      }

      const markerStart = Number(marker.start_seconds);
      const currentTime = Number(nowSec);
      if (!Number.isFinite(markerStart) || !Number.isFinite(currentTime)) {
        return false;
      }

      return markerStart <= currentTime + WATCH_AHEAD_SECONDS;
    }

    return true;
  }

  function getCleanCaptionDisplayText(entry, nowSec = null) {
    if (!entry || typeof entry !== 'object') return '';

    const cleanCandidates = [
      entry.clean_text,
      entry.cleaned_text
    ];

    const cleanMatch = cleanCandidates.find(
      (value) => typeof value === 'string' && value.trim()
    );

    if (cleanMatch) {
      return limitCaptionText(
        stripCategoryLabelsFromCaption(toCleanCaptionText(cleanMatch.trim())),
        entry,
        nowSec
      );
    }

    const rawCandidates = [
      entry.caption_text,
      entry.text
    ];

    const rawMatch = rawCandidates.find(
      (value) => typeof value === 'string' && value.trim()
    );

    if (!rawMatch) return '';

    return limitCaptionText(
      stripCategoryLabelsFromCaption(toCleanCaptionText(rawMatch.trim())),
      entry,
      nowSec
    );
  }

  function normalizeTimedWords(words) {
    if (!Array.isArray(words)) return [];

    return words
      .map((wordEntry) => {
        if (!wordEntry || typeof wordEntry !== 'object') return null;

        const start = Number(wordEntry.start);
        const end = Number(wordEntry.end);
        const word = String(wordEntry.word || '').trim();

        if (
          !word
          || !Number.isFinite(start)
          || !Number.isFinite(end)
        ) {
          return null;
        }

        if (end < start) return null;

        return {
          word,
          start,
          end
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  const CLEAN_CAPTION_MAX_SENTENCES = 2;
  const CLEAN_CAPTION_MAX_UNPUNCTUATED_WORDS = 32;

  function normalizeCaptionDisplaySpacing(text) {
    return String(text || '')
      // The backend/ASR stream uses >> as a chunk separator. It is not spoken
      // text and should never consume space in the visible caption box.
      .replace(/\s*>>+\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitCaptionSentences(text) {
    return normalizeCaptionDisplaySpacing(text)
      .match(/[^.!?]+(?:[.!?]+|$)/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean)
      || [];
  }

  function trimCaptionToSpokenWords(text, entry, nowSec) {
    const words = normalizeTimedWords(entry?.words);
    const now = Number(nowSec);

    if (!words.length || !Number.isFinite(now)) return text;

    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    // Only clip entries while they are the active timed caption. This avoids
    // cutting a complete caption when the overlay is briefly bridging a gap.
    if (now < firstWord.start - CLEAN_CAPTION_LOOKAHEAD_SEC || now > lastWord.end + CLEAN_CC_BRIDGE_GAP_MS / 1000) {
      return text;
    }

    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length !== words.length) return text;

    const spokenCount = words.filter(
      (word) => word.start <= now + WORD_LATENCY_COMPENSATION_MS / 1000
    ).length;

    if (spokenCount <= 0 || spokenCount >= tokens.length) return text;
    return tokens.slice(0, spokenCount).join(' ');
  }

  function limitCaptionText(text, entry = null, nowSec = null) {
    let normalized = normalizeCaptionDisplaySpacing(text);
    if (!normalized) return '';

    normalized = trimCaptionToSpokenWords(normalized, entry, nowSec);
    const sentences = splitCaptionSentences(normalized);

    if (sentences.length > CLEAN_CAPTION_MAX_SENTENCES) {
      normalized = sentences
        .slice(-CLEAN_CAPTION_MAX_SENTENCES)
        .join(' ');
    } else if (
      sentences.length === 1
      && !/[.!?]\s*$/.test(normalized)
    ) {
      const tokens = normalized.split(/\s+/).filter(Boolean);
      if (tokens.length > CLEAN_CAPTION_MAX_UNPUNCTUATED_WORDS) {
        normalized = tokens
          .slice(-CLEAN_CAPTION_MAX_UNPUNCTUATED_WORDS)
          .join(' ');
      }
    }

    return normalized;
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

    if (
      !Number.isFinite(fallbackStart)
      || !Number.isFinite(fallbackEnd)
      || fallbackEnd <= fallbackStart
    ) {
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

        if (
          !Number.isFinite(start)
          || !Number.isFinite(end)
          || end <= start
          || !displayText
        ) {
          return null;
        }

        return {
          start_seconds: start,
          end_seconds: end,
          text: typeof entry.text === 'string'
            ? entry.text
            : displayText,
          clean_text:
            typeof entry.clean_text === 'string'
            && entry.clean_text.trim()
              ? entry.clean_text
              : displayText,
          cleaned_text: typeof entry.cleaned_text === 'string'
            ? entry.cleaned_text
            : null,
          caption_text: typeof entry.caption_text === 'string'
            ? entry.caption_text
            : null,
          source: typeof entry.source === 'string'
            ? entry.source
            : null,
          clean_resume_time: Number.isFinite(
            Number(entry.clean_resume_time)
          )
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
        return String(
          entry.word || entry.text || ''
        ).trim();
      })
      .filter(Boolean)
      .join(' ')
      .trim();

    return text || null;
  }

  function extractDisplayText(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    return payload.clean_text
      || payload.cleaned_text
      || payload.caption_text
      || payload.text
      || buildFromWords(payload.words)
      || null;
  }

  function buildAudioResponseCaptions(
    response,
    fallbackStartSec,
    fallbackEndSec
  ) {
    const payload =
      response && typeof response === 'object'
        ? response
        : {};

    const normalizedStart =
      Number.isFinite(Number(payload.start_seconds))
        ? Number(payload.start_seconds)
        : (
            Number.isFinite(Number(fallbackStartSec))
              ? Number(fallbackStartSec)
              : 0
          );

    const normalizedEnd =
      Number.isFinite(Number(payload.end_seconds))
        ? Math.max(
            Number(payload.end_seconds),
            normalizedStart
          )
        : (
            Number.isFinite(Number(fallbackEndSec))
              ? Math.max(
                  Number(fallbackEndSec),
                  normalizedStart
                )
              : normalizedStart
          );

    if (
      Array.isArray(payload.cleaned_captions)
      && payload.cleaned_captions.length > 0
    ) {
      return normalizePreAnalyzedCaptions(
        payload.cleaned_captions
      );
    }

    if (
      Array.isArray(payload.clean_captions)
      && payload.clean_captions.length > 0
    ) {
      return normalizePreAnalyzedCaptions(
        payload.clean_captions
      );
    }

    const topLevelText = extractDisplayText(payload);
    const normalizedWords = normalizeTimedWords(payload.words);

    const wordsFallbackText =
      !topLevelText
        ? buildFromWords(normalizedWords)
        : null;

    const displayText =
      topLevelText
      || wordsFallbackText
      || '';

    if (!displayText) return [];

    return normalizePreAnalyzedCaptions([
      {
        start_seconds: normalizedStart,
        end_seconds: normalizedEnd,
        text: typeof payload.text === 'string'
          ? payload.text
          : displayText,
        clean_text: typeof payload.clean_text === 'string'
          ? payload.clean_text
          : null,
        cleaned_text: typeof payload.cleaned_text === 'string'
          ? payload.cleaned_text
          : null,
        caption_text: typeof payload.caption_text === 'string'
          ? payload.caption_text
          : null,
        source: ['audio', 'audio_stt'].includes(payload.source)
          ? 'audio_stt_live'
          : typeof payload.source === 'string'
            ? payload.source
            : null,
        words: normalizedWords,
      },
    ]);
  }

  function acceptAudioCaptionRelay(message = {}) {
    const incomingVideoId = String(message.video_id || '').trim();
    const currentVideoId = getCurrentVideoId();
    const incomingSessionId = String(message.session_id || '').trim();
    const incomingSequence = Number(message.sequence_number);
    const incomingWindowEndMs = Number(message.audio_window_end_ms);

    if (!incomingVideoId || !currentVideoId || incomingVideoId !== currentVideoId) {
      captionTimelineState.lastDroppedReason = 'stale_audio_video_id';
      return false;
    }

    if (activeVideoId !== currentVideoId) {
      handleVideoIdChange(currentVideoId);
    }

    if (
      captionTimelineState.sessionId
      && incomingSessionId
      && captionTimelineState.sessionId !== incomingSessionId
    ) {
      captionTimelineState.lastDroppedReason = 'stale_audio_session_id';
      return false;
    }

    if (
      incomingSessionId
      && Number.isFinite(incomingSequence)
      && captionTimelineState.sessionId === incomingSessionId
      && incomingSequence <= Number(captionTimelineState.sequenceNumber || 0)
    ) {
      captionTimelineState.lastDroppedReason = 'stale_audio_sequence';
      return false;
    }

    if (
      Number.isFinite(incomingWindowEndMs)
      && incomingWindowEndMs >= 0
      && incomingWindowEndMs < Number(captionTimelineState.lastAcceptedAudioWindowEndMs || -1)
    ) {
      captionTimelineState.lastDroppedReason = 'stale_audio_window';
      return false;
    }

    if (shouldDropDuplicateRender(message)) return false;

    const startSeconds = Number(message.start_seconds);
    const endSeconds = Number(message.end_seconds);
    if (
      !Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || endSeconds <= startSeconds
    ) {
      captionTimelineState.lastDroppedReason = 'missing_audio_source_window';
      return false;
    }

    const entries = buildAudioResponseCaptions(
      message,
      startSeconds,
      endSeconds,
    );

    captionTimelineState.sessionId = incomingSessionId || captionTimelineState.sessionId;
    captionTimelineState.videoId = incomingVideoId;
    captionTimelineState.sequenceNumber = Number.isFinite(incomingSequence)
      ? incomingSequence
      : captionTimelineState.sequenceNumber;
    captionTimelineState.currentChunkId = String(message.chunk_id || '').trim() || null;
    captionTimelineState.lastAcceptedAudioWindowEndMs = Number.isFinite(incomingWindowEndMs)
      ? incomingWindowEndMs
      : captionTimelineState.lastAcceptedAudioWindowEndMs;
    captionTimelineState.lastDroppedReason = null;

    liveAudioCleanCaptions = entries;
    lastAudioCaptionSource = String(message.source || 'audio_stt_live');
    lastAudioCaptionText = '';
    lastAudioCaptionReceivedAtMs = Date.now();
    markCaptionStateLiveStt();

    updateCleanOverlay(lastCaptionText, findVideo()?.currentTime || 0);
    return true;
  }

  function findTimedCleanCaptionEntry(
    entries,
    nowSec,
    lookaheadSec = CLEAN_CAPTION_LOOKAHEAD_SEC
  ) {
    if (
      !Array.isArray(entries)
      || !Number.isFinite(Number(nowSec))
    ) {
      return null;
    }

    const now = Number(nowSec);

    const exact = entries.find((entry) => {
      const displayText =
        getCleanCaptionDisplayText(entry);

      const bounds =
        getEntryTimingBounds(entry);

      return (
        displayText
        && bounds
        && now >= bounds.start_seconds
        && now <= bounds.end_seconds
      );
    });

    if (exact) return exact;

    return entries.find((entry) => {
      const displayText =
        getCleanCaptionDisplayText(entry);

      const bounds =
        getEntryTimingBounds(entry);

      return (
        displayText
        && bounds
        && now >= bounds.start_seconds - lookaheadSec
        && now <= bounds.end_seconds + lookaheadSec
      );
    }) || null;
  }

  function isApprovedAudioCaptionSource(source) {
    const value =
      String(source || '')
        .trim()
        .toLowerCase();

    if (!value) return false;

    if (value === 'audio_stt_plus_page_evidence') {
      return true;
    }

    if (value === 'audio_stt_plus_reference') {
      return true;
    }

    if (value === 'text_track') {
      return true;
    }

    if (value === 'page_caption_dom') {
      return true;
    }

    if (value === 'audio_stt_self_agreed') {
      return true;
    }

    if (
      !AUDIO_STT_DISPLAY_REQUIRES_ALIGNMENT
      && value.startsWith('audio_stt')
      && !value.includes('draft')
    ) {
      return true;
    }

    return false;
  }

  function getBestCleanCaptionText(liveText, nowSec, options = {}) {
    if (!cachedPreferencesReady) {
      return {
        text: '',
        source: 'preferences_pending',
        stale: false,
        cleanResumeTime: null,
      };
    }

    // Priority order after recovery:
    // 1) pre-analyzed/reference captions, 2) visible page captions, 3) approved STT only.
    // Raw STT that disagrees with the page is not shown because it causes hallucinated captions.
    const preCachedAudioCaptions = Array.isArray(options.preCachedAudioCaptions)
      ? options.preCachedAudioCaptions
      : preCachedAudioCleanCaptions;
    const liveAudioCaptions = Array.isArray(options.liveAudioCaptions)
      ? options.liveAudioCaptions
      : liveAudioCleanCaptions;
    const preAnalyzedCaptions = Array.isArray(options.preAnalyzedCaptions)
      ? options.preAnalyzedCaptions
      : preAnalyzedCleanCaptions;
    const markers = Array.isArray(options.markerEntries)
      ? options.markerEntries
      : markerEvents;
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
    const nowMs = Number.isFinite(Number(options.nowMs))
      ? Number(options.nowMs)
      : Date.now();
    const lookaheadSec = Number.isFinite(Number(options.lookaheadSec))
      ? Number(options.lookaheadSec)
      : CLEAN_CAPTION_LOOKAHEAD_SEC;
    const staleMs = Number.isFinite(Number(options.staleMs))
      ? Number(options.staleMs)
      : CLEAN_CAPTION_STALE_MS;
    const audioHoldMs = Number.isFinite(Number(options.audioHoldMs))
      ? Number(options.audioHoldMs)
      : AUDIO_STT_HOLD_MS;

    const preAnalyzedEntry = findTimedCleanCaptionEntry(
      preAnalyzedCaptions,
      nowSec,
      lookaheadSec
    );

    if (preAnalyzedEntry) {
      return {
        text: getCleanCaptionDisplayText(preAnalyzedEntry, nowSec),
        source: 'pre_analyzed',
        stale: false,
        cleanResumeTime: Number.isFinite(Number(preAnalyzedEntry.clean_resume_time))
          ? Number(preAnalyzedEntry.clean_resume_time)
          : null,
      };
    }

    const markerTextEntry = findTimedCleanCaptionEntry(
      markers,
      nowSec,
      lookaheadSec
    );

    if (markerTextEntry) {
      return {
        text: getCleanCaptionDisplayText(markerTextEntry, nowSec),
        source: 'marker_text',
        stale: false,
        cleanResumeTime: Number.isFinite(Number(markerTextEntry.clean_resume_time))
          ? Number(markerTextEntry.clean_resume_time)
          : null,
      };
    }

    const maskedLiveText = limitCaptionText(
      stripCategoryLabelsFromCaption(toCleanCaptionText(String(liveText || ''))),
      null,
      nowSec
    );

    if (ISWEEP_YOUTUBE_DOM_FALLBACK_ENABLED && maskedLiveText) {
      const isStale =
        liveCaptionObservedAtMs > 0
        && (nowMs - liveCaptionObservedAtMs) > staleMs;

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

    const preCachedAudioEntry = findTimedCleanCaptionEntry(
      preCachedAudioCaptions,
      nowSec,
      lookaheadSec
    );

    if (preCachedAudioEntry) {
      const entrySource =
        String(preCachedAudioEntry.source || '').trim()
        || 'audio_stt_cached';

      if (isApprovedAudioCaptionSource(entrySource)) {
        return {
          text: getCleanCaptionDisplayText(preCachedAudioEntry, nowSec),
          source: entrySource,
          stale: false,
          cleanResumeTime: Number.isFinite(
            Number(preCachedAudioEntry.clean_resume_time)
          )
            ? Number(preCachedAudioEntry.clean_resume_time)
            : null,
        };
      }
    }

    const liveAudioEntry = findTimedCleanCaptionEntry(
      liveAudioCaptions,
      nowSec,
      lookaheadSec
    );

    if (liveAudioEntry) {
      const entrySource =
        String(liveAudioEntry.source || '').trim()
        || 'audio_stt_live';

      if (isApprovedAudioCaptionSource(entrySource)) {
        return {
          text: getCleanCaptionDisplayText(liveAudioEntry, nowSec),
          source: entrySource,
          stale: false,
          cleanResumeTime: Number.isFinite(
            Number(liveAudioEntry.clean_resume_time)
          )
            ? Number(liveAudioEntry.clean_resume_time)
            : null,
        };
      }
    }

    const normalizedAudioSource =
      String(audioCaptionSource || '').toLowerCase();

    const freshAudioText = limitCaptionText(
      stripCategoryLabelsFromCaption(toCleanCaptionText(String(audioCaptionText || '').trim())),
      null,
      nowSec
    );

    const audioAgeMs =
      audioCaptionObservedAtMs > 0
        ? nowMs - audioCaptionObservedAtMs
        : Number.POSITIVE_INFINITY;

    if (
      freshAudioText
      && normalizedAudioSource.startsWith('audio_stt')
      && isApprovedAudioCaptionSource(normalizedAudioSource)
      && audioAgeMs <= audioHoldMs
    ) {
      return {
        text: freshAudioText,
        source:
          normalizedAudioSource
          || (
            normalizedAudioSource.includes('cached')
              ? 'audio_stt_cached'
              : 'audio_stt_live'
          ),
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

    console.log(MARKER_LOG_PREFIX, 'engine reset', {
      reason,
    });
  }

  function markerSourcePriority(source) {
    const value =
      String(source || '').toLowerCase();

    if (value.startsWith('audio')) return 0;

    if (
      value.startsWith('transcript')
      || value.startsWith('pre')
    ) {
      return 1;
    }

    return 2;
  }

  function shouldDedupAudioMarker(existing, incoming) {
    if (!existing || !incoming) return false;
    if (existing.action !== incoming.action) return false;

    const overlapStart = Math.max(
      Number(existing.start_seconds) || 0,
      Number(incoming.start_seconds) || 0
    );

    const overlapEnd = Math.min(
      Number(existing.end_seconds) || 0,
      Number(incoming.end_seconds) || 0
    );

    if (overlapEnd <= overlapStart) return false;

    const existingDur = Math.max(
      (Number(existing.end_seconds) || 0)
        - (Number(existing.start_seconds) || 0),
      0.001
    );

    const incomingDur = Math.max(
      (Number(incoming.end_seconds) || 0)
        - (Number(incoming.start_seconds) || 0),
      0.001
    );

    const overlapDur =
      overlapEnd - overlapStart;

    const overlapRatio =
      overlapDur / Math.min(existingDur, incomingDur);

    return overlapRatio >= 0.7;
  }

  function takeTailSampleBuffers(sampleBufs, tailSamples) {
    const target = Math.max(
      Math.floor(Number(tailSamples) || 0),
      0
    );

    if (
      !target
      || !Array.isArray(sampleBufs)
      || sampleBufs.length === 0
    ) {
      return [];
    }

    const out = [];
    let remaining = target;

    for (
      let i = sampleBufs.length - 1;
      i >= 0 && remaining > 0;
      i -= 1
    ) {
      const buf = sampleBufs[i];

      if (!buf || !buf.length) continue;

      if (buf.length <= remaining) {
        out.unshift(new Float32Array(buf));
        remaining -= buf.length;
      } else {
        out.unshift(
          new Float32Array(
            buf.slice(buf.length - remaining)
          )
        );
        remaining = 0;
      }
    }

    return out;
  }

  function setMarkerEvents(events, source) {
    const normalized =
      (Array.isArray(events) ? events : [])
        .map(normalizeMarkerEvent)
        .map((event) => (
          event
            ? {
              ...event,
              source:
                event.source
                || source
                || null,
            }
            : null
        ))
        .filter(Boolean)
        .sort(
          (a, b) =>
            a.start_seconds - b.start_seconds
        );

    markerEvents = normalized;
    firedMarkerIds = new Set();

    markerModeActive =
      markerEvents.length > 0;

    markerFallbackReason =
      markerModeActive
        ? 'markers_loaded'
        : 'marker_list_empty';

    markerFallbackLogVideoId = null;
    markerPastEndLogged = false;

    console.log(
      MARKER_LOG_PREFIX,
      'events loaded',
      {
        source,
        count: markerEvents.length,
      }
    );

    if (!markerModeActive) {
      console.log(
        MARKER_LOG_PREFIX,
        'marker list empty; live caption fallback active',
        {
          videoId: activeVideoId,
        }
      );
    }
  }

  function applyMarkerEvent(marker, nowSec) {
    const video = findVideo();

    if (!video) return;

    // ISweep does not edit media.
    // It only applies temporary playback controls
    // and separate overlay captions.

    if (marker.action === 'mute') {
      const muteWindow =
        getMuteWindowFromMarker(marker);

      const markerStartSec =
        muteWindow.start_seconds;

      const markerEndSec =
        muteWindow.end_seconds;

      console.log(
        WORD_MUTE_LOG_PREFIX,
        'applied',
        {
          id: marker.id,
          source:
            marker.source || 'unknown',
          blocked_word_start:
            marker.blocked_word_start
            || markerStartSec,
          clean_resume_time:
            marker.clean_resume_time
            || markerEndSec,
        }
      );

      applyMuteWindow(
        markerStartSec,
        markerEndSec,
        `marker:${marker.id}`
      );

      console.log(
        MARKER_LOG_PREFIX,
        'marker applied',
        {
          id: marker.id,
          action: 'mute',
          start: markerStartSec,
          end: markerEndSec,
          clean_resume_time:
            marker.clean_resume_time || null,
          blocked_word_start:
            marker.blocked_word_start || null,
          source:
            marker.source || 'unknown',
        }
      );

      if (
        String(marker.source || '')
          .toLowerCase()
          .startsWith('audio')
      ) {
        console.log(
          AUDIO_LOG_PREFIX,
          'marker applied',
          {
            id: marker.id,
            start_seconds: markerStartSec,
            end_seconds: markerEndSec,
            source:
              marker.source || 'audio',
          }
        );
      }

      if (
        Number.isFinite(
          Number(marker.clean_resume_time)
        )
      ) {
        console.log(
          WORD_MUTE_LOG_PREFIX,
          'clean resume',
          {
            id: marker.id,
            clean_resume_time:
              marker.clean_resume_time,
          }
        );
      }

      return;
    }

    if (marker.action === 'skip') {
      const jump = Math.max(
        Number(marker.duration_seconds) || 0,
        0
      );

      if (jump > 0) {
        let targetTime =
          nowSec + jump;

        if (
          Number.isFinite(video.duration)
          && video.duration > 0
        ) {
          targetTime = Math.min(
            targetTime,
            Math.max(
              video.duration - 0.05,
              0
            )
          );
        }

        if (
          Number.isFinite(targetTime)
          && targetTime > nowSec
        ) {
          video.currentTime =
            targetTime;
        }
      }

      console.log(
        MARKER_LOG_PREFIX,
        'marker fired',
        {
          id: marker.id,
          action: 'skip',
          jump,
        }
      );

      return;
    }

    if (marker.action === 'fast_forward') {
      const durationMs = Math.max(
        (marker.duration_seconds || 0) * 1000,
        0
      );

      if (restoreRateTimeout) {
        clearTimeout(
          restoreRateTimeout
        );
      }

      const restoreRate =
        Number.isFinite(video.playbackRate)
        && video.playbackRate > 0
          ? video.playbackRate
          : 1.0;

      previousRate =
        restoreRate;

      video.playbackRate =
        2.0;

      const rateVideo =
        video;

      restoreRateTimeout =
        setTimeout(() => {
          if (
            rateVideo
            && typeof rateVideo.playbackRate
              === 'number'
          ) {
            rateVideo.playbackRate =
              restoreRate;
          }
        }, durationMs || 8000);

      console.log(
        MARKER_LOG_PREFIX,
        'marker fired',
        {
          id: marker.id,
          action: 'fast_forward',
          durationMs,
          restoreRate,
        }
      );
    }
  }

  function getMuteWindowFromMarker(marker) {
    const markerStartSec = Math.max(
      Number(
        marker && marker.start_seconds
      ) || 0,
      0
    );

    let markerEndSec =
      Number(
        marker && marker.end_seconds
      )
      || markerStartSec;

    if (
      Number.isFinite(
        Number(
          marker
          && marker.clean_resume_time
        )
      )
    ) {
      const resumeSec =
        Number(marker.clean_resume_time);

      if (resumeSec > markerStartSec) {
        markerEndSec =
          Math.min(
            markerEndSec,
            resumeSec
          );
      }
    }

    return {
      start_seconds:
        markerStartSec,
      end_seconds:
        Math.max(
          markerEndSec,
          markerStartSec
        ),
    };
  }

  function tickMarkerScheduler() {
    if (extensionContextInvalidated) return;

    const video = findVideo();

    if (!video) return;

    const nowSec =
      video.currentTime || 0;

    updateCleanOverlay(
      lastCaptionText,
      nowSec
    );

    if (!markerEvents.length) return;

    markerEvents.forEach((marker) => {
      if (!shouldAllowMarkerAction(marker, nowSec)) {
        return;
      }

      if (
        firedMarkerIds.has(marker.id)
      ) {
        return;
      }

      // Mute markers fire slightly before their start
      // so the audio is silent before the viewer hears the word.
      // Skip/fast_forward fire exactly on-time.
      const earlyWindowSec =
        getMarkerEarlyWindowSec(
          marker.action
        );

      if (
        !shouldFireMarker(
          marker,
          nowSec,
          firedMarkerIds
        )
      ) {
        return;
      }

      firedMarkerIds.add(
        marker.id
      );

      console.log(
        MARKER_LOG_PREFIX,
        'marker fired',
        {
          id: marker.id,
          action: marker.action,
          start_seconds:
            marker.start_seconds,
          original_start_seconds:
            marker.start_seconds,
          scheduler_nowSec:
            +nowSec.toFixed(3),
          lead_time_used:
            earlyWindowSec,
          leadSec:
            +(
              marker.start_seconds
              - nowSec
            ).toFixed(3),
          source:
            marker.source
            || 'unknown',
        }
      );

      applyMarkerEvent(
        marker,
        nowSec
      );
    });

    if (
      !markerPastEndLogged
      && markerEvents.length > 0
    ) {
      const last =
        markerEvents[
          markerEvents.length - 1
        ];

      if (
        nowSec >
          last.end_seconds + 0.25
        && firedMarkerIds.size === 0
      ) {
        markerPastEndLogged = true;

        console.warn(
          MARKER_LOG_PREFIX,
          'markers loaded but none fired by end window',
          {
            videoId:
              activeVideoId,
            markerCount:
              markerEvents.length,
            nowSec,
            lastEnd:
              last.end_seconds,
          }
        );
      }
    }
  }

  function ensureMarkerSchedulerRunning() {
    if (
      cleanCaptionSettings
        .cleanCaptionsEnabled
      && !isSelectedWordMuteModeEnabled()
    ) {
      if (markerSchedulerInterval) {
        clearInterval(markerSchedulerInterval);
        markerSchedulerInterval = null;
      }

      markerFallbackReason =
        'caption_mode_mute_disabled';

      return;
    }

    if (markerSchedulerInterval) {
      return;
    }

    console.log(
      MARKER_LOG_PREFIX,
      'scheduler started',
      {
        intervalMs:
          MARKER_SCHEDULER_INTERVAL_MS,
      }
    );

    markerSchedulerInterval =
      setInterval(() => {
        tickMarkerScheduler();
      }, MARKER_SCHEDULER_INTERVAL_MS);
  }

  async function analyzeCurrentVideoMarkers(
    forceRefresh = false
  ) {
    const videoId =
      getCurrentVideoId();

    if (!videoId) {
      resetMarkerEngine(
        'missing_video_id'
      );

      return;
    }

    try {
      console.log(
        MARKER_LOG_PREFIX,
        'analyze request start',
        {
          videoId,
          forceRefresh,
        }
      );

      const response =
        await safeRuntimeSendMessage({
          type:
            'isweep_markers_analyze',
          video_id:
            videoId,
          force_refresh:
            forceRefresh,
          lookahead_seconds:
            WATCH_AHEAD_SECONDS,
        });

      // Ignore stale results after YouTube SPA navigation.
      if (
        activeVideoId !== videoId
        || getCurrentVideoId()
          !== videoId
      ) {
        console.log(
          MARKER_LOG_PREFIX,
          'stale analyze result ignored',
          {
            failure_reason:
              'stale_analyze_response_ignored',
            requestVideoId:
              videoId,
            activeVideoId,
            currentVideoId:
              getCurrentVideoId(),
          }
        );

        return;
      }

      console.log(
        MARKER_LOG_PREFIX,
        'analyze result',
        {
          videoId,
          status:
            response?.status
            || 'unknown',
          source:
            response?.source
            || null,
          events:
            Array.isArray(
              response?.events
            )
              ? response.events.length
              : 0,
          failure_reason:
            response?.failure_reason
            || null,
        }
      );

      if (
        !response
        || response.status !== 'ready'
      ) {
        const fallbackReason =
          response?.failure_reason
          || `status:${response?.status || 'unknown'}`;

        resetMarkerEngine(
          fallbackReason
        );

        preAnalyzedCleanCaptions = [];

        console.log(
          MARKER_LOG_PREFIX,
          'watch-ahead unavailable; live caption fallback active',
          {
            videoId,
            status:
              response?.status
              || 'unknown',
            failure_reason:
              response?.failure_reason
              || null,
          }
        );

        return;
      }

      preAnalyzedCleanCaptions =
        normalizePreAnalyzedCaptions(
          response.cleaned_captions
          || response.clean_captions
          || []
        );

      setMarkerEvents(
        response.events,
        response.source
          || 'transcript'
      );
    } catch (err) {
      resetMarkerEngine(
        'analyze_exception'
      );

      console.warn(
        MARKER_LOG_PREFIX,
        'analyze request failed',
        {
          videoId,
          failure_reason:
            'analyze_exception',
          error:
            err?.message
            || err,
        }
      );
    }
  }

  // ── Audio watch-ahead helpers ─────────────────────────

  function encodeWAV(sampleBufs, sampleRate) {
    const totalSamples =
      sampleBufs.reduce(
        (n, b) => n + b.length,
        0
      );

    const dataBytes =
      totalSamples * 2;

    const out =
      new ArrayBuffer(
        44 + dataBytes
      );

    const view =
      new DataView(out);

    const w = (off, str) => {
      for (
        let i = 0;
        i < str.length;
        i++
      ) {
        view.setUint8(
          off + i,
          str.charCodeAt(i)
        );
      }
    };

    w(0, 'RIFF');
    view.setUint32(
      4,
      36 + dataBytes,
      true
    );

    w(8, 'WAVE');
    w(12, 'fmt ');

    view.setUint32(
      16,
      16,
      true
    );

    view.setUint16(
      20,
      1,
      true
    );

    view.setUint16(
      22,
      1,
      true
    );

    view.setUint32(
      24,
      sampleRate,
      true
    );

    view.setUint32(
      28,
      sampleRate * 2,
      true
    );

    view.setUint16(
      32,
      2,
      true
    );

    view.setUint16(
      34,
      16,
      true
    );

    w(36, 'data');

    view.setUint32(
      40,
      dataBytes,
      true
    );

    let offset = 44;

    sampleBufs.forEach((buf) => {
      for (
        let i = 0;
        i < buf.length;
        i++
      ) {
        const s =
          Math.max(
            -1,
            Math.min(
              1,
              buf[i]
            )
          );

        view.setInt16(
          offset,
          s < 0
            ? s * 0x8000
            : s * 0x7fff,
          true
        );

        offset += 2;
      }
    });

    return out;
  }

  function arrayBufferToBase64(buffer) {
    const bytes =
      new Uint8Array(buffer);

    const parts = [];

    for (
      let i = 0;
      i < bytes.length;
      i += 8192
    ) {
      parts.push(
        String.fromCharCode(
          ...bytes.subarray(
            i,
            Math.min(
              i + 8192,
              bytes.length
            )
          )
        )
      );
    }

    return btoa(
      parts.join('')
    );
  }

  function flattenSampleBuffers(sampleBufs) {
    const total =
      (sampleBufs || [])
        .reduce(
          (
            sum,
            buf
          ) =>
            sum
            + (
              buf?.length
              || 0
            ),
          0
        );

    const merged =
      new Float32Array(total);

    let offset = 0;

    (sampleBufs || [])
      .forEach((buf) => {
        if (
          !(buf instanceof Float32Array)
          || !buf.length
        ) {
          return;
        }

        merged.set(
          buf,
          offset
        );

        offset +=
          buf.length;
      });

    return Array.from(
      merged
    );
  }

  function stopAudioCapture(reason) {
    if (
      !audioAheadActive
      && !audioCtx
      && !audioInputStream
    ) {
      return;
    }

    audioAheadActive = false;

    if (audioProcessor) {
      try {
        audioProcessor.disconnect();
      } catch (_) {}

      audioProcessor = null;
    }

    if (audioCtx) {
      try {
        audioCtx.close();
      } catch (_) {}

      audioCtx = null;
    }

    if (
      audioInputStream
      && typeof audioInputStream.getTracks
        === 'function'
    ) {
      audioInputStream
        .getTracks()
        .forEach((track) => {
          try {
            track.stop();
          } catch (_) {}
        });
    }

    try {
      void safeRuntimeSendMessage({
        type:
          'isweep_release_tab_capture_stream',
        reason,
      });
    } catch (_) {}

    audioInputStream = null;
    audioCaptureSource = null;
    audioSampleBufs = [];
    audioAheadVideoId = null;

    if (
      reason ===
      'captions_disabled'
    ) {
      lastAudioCaptionSource = null;
      lastAudioCaptionText = '';
      lastAudioCaptionReceivedAtMs = 0;
      lastAudioCaptionFailureReason = null;
      audioCapturePermissionDenied = false;
      tabAudioCaptureState = 'idle';
    }

    console.log(
      AUDIO_AHEAD_LOG_PREFIX,
      'audio capture stopped',
      {
        reason,
      }
    );
  }

  function classifyCaptureFailure(
    errorOrMessage
  ) {
    const text =
      String(
        errorOrMessage?.message
        || errorOrMessage
        || ''
      ).trim();

    if (
      /notallowederror|permission|denied|not allowed/i
        .test(text)
    ) {
      return 'audio_capture_permission_denied';
    }

    return 'audio_capture_unavailable';
  }

  async function requestTabCaptureAudioStream() {
    console.log(
      '[ISWEEP][AUDIO_CAPTIONS] tab capture start requested',
      {
        videoId:
          activeVideoId,
      }
    );

    let response;

    try {
      response =
        await safeRuntimeSendMessage({
          type:
            'isweep_request_tab_capture_stream',
          video_id:
            activeVideoId,
        });
    } catch (err) {
      return {
        stream: null,
        failureReason:
          classifyCaptureFailure(
            err
          ),
      };
    }

    if (
      !response?.ok
      || !response?.streamId
    ) {
      return {
        stream: null,
        failureReason:
          response?.failure_reason
          || 'audio_capture_unavailable',
      };
    }

    try {
      const stream =
        await navigator.mediaDevices
          .getUserMedia({
            audio: {
              mandatory: {
                chromeMediaSource:
                  'tab',
                chromeMediaSourceId:
                  response.streamId,
              },
            },
            video: false,
          });

      const tracks =
        typeof stream?.getAudioTracks
          === 'function'
          ? stream.getAudioTracks()
          : [];

      if (!tracks.length) {
        return {
          stream: null,
          failureReason:
            'audio_capture_unavailable',
        };
      }

      console.log(
        '[ISWEEP][AUDIO_CAPTIONS] tab capture stream ready',
        {
          videoId:
            activeVideoId,
          tracks:
            tracks.length,
        }
      );

      return {
        stream,
        failureReason: null,
      };
    } catch (err) {
      return {
        stream: null,
        failureReason:
          classifyCaptureFailure(
            err
          ),
      };
    }
  }

  function requestVideoCaptureStream(video) {
    const captureMethod =
      typeof video.captureStream
        === 'function'
        ? 'captureStream'
        : (
          typeof video.mozCaptureStream
            === 'function'
            ? 'mozCaptureStream'
            : null
        );

    if (!captureMethod) {
      return {
        stream: null,
        failureReason:
          'audio_capture_unavailable',
        captureMethod: null,
      };
    }

    let stream;

    try {
      stream =
        video[captureMethod]();
    } catch (err) {
      return {
        stream: null,
        failureReason:
          classifyCaptureFailure(
            err
          ),
        captureMethod,
      };
    }

    const audioTracks =
      typeof stream?.getAudioTracks
        === 'function'
        ? stream.getAudioTracks()
        : [];

    if (!audioTracks.length) {
      return {
        stream: null,
        failureReason:
          'audio_capture_unavailable',
        captureMethod,
      };
    }

    console.log(
      '[ISWEEP][AUDIO_CAPTIONS] using video.captureStream fallback',
      {
        videoId:
          activeVideoId,
        method:
          captureMethod,
      }
    );

    return {
      stream:
        new MediaStream(
          audioTracks
        ),
      failureReason: null,
      captureMethod,
    };
  }

  async function startAudioPipeline(
    audioStream,
    sourceLabel,
    video,
    captureMethod = null
  ) {
    if (
      !ISWEEP_CONTENT_SCRIPT_AUDIO_AHEAD_ENABLED
    ) {
      return false;
    }

    try {
      audioCtx =
        new AudioContext({
          sampleRate:
            AUDIO_SAMPLE_RATE,
        });

      console.log(
        AUDIO_AHEAD_LOG_PREFIX,
        'audio context state before resume',
        {
          state:
            audioCtx.state,
        }
      );

      if (
        audioCtx.state ===
        'suspended'
      ) {
        try {
          await audioCtx.resume();

          console.log(
            AUDIO_AHEAD_LOG_PREFIX,
            'audio context resumed',
            {
              state:
                audioCtx.state,
            }
          );
        } catch (err) {
          const reason =
            classifyCaptureFailure(
              err
            );

          stopAudioCapture(
            'resume_failed'
          );

          if (
            reason ===
            'audio_capture_permission_denied'
          ) {
            audioCapturePermissionDenied =
              true;
          }

          throw err;
        }
      }

      if (
        audioCtx.state ===
        'suspended'
      ) {
        stopAudioCapture(
          'context_still_suspended'
        );

        return false;
      }

      const workletUrl =
        chrome.runtime.getURL(
          'audio_chunk_processor.js'
        );

      console.log(
        AUDIO_AHEAD_LOG_PREFIX,
        'audio worklet load start',
        {
          workletUrl,
        }
      );

      await audioCtx
        .audioWorklet
        .addModule(
          workletUrl
        );

      console.log(
        AUDIO_AHEAD_LOG_PREFIX,
        'audio worklet loaded successfully',
        {
          workletUrl,
        }
      );

      const source =
        audioCtx
          .createMediaStreamSource(
            audioStream
          );

      const workletNode =
        new AudioWorkletNode(
          audioCtx,
          'audio-chunk-processor'
        );

      const silentGain =
        audioCtx.createGain();

      silentGain.gain.value = 0;

      workletNode.port.onmessage =
        (e) => {
          if (!audioAheadActive) {
            return;
          }

          const vid = findVideo();

          if (
            !vid
            || vid.paused
          ) {
            return;
          }

          audioSampleBufs.push(
            new Float32Array(
              e.data
            )
          );

          const total =
            audioSampleBufs.reduce(
              (
                n,
                b
              ) =>
                n + b.length,
              0
            );

          const required =
            (
              audioChunkWarm
                ? (
                  AUDIO_CHUNK_SEC
                  - AUDIO_CHUNK_OVERLAP_SEC
                )
                : AUDIO_CHUNK_SEC
            )
            * audioCtx.sampleRate;

          if (total >= required) {
            flushAudioChunk();
          }
        };

      source.connect(
        workletNode
      );

      workletNode.connect(
        silentGain
      );

      silentGain.connect(
        audioCtx.destination
      );

      audioProcessor =
        workletNode;

      audioInputStream =
        audioStream;

      audioCaptureSource =
        sourceLabel;

      audioAheadActive =
        true;

      audioAheadVideoId =
        activeVideoId;

      audioChunkStartSec =
        video.currentTime || 0;

      audioSampleBufs = [];
      audioChunkWarm = false;

      console.log(
        AUDIO_CAPTURE_LOG_PREFIX,
        'capture started',
        {
          videoId:
            activeVideoId,
          chunkSec:
            AUDIO_CHUNK_SEC,
        }
      );

      console.log(
        AUDIO_CAPTURE_LOG_PREFIX,
        'captions_required=false',
        {
          videoId:
            activeVideoId,
        }
      );

      console.log(
        AUDIO_CAPTURE_LOG_PREFIX,
        `source=${sourceLabel}`,
        {
          videoId:
            activeVideoId,
        }
      );

      console.log(
        AUDIO_CAPTURE_LOG_PREFIX,
        'microphone_used=false',
        {
          videoId:
            activeVideoId,
        }
      );

      console.log(
        AUDIO_AHEAD_LOG_PREFIX,
        'audio capture started',
        {
          videoId:
            activeVideoId,
          source:
            sourceLabel,
          method:
            captureMethod,
          readyState:
            video.readyState || 0,
          sampleRate:
            audioCtx.sampleRate,
          chunkSec:
            AUDIO_CHUNK_SEC,
          processor:
            'AudioWorkletNode',
        }
      );

      return true;
    } catch (err) {
      const reason =
        classifyCaptureFailure(
          err
        );

      console.warn(
        AUDIO_AHEAD_LOG_PREFIX,
        `failure_reason: ${reason}`,
        {
          error:
            err?.message
            || String(err),
        }
      );

      stopAudioCapture(
        'init_failed'
      );

      if (
        reason ===
        'audio_capture_permission_denied'
      ) {
        audioCapturePermissionDenied =
          true;
      }

      return false;
    }
  }

  function flushAudioChunk() {
    if (!audioSampleBufs.length) {
      return;
    }

    const bufs =
      audioSampleBufs.slice();

    const chunkStartSec =
      audioChunkStartSec;

    const videoId =
      audioAheadVideoId;

    if (!videoId) return;

    const sampleRate =
      audioCtx
        ? audioCtx.sampleRate
        : AUDIO_SAMPLE_RATE;

    const sampleCount =
      bufs.reduce(
        (
          n,
          b
        ) =>
          n + b.length,
        0
      );

    const measuredDurationSec =
      sampleRate > 0
        ? sampleCount / sampleRate
        : 0;

    let chunkEndSec =
      chunkStartSec
      + measuredDurationSec;

    const video =
      findVideo();

    const nowSec =
      video
        ? video.currentTime || 0
        : chunkEndSec;

    if (
      Number.isFinite(nowSec)
      && nowSec > chunkStartSec
    ) {
      chunkEndSec =
        nowSec;
    }

    if (
      !(chunkEndSec > chunkStartSec)
    ) {
      chunkEndSec =
        chunkStartSec
        + Math.max(
          measuredDurationSec,
          0.05
        );
    }

    const overlapSamples =
      Math.floor(
        Math.max(
          AUDIO_CHUNK_OVERLAP_SEC,
          0
        )
        * sampleRate
      );

    const overlapBufs =
      takeTailSampleBuffers(
        bufs,
        overlapSamples
      );

    const overlapCount =
      overlapBufs.reduce(
        (
          n,
          b
        ) =>
          n + b.length,
        0
      );

    const overlapDurationSec =
      sampleRate > 0
        ? overlapCount / sampleRate
        : 0;

    audioSampleBufs =
      overlapBufs;

    audioChunkStartSec =
      Math.max(
        chunkEndSec
        - overlapDurationSec,
        0
      );

    audioChunkWarm =
      true;

    const wavBuf =
      encodeWAV(
        bufs,
        sampleRate
      );

    const audioChunk =
      arrayBufferToBase64(
        wavBuf
      );

    const audioSamples =
      flattenSampleBuffers(
        bufs
      );

    console.log(
      AUDIO_AHEAD_LOG_PREFIX,
      'chunk ready',
      {
        videoId,
        start_seconds:
          chunkStartSec,
        end_seconds:
          chunkEndSec,
        samplesCollected:
          sampleCount,
        wavBytes:
          wavBuf.byteLength,
      }
    );

    console.log(
      AUDIO_CAPTURE_LOG_PREFIX,
      'chunk ready',
      {
        videoId,
        chunk_start_seconds:
          chunkStartSec,
        chunk_end_seconds:
          chunkEndSec,
      }
    );

    console.log(
      AUDIO_AHEAD_LOG_PREFIX,
      'sending chunk',
      {
        videoId,
        start_seconds:
          chunkStartSec,
        end_seconds:
          chunkEndSec,
      }
    );

    console.log(
      AUDIO_LOG_PREFIX,
      'chunk sent',
      {
        videoId,
        start_seconds:
          chunkStartSec,
        end_seconds:
          chunkEndSec,
      }
    );

    console.log(
      AUDIO_CAPTURE_LOG_PREFIX,
      'chunk sent',
      {
        videoId,
        chunk_start_seconds:
          chunkStartSec,
        chunk_end_seconds:
          chunkEndSec,
      }
    );

    safeRuntimeSendMessage({
      type:
        'isweep_audio_chunk',
      video_id:
        videoId,
      audio_chunk:
        audioChunk,
      audio:
        audioSamples,
      sampleRate,
      channels: 1,
      mime_type:
        'audio/wav',
      start_seconds:
        chunkStartSec,
      end_seconds:
        chunkEndSec,
    })
      .then((response) => {
        if (!response) {
          console.warn(
            AUDIO_AHEAD_LOG_PREFIX,
            'failure_reason: analyze_exception',
            {
              videoId,
              start_seconds:
                chunkStartSec,
              end_seconds:
                chunkEndSec,
            }
          );

          return;
        }

        console.log(
          AUDIO_CAPTURE_LOG_PREFIX,
          'response received',
          {
            videoId,
            chunk_start_seconds:
              chunkStartSec,
            chunk_end_seconds:
              chunkEndSec,
            status:
              response.status
              || 'unknown',
          }
        );

        lastAudioCaptionSource =
          response.source || null;

        lastAudioCaptionFailureReason =
          response.failure_reason || null;

        if (
          response.source ===
            'audio_stt_disabled'
          || response.failure_reason ===
            'stt_disabled'
        ) {
          console.warn(
            AUDIO_CAPTURE_LOG_PREFIX,
            'STT disabled',
            {
              videoId,
              failure_reason:
                response.failure_reason
                || null,
            }
          );
        }

        if (
          response.failure_reason ===
          'backend_not_running'
        ) {
          console.warn(
            AUDIO_CAPTURE_LOG_PREFIX,
            'backend offline',
            {
              videoId,
            }
          );
        }

        if (
          typeof response.text
            === 'string'
          && response.text.trim()
        ) {
          console.log(
            AUDIO_CAPTURE_LOG_PREFIX,
            'transcript received',
            {
              videoId,
              textPreview:
                response.text
                  .slice(0, 80),
            }
          );
        }

        console.log(
          AUDIO_AHEAD_LOG_PREFIX,
          'chunk result',
          {
            videoId,
            start_seconds:
              chunkStartSec,
            end_seconds:
              chunkEndSec,
            status:
              response.status,
            events:
              Array.isArray(
                response.events
              )
                ? response.events.length
                : 0,
            failure_reason:
              response.failure_reason
              || null,
          }
        );

        if (
          response.status ===
            'ready'
          && Array.isArray(
            response.events
          )
          && response.events.length > 0
        ) {
          ingestAudioMarkers(
            response.events,
            videoId
          );
        }

        const normalizedAudioCaptions =
          buildAudioResponseCaptions(
            response,
            chunkStartSec,
            chunkEndSec
          );

        if (
          response.status === 'ready'
          && normalizedAudioCaptions.length > 0
        ) {
          if (
            response.cached === true
          ) {
            preCachedAudioCleanCaptions =
              normalizedAudioCaptions;
          } else {
            liveAudioCleanCaptions =
              normalizedAudioCaptions;
          }

          console.log(
            CLEAN_CC_LOG_PREFIX,
            'audio caption stored',
            {
              source:
                response.cached === true
                  ? 'audio_stt_cached'
                  : 'audio_stt_live',
              count:
                normalizedAudioCaptions.length,
            }
          );
        }

        updateCleanOverlay(
          lastCaptionText,
          findVideo()?.currentTime || 0
        );
      })
      .catch((err) => {
        console.warn(
          AUDIO_AHEAD_LOG_PREFIX,
          'failure_reason: analyze_exception',
          {
            videoId,
            start_seconds:
              chunkStartSec,
            end_seconds:
              chunkEndSec,
            error:
              err?.message
              || String(err),
          }
        );

        lastAudioCaptionSource =
          'audio_stt';

        lastAudioCaptionFailureReason =
          'analyze_exception';

        updateCleanOverlay(
          lastCaptionText,
          findVideo()?.currentTime || 0
        );
      });
  }

  function ingestAudioMarkers(
    newEvents,
    videoId
  ) {
    if (
      videoId !== activeVideoId
    ) {
      console.log(
        AUDIO_AHEAD_LOG_PREFIX,
        'failure_reason: stale_audio_response_ignored',
        {
          responseVideoId:
            videoId,
          activeVideoId,
        }
      );

      return;
    }

    const normalized =
      (
        Array.isArray(newEvents)
          ? newEvents
          : []
      )
        .map(
          normalizeMarkerEvent
        )
        .map((event) => (
          event
            ? {
              ...event,
              source:
                event.source
                || 'audio_stt',
            }
            : null
        ))
        .filter(Boolean)
        .filter(
          (e) =>
            !firedMarkerIds.has(
              e.id
            )
        );

    if (!normalized.length) {
      return;
    }

    const firedBefore =
      new Set(
        firedMarkerIds
      );

    const merged = [
      ...markerEvents,
    ];

    normalized.forEach((e) => {
      const exact =
        merged.some(
          (m) =>
            m.id === e.id
        );

      const overlapDup =
        merged.some(
          (m) =>
            shouldDedupAudioMarker(
              m,
              e
            )
        );

      if (
        !exact
        && !overlapDup
      ) {
        merged.push(e);
      }
    });

    merged.sort(
      (a, b) => {
        const delta =
          a.start_seconds
          - b.start_seconds;

        if (
          Math.abs(delta)
          > 1e-6
        ) {
          return delta;
        }

        return (
          markerSourcePriority(
            a.source
          )
          - markerSourcePriority(
            b.source
          )
        );
      }
    );

    markerEvents =
      merged;

    markerModeActive =
      markerEvents.length > 0;

    markerFallbackReason =
      markerModeActive
        ? 'markers_loaded'
        : 'marker_list_empty';

    markerFallbackLogVideoId =
      null;

    firedMarkerIds =
      firedBefore;

    console.log(
      MARKER_LOG_PREFIX,
      'events merged',
      {
        source:
          'audio_chunk',
        total:
          markerEvents.length,
        added:
          normalized.map(
            (event) => ({
              id:
                event.id,
              start_seconds:
                event.start_seconds,
              end_seconds:
                event.end_seconds,
              source:
                event.source
                || 'audio_chunk',
            })
          ),
      }
    );

    console.log(
      AUDIO_AHEAD_LOG_PREFIX,
      'audio markers merged',
      {
        videoId:
          activeVideoId,
        addedCount:
          normalized.length,
        totalCount:
          markerEvents.length,
      }
    );

    console.log(
      AUDIO_LOG_PREFIX,
      'markers received',
      {
        videoId:
          activeVideoId,
        addedCount:
          normalized.length,
        totalCount:
          markerEvents.length,
      }
    );

    normalized.forEach(
      (event) => {
        if (
          event.action === 'mute'
        ) {
          console.log(
            WORD_MUTE_LOG_PREFIX,
            'marker scheduled',
            {
              id:
                event.id,
              source:
                event.source
                || 'audio_stt',
              blocked_word_start:
                event.blocked_word_start
                || event.start_seconds,
              clean_resume_time:
                event.clean_resume_time
                || event.end_seconds,
            }
          );
        }
      }
    );
  }

  async function startAudioCapture() {
    if (
      !ISWEEP_CONTENT_SCRIPT_AUDIO_AHEAD_ENABLED
    ) {
      return;
    }

    const video =
      findVideo();

    console.log(
      AUDIO_AHEAD_LOG_PREFIX,
      'start requested',
      {
        videoId:
          activeVideoId,
        hasVideo:
          Boolean(video),
        audioAheadActive,
        audioCapturePermissionDenied,
        audioFilteringEnabled,
        readyState:
          video?.readyState
          ?? null,
        paused:
          video?.paused
          ?? null,
        currentTime:
          video?.currentTime
          ?? null,
      }
    );

    if (
      !cleanCaptionSettings
        .cleanCaptionsEnabled
    ) {
      return;
    }

    if (
      tabAudioCaptureState
        === 'starting'
      || tabAudioCaptureState
        === 'ready'
    ) {
      return;
    }

    if (
      !video
      || audioAheadActive
      || audioCapturePermissionDenied
    ) {
      return;
    }

    const minReadyState =
      typeof HTMLMediaElement
        !== 'undefined'
        ? HTMLMediaElement
          .HAVE_CURRENT_DATA
        : 2;

    if (
      !video.currentSrc
      || (
        video.readyState || 0
      ) < minReadyState
    ) {
      console.log(
        AUDIO_AHEAD_LOG_PREFIX,
        'waiting for video/audio tracks',
        {
          videoId:
            activeVideoId,
          readyState:
            video.readyState
            || 0,
          currentSrc:
            video.currentSrc
            || null,
        }
      );

      return;
    }

    const tabCapture =
      await requestTabCaptureAudioStream();

    if (tabCapture.stream) {
      await startAudioPipeline(
        tabCapture.stream,
        'tab_capture',
        video,
        'tabCapture'
      );

      return;
    }

    const videoCapture =
      requestVideoCaptureStream(
        video
      );

    if (videoCapture.stream) {
      await startAudioPipeline(
        videoCapture.stream,
        'video_capture_stream',
        video,
        videoCapture.captureMethod
      );

      return;
    }

    const reasons = [
      tabCapture.failureReason,
      videoCapture.failureReason,
    ].filter(Boolean);

    const finalReason =
      reasons.includes(
        'audio_capture_permission_denied'
      )
        ? 'audio_capture_permission_denied'
        : 'audio_capture_unavailable';

    if (
      finalReason ===
      'audio_capture_permission_denied'
    ) {
      audioCapturePermissionDenied =
        true;
    }

    lastAudioCaptionSource =
      'audio_stt';

    lastAudioCaptionFailureReason =
      finalReason;

    console.warn(
      '[ISWEEP][AUDIO_CAPTIONS] audio_capture_unavailable',
      {
        videoId:
          activeVideoId,
        failure_reason:
          finalReason,
        tab_failure_reason:
          tabCapture.failureReason
          || null,
        video_failure_reason:
          videoCapture.failureReason
          || null,
      }
    );
  }

  // ──────────────────────────────────────────────────────

  function handleVideoIdChange(newVideoId) {
    if (!newVideoId) {
      if (activeVideoId) {
        console.log(
          MARKER_LOG_PREFIX,
          'video id change',
          {
            from:
              activeVideoId,
            to:
              null,
          }
        );
      }

      activeVideoId =
        null;

      preAnalyzedCleanCaptions =
        [];

      stopAudioCapture(
        'video_id_lost'
      );

      resetCaptionTimelineState('video_id_lost');

      resetMarkerEngine(
        'missing_video_id'
      );

      updateCleanOverlay(
        '',
        0
      );

      return;
    }

    if (
      newVideoId ===
      activeVideoId
    ) {
      return;
    }

    console.log(
      MARKER_LOG_PREFIX,
      'video id change',
      {
        from:
          activeVideoId,
        to:
          newVideoId,
      }
    );

    activeVideoId =
      newVideoId;

    preAnalyzedCleanCaptions =
      [];

    preCachedAudioCleanCaptions =
      [];

    liveAudioCleanCaptions =
      [];

    lastAudioCaptionSource =
      null;

    lastAudioCaptionText =
      '';

    lastAudioCaptionReceivedAtMs =
      0;

    lastAudioCaptionFailureReason =
      null;

    audioCapturePermissionDenied =
      false;

    tabAudioCaptureState =
      'idle';

    stopAudioCapture(
      'video_changed'
    );

    resetCaptionTimelineState('video_changed');

    resetMarkerEngine(
      'video changed'
    );

    safeRuntimeSendMessage({
      type: 'isweep_audio_capture_video_changed',
      video_id: newVideoId,
      source_start_seconds: Number(findVideo()?.currentTime) || 0,
    }).catch(() => {});

    analyzeCurrentVideoMarkers(false);

    ensureMarkerSchedulerRunning();

    if (
      ISWEEP_CONTENT_SCRIPT_AUDIO_AHEAD_ENABLED
      && cleanCaptionSettings
        .cleanCaptionsEnabled
    ) {
      setTimeout(
        startAudioCapture,
        1500
      );
    }
  }

  function startVideoWatchLoop() {
    if (
      cleanCaptionSettings
        .cleanCaptionsEnabled
    ) {
      return;
    }

    handleVideoIdChange(
      getCurrentVideoId()
    );

    if (
      markerVideoWatchInterval
    ) {
      return;
    }

    console.log(
      MARKER_LOG_PREFIX,
      'video watch loop started',
      {
        intervalMs: 1000,
      }
    );

    markerVideoWatchInterval =
      setInterval(() => {
        handleVideoIdChange(
          getCurrentVideoId()
        );

        if (
          ISWEEP_CONTENT_SCRIPT_AUDIO_AHEAD_ENABLED
          && tabAudioCaptureState
            !== 'ready'
          && tabAudioCaptureState
            !== 'starting'
          && activeVideoId
          && cleanCaptionSettings
            .cleanCaptionsEnabled
          && !audioAheadActive
          && !audioCapturePermissionDenied
        ) {
          startAudioCapture();
        }
      }, 1000);
  }

  function startCaptionVideoWatchLoop() {
    if (
      !cleanCaptionSettings
        .cleanCaptionsEnabled
    ) {
      return;
    }

    handleVideoIdChange(
      getCurrentVideoId()
    );

    if (
      captionVideoWatchInterval
    ) {
      return;
    }

    console.log(
      '[ISWEEP][AUDIO_CAPTIONS] caption-mode video watch loop started',
      {
        intervalMs: 1000,
      }
    );

    captionVideoWatchInterval =
      setInterval(() => {
        handleVideoIdChange(
          getCurrentVideoId()
        );

        if (
          ISWEEP_CONTENT_SCRIPT_AUDIO_AHEAD_ENABLED
          && tabAudioCaptureState
            !== 'ready'
          && tabAudioCaptureState
            !== 'starting'
          && activeVideoId
          && cleanCaptionSettings
            .cleanCaptionsEnabled
          && !audioAheadActive
          && !audioCapturePermissionDenied
        ) {
          startAudioCapture();
        }
      }, 1000);
  }

  function log(...args) {
    console.log(
      LOG_PREFIX,
      ...args
    );
  }

  function normalizeCaptionWord(word) {
    return (
      word || ''
    )
      .toLowerCase()
      .replace(
        /[^a-z0-9']/g,
        ''
      )
      .trim();
  }

  function normalizeCaptionText(text) {
    return (
      text || ''
    )
      .toLowerCase()
      .replace(
        /[^\w\s']/g,
        ' '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();
  }

  function normalizeFilterWord(word) {
    return (
      word || ''
    )
      .toLowerCase()
      .replace(
        /[^\w*\s]/g,
        ''
      )
      .trim();
  }

  function findVideo() {
    if (videoEl && document.contains(videoEl)) return videoEl;
    videoEl = document.querySelector('video');
    return videoEl;
  }

  function setCachedPreferences(prefs) {
    cachedPreferences = normalizePreferences(prefs);
    cachedPreferencesReady = true;
    return cachedPreferences;
  }

  function setCachedLocalReferences(references) {
    cachedLocalReferences = references && typeof references === 'object'
      ? references
      : {};
    return cachedLocalReferences;
  }

  function getFilterWords() {
    const preferences = cachedPreferences || normalizePreferences({});
    const language = preferences.categories?.language || {};
    const enabled = preferences.enabled !== false
      && preferences.blocklist?.enabled !== false
      && language.enabled !== false;

    return {
      enabled,
      words: enabled ? preferences.blocklist.items : [],
      source: 'saved_preferences',
    };
  }

  function expandWordFamily(word) {
    return [word, ...(WORD_FAMILY_VARIANTS[word] || [])];
  }

  function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function maskToRegex(word) {
    const normalized = normalizeFilterWord(word);
    if (!normalized) return /^$/;
    return new RegExp(`^${escapeRegex(normalized).replace(/\\\*/g, '.*')}$`, 'i');
  }

  function buildStretchRegex(word) {
    const normalized = normalizeFilterWord(word);
    if (!normalized) return /^$/;
    const body = Array.from(normalized)
      .map((character) => `${escapeRegex(character)}+`)
      .join('');
    return new RegExp(`^${body}$`, 'i');
  }

  function isProlongedVariant(word, baseWord) {
    return normalizeCaptionWord(word) !== normalizeCaptionWord(baseWord);
  }

  function deriveWordMatches(words, captionText) {
    const sourceWords = Array.isArray(words) && words.length
      ? words
      : normalizeCaptionText(captionText).split(/\s+/).filter(Boolean);
    const normalizedWords = sourceWords.map(normalizeCaptionWord);
    const matches = new Map();
    const filterMeta = getFilterWords();

    if (!filterMeta.enabled) return matches;

    filterMeta.words.forEach((rawFilter) => {
      const filter = normalizeFilterWord(rawFilter);
      if (!filter) return;

      const regexes = expandWordFamily(filter).map(maskToRegex);
      regexes.push(buildStretchRegex(filter));
      normalizedWords.forEach((word, index) => {
        if (!word || matches.has(index)) return;
        if (regexes.some((regex) => regex.test(word))) {
          matches.set(index, {
            index,
            baseWord: rawFilter,
            matchedVariant: sourceWords[index],
            prolonged: isProlongedVariant(word, filter),
            source: filterMeta.source,
          });
        }
      });
    });

    return matches;
  }

  function buildSelectedWordMuteWindows(words, selectedWords) {
    const timedWords = Array.isArray(words) ? words : [];
    const filters = new Set((selectedWords || []).map(normalizeFilterWord).filter(Boolean));
    return timedWords
      .map((entry) => {
        const word = normalizeCaptionWord(entry?.word || entry?.text);
        if (!word || !Number.isFinite(Number(entry?.start)) || !Number.isFinite(Number(entry?.end))) return null;
        const match = Array.from(filters).find((filter) => (
          maskToRegex(filter).test(word)
          || buildStretchRegex(filter).test(word)
          || expandWordFamily(filter).some((variant) => maskToRegex(variant).test(word))
        ));
        if (!match || Number(entry.end) <= Number(entry.start)) return null;
        return {
          start: Math.max(Number(entry.start) - WORD_MUTE_PRE_PAD_SEC, 0),
          end: Number(entry.end) + WORD_MUTE_POST_PAD_SEC,
          start_seconds: Math.max(Number(entry.start) - WORD_MUTE_PRE_PAD_SEC, 0),
          end_seconds: Number(entry.end) + WORD_MUTE_POST_PAD_SEC,
          matched_word: entry.word || entry.text,
          selected_word: match,
        };
      })
      .filter(Boolean)
      .reduce((windows, window) => {
        const previous = windows[windows.length - 1];
        if (previous && window.start <= previous.end + WORD_GAP_MERGE_MS / 1000) {
          previous.end = Math.max(previous.end, window.end);
          previous.end_seconds = previous.end;
          return windows;
        }
        windows.push(window);
        return windows;
      }, []);
  }

  function isSelectedWordMuteModeEnabled(settings = cleanCaptionSettings) {
    return settings?.cleanCaptionWordMuteMode === 'captions_word_mute';
  }

  function extractTimedWordsFromAudioPayload(payload = {}) {
    return normalizeTimedWords(payload.words);
  }

  function scheduleSelectedWordMutesFromAudioPayload(payload = {}, options = {}) {
    if (!isSelectedWordMuteModeEnabled(options.settingsOverride || cleanCaptionSettings)) return [];
    const words = extractTimedWordsFromAudioPayload(payload);
    const selectedWords = Array.isArray(options.selectedWords)
      ? options.selectedWords
      : getFilterWords().words;
    return buildSelectedWordMuteWindows(words, selectedWords);
  }

  function evaluateReferenceAlignmentCandidate(params = {}) {
    const isNearMatch = (left, right) => {
      if (left === right) return true;
      if (left.length < 4 || right.length < 4 || Math.abs(left.length - right.length) > 1) return false;
      let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
      for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
          current[rightIndex] = Math.min(
            current[rightIndex - 1] + 1,
            previous[rightIndex] + 1,
            previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
          );
        }
        previous = current;
      }
      return previous[right.length] <= 1;
    };
    const audio = new Set(normalizeCaptionText(params.sttText).split(/\s+/).filter(Boolean));
    const reference = new Set(normalizeCaptionText(params.candidateText).split(/\s+/).filter(Boolean));
    const shared = Array.from(audio).filter((word) => reference.has(word)
      || Array.from(reference).some((candidate) => isNearMatch(word, candidate)));
    const meaningful = shared.filter((word) => !['i', 'you', 'the', 'a', 'and', 'we', 'are', 'to', 'of'].includes(word));
    const timed = params.source === 'text_track' || params.source === 'page_caption_dom'
      ? (Number(params.startSec) <= Number(params.assist?.cue_end_seconds) && Number(params.endSec) >= Number(params.assist?.cue_start_seconds) ? 1 : 0)
      : 0.65;
    const coverage = audio.size ? shared.length / audio.size : 0;
    const aligned = meaningful.length >= 2 && coverage >= 0.5 && timed >= 0.45;
    return {
      status: aligned ? 'aligned' : 'rejected',
      score: coverage * 0.65 + timed * 0.35,
      audio_anchor_count: meaningful.length,
      reference_coverage: coverage,
      time_alignment_score: timed,
      source: params.source || 'none',
      reason: aligned ? 'strict_alignment_met' : 'insufficient_meaningful_audio_anchors',
    };
  }

  function resolveCaptionAlignment(params = {}) {
    const assist = params.assist || {};
    const diagnostics = evaluateReferenceAlignmentCandidate({
      ...params,
      source: params.source || assist.source,
      candidateText: assist.text,
    });
    if (assist.text && diagnostics.status === 'aligned') {
      return { text: assist.text, sourceLabel: 'audio_stt_plus_page_evidence', usedEvidence: true, diagnostics };
    }
    const reference = params.localReference?.lines?.[0];
    const referenceDiagnostics = reference
      ? evaluateReferenceAlignmentCandidate({ ...params, source: 'local_reference', candidateText: reference.text })
      : null;
    if (reference && referenceDiagnostics?.status === 'aligned') {
      return { text: reference.text, sourceLabel: 'audio_stt_plus_reference', usedEvidence: true, diagnostics: referenceDiagnostics };
    }
    return { text: String(params.sttText || ''), sourceLabel: 'audio_stt', usedEvidence: false, diagnostics: diagnostics.status ? diagnostics : { status: 'searching' } };
  }

  function fuseCaptionWithEvidence(sttText, assist, startSec, endSec) {
    return resolveCaptionAlignment({ sttText, assist, startSec, endSec });
  }

  function getSourceHierarchy() {
    return [
      { source: 'pre_analyzed', class: 'timed_text', role: 'primary_when_available' },
      { source: 'text_track', class: 'timed', role: 'primary_when_available' },
      { source: 'page_caption_dom', class: 'current_visible', role: 'primary_visible_caption' },
      { source: 'audio_stt_plus_page_evidence', class: 'timed', role: 'approved_stt_after_alignment' },
      { source: 'audio_stt_plus_reference', class: 'timed', role: 'approved_stt_after_alignment' },
      { source: 'audio_stt', class: 'timed', role: 'draft_hidden_until_aligned' },
      { source: 'visible_transcript', class: 'context_only', role: 'context_only' },
    ];
  }

  function runFastGuardFromTimedWords(words, selectedWords) {
    return buildSelectedWordMuteWindows(words, selectedWords);
  }

  function triggerSpeechEndedClear(reason = 'speech_ended') {
    scheduleSpeechEndedOverlayClear(reason);
  }

  function getCaptionStateSnapshot() {
    return {
      ...captionTimelineState,
      assist: { ...captionTimelineState.assist },
    };
  }

  function setReferenceAlignmentState(state = {}) {
    captionTimelineState.referenceLineIndex = state.referenceLineIndex ?? null;
    captionTimelineState.referenceLineId = state.referenceLineId ?? null;
    captionTimelineState.referenceVideoTime = state.referenceVideoTime ?? null;
  }

  function rescheduleMuteRestoreTimers(nowSec) {
    if (restoreMuteTimeout) clearTimeout(restoreMuteTimeout);
    if (hardRestoreTimeout) clearTimeout(hardRestoreTimeout);
    const video = findVideo();
    if (!video || muteLockUntilSec <= nowSec) {
      restoreMuteState('window_elapsed');
      return;
    }
    const delayMs = Math.max((muteLockUntilSec - (video.currentTime || nowSec)) * 1000, 0);
    restoreMuteTimeout = setTimeout(() => restoreMuteState('word_ended'), delayMs + 10);
    hardRestoreTimeout = setTimeout(() => restoreMuteState('hard_timeout'), delayMs + HARD_RESTORE_GRACE_MS + 50);
  }

  function applyMuteWindow(startSec, endSec, reason = 'selected_word') {
    const video = findVideo();
    if (!video || !Number.isFinite(Number(endSec))) return false;
    const nowSec = Number(video.currentTime || 0);
    const start = Math.max(Number(startSec) || nowSec, 0);
    const end = Math.max(Number(endSec), start);
    if (end <= nowSec) return false;

    if (muteLockUntilSec <= nowSec && shouldSkipMuteBecauseUserMuted(video.muted, isweepMuteActive)) {
      lastMuteOwner = 'user';
      return false;
    }

    if (muteLockUntilSec > nowSec) {
      if (end <= muteLockUntilSec) return true;
      muteLockUntilSec = end;
      rescheduleMuteRestoreTimers(nowSec);
      return true;
    }

    previousMuteState = Boolean(video.muted);
    if (!setMutedState(true, `start:${reason}`)) return false;
    isweepMuteActive = true;
    userWasMutedBeforeIsweepMute = previousMuteState;
    lastMuteOwner = 'isweep';
    muteWindowStartSec = start;
    muteLockUntilSec = end;
    startMuteEnforcement();
    rescheduleMuteRestoreTimers(nowSec);
    console.log(WORD_MUTE_LOG_PREFIX, 'mute start', {
      start_seconds: start,
      end_seconds: end,
      reason,
    });
    return true;
  }

  function getMarkerEarlyWindowSec(action) {
    return action === 'mute' ? PROFANITY_MARKER_FIRE_EARLY_SEC : 0;
  }

  function shouldFireMarker(marker, nowSec, fired = new Set()) {
    if (!marker || fired.has(marker.id)) return false;
    const early = getMarkerEarlyWindowSec(marker.action);
    return Number(nowSec) >= Number(marker.start_seconds) - early
      && Number(nowSec) <= Number(marker.end_seconds || marker.start_seconds) + 0.25;
  }

  function estimatePageWordDurationSec(text, observedCaptionDurationSec) {
    const wordCount = normalizeCaptionText(text).split(/\s+/).filter(Boolean).length;
    const observed = Number(observedCaptionDurationSec);
    if (wordCount > 0 && Number.isFinite(observed) && observed >= 0.45 && observed <= 3.5) {
      return Math.max(0.22, Math.min(0.65, observed / wordCount));
    }
    return PAGE_SELECTED_WORD_MUTE_DEFAULT_WORD_SEC;
  }

  function estimatePageSelectedWordMuteDurationSec(word, wordDurationSec) {
    const normalizedWord = normalizeCaptionWord(word);
    const fallback = 0.24 + Math.min(Math.max(normalizedWord.length, 1), 12) * 0.035;
    const observed = Number(wordDurationSec);
    const duration = Number.isFinite(observed) && observed > 0 ? observed : fallback;
    return Math.max(
      PAGE_SELECTED_WORD_MUTE_MIN_SEC,
      Math.min(PAGE_SELECTED_WORD_MUTE_MAX_SEC, duration),
    );
  }

  function schedulePageSelectedWordMute(startSec, endSec, reason) {
    if (pageSelectedWordMuteTimer) clearTimeout(pageSelectedWordMuteTimer);
    pageSelectedWordMuteTimer = null;

    const video = findVideo();
    if (!video) return false;
    const nowSec = Number(video.currentTime || 0);
    const delayMs = Math.max((Number(startSec) - nowSec) * 1000, 0);
    if (delayMs > 80 && delayMs <= 1500) {
      pageSelectedWordMuteTimer = setTimeout(() => {
        pageSelectedWordMuteTimer = null;
        applyMuteWindow(startSec, endSec, reason);
      }, delayMs);
      return true;
    }
    return applyMuteWindow(nowSec, nowSec + Math.max(Number(endSec) - Number(startSec), 0), reason);
  }

  function observePageCaption(text, source = 'page_caption_dom') {
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleanText) return;
    if (!cleanCaptionSettings.cleanCaptionsEnabled || !isSelectedWordMuteModeEnabled()) return;
    const video = findVideo();
    const nowSec = Number(video?.currentTime || 0);
    const signature = `${activeVideoId || getCurrentVideoId()}|${normalizeCaptionText(cleanText)}`;
    const nowMs = Date.now();
    const previousText = lastPageCaptionText;
    const previousVideoTime = lastPageCaptionVideoTime;
    const captionChanged = normalizeCaptionText(cleanText) !== normalizeCaptionText(previousText);
    const observedCaptionDurationSec = captionChanged && Number.isFinite(Number(previousVideoTime))
      ? nowSec - Number(previousVideoTime)
      : 0;

    if (captionChanged) {
      if (pageSelectedWordMuteTimer) {
        clearTimeout(pageSelectedWordMuteTimer);
        pageSelectedWordMuteTimer = null;
      }
      lastPageCaptionText = cleanText;
      lastPageCaptionVideoTime = nowSec;
    }

    if (signature === lastPageSelectedWordMuteSignature
      && nowMs - lastPageSelectedWordMuteAtMs < PAGE_SELECTED_WORD_MUTE_RETRIGGER_MS) return;

    const matches = deriveWordMatches([], cleanText);
    if (!matches.size) return;

    const previousWords = new Set(
      normalizeCaptionText(previousText).split(/\s+/).filter(Boolean).map(normalizeCaptionWord),
    );
    const newlyIntroducedMatches = Array.from(matches.values()).filter((entry) => (
      !previousWords.has(normalizeCaptionWord(entry.matchedVariant))
    ));
    const targetMatches = newlyIntroducedMatches.length
      ? newlyIntroducedMatches
      : previousText ? [] : Array.from(matches.values());

    if (!targetMatches.length) return;

    lastPageSelectedWordMuteSignature = signature;
    lastPageSelectedWordMuteAtMs = nowMs;

    const wordDurationSec = estimatePageWordDurationSec(cleanText, observedCaptionDurationSec);
    const firstTarget = targetMatches[0];
    const startsWithNewWord = newlyIntroducedMatches.length > 0;
    const wordOffsetSec = startsWithNewWord
      ? 0
      : Math.max(Number(firstTarget.index) || 0, 0) * wordDurationSec;
    const muteDurationSec = Math.max(
      ...targetMatches.map((entry) => estimatePageSelectedWordMuteDurationSec(
        entry.matchedVariant,
        wordDurationSec,
      )),
    );
    const startSec = nowSec + wordOffsetSec;
    const endSec = startSec + muteDurationSec;
    schedulePageSelectedWordMute(startSec, endSec, `page_caption:${source}`);
    console.log(WORD_MUTE_LOG_PREFIX, 'page selected word detected', {
      source,
      text: cleanText,
      words: targetMatches.map((entry) => entry.matchedVariant),
      start_seconds: startSec,
      end_seconds: endSec,
      duration_seconds: muteDurationSec,
      timing: startsWithNewWord ? 'new_word_mutation' : 'caption_word_position_estimate',
    });
  }

  function extractCaptionText() {
    return Array.from(document.querySelectorAll('.ytp-caption-segment'))
      .map((element) => String(element.textContent || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function observeCaptionVideoTime(video) {
    const currentTime = Number(video?.currentTime);
    if (!Number.isFinite(currentTime)) return;

    const previousTime = Number(captionTimelineState.lastObservedVideoTimeSec);
    const discontinuity = Number.isFinite(previousTime)
      && (
        video.seeking === true
        || currentTime < previousTime - 0.75
        || Math.abs(currentTime - previousTime) > 4
      );

    if (discontinuity) {
      resetCaptionTimelineState('video_seeked');
      firedMarkerIds = new Set();
      markerPastEndLogged = false;
    }

    captionTimelineState.lastObservedVideoTimeSec = currentTime;
  }

  function pollVisibleCaptions() {
    const video = findVideo();
    if (!video) return;
    handleVideoIdChange(getCurrentVideoId());
    observeCaptionVideoTime(video);
    const text = extractCaptionText();
    if (text) {
      lastCaptionText = text;
      lastLiveCaptionObservedAtMs = Date.now();
      observePageCaption(text, 'page_caption_dom');
      updateCleanOverlay(text, video.currentTime || 0);
    }
    if (cleanCaptionOverlayEl) positionCleanCaptionOverlay(video);
  }

  function normalizeCleanCaptionSettings(settings) {
    const raw = settings && typeof settings === 'object' ? settings : {};
    const styles = new Set(['transparent_white', 'white_black', 'black_white']);
    const sizes = new Set(['small', 'medium', 'large']);
    const position = raw.cleanCaptionPosition && typeof raw.cleanCaptionPosition === 'object'
      ? raw.cleanCaptionPosition
      : {};
    const positionX = Number(position.x);
    const positionY = Number(position.y);
    return {
      ...CLEAN_CAPTION_DEFAULTS,
      ...raw,
      cleanCaptionsEnabled: raw.cleanCaptionsEnabled !== false,
      cleanCaptionStyle: styles.has(raw.cleanCaptionStyle) ? raw.cleanCaptionStyle : CLEAN_CAPTION_DEFAULTS.cleanCaptionStyle,
      cleanCaptionTextSize: sizes.has(raw.cleanCaptionTextSize) ? raw.cleanCaptionTextSize : CLEAN_CAPTION_DEFAULTS.cleanCaptionTextSize,
      cleanCaptionPosition: {
        x: Math.min(Math.max(Number.isFinite(positionX) ? positionX : CLEAN_CAPTION_DEFAULTS.cleanCaptionPosition.x, 0), 1),
        y: Math.min(Math.max(Number.isFinite(positionY) ? positionY : CLEAN_CAPTION_DEFAULTS.cleanCaptionPosition.y, 0), 1),
      },
    };
  }

  function stripCategoryLabelsFromCaption(text) {
    return String(text || '')
      .replace(/\b(language|sexual|violence|profanity)\s*:?\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function toCleanCaptionText(text) {
    const value = String(text || '');
    const filters = getFilterWords();
    if (!filters.enabled || !filters.words.length) return value;
    return value.split(/(\s+)/).map((part) => {
      const tokenMatch = part.match(/^([^a-z0-9']*)([a-z0-9']+)([^a-z0-9']*)$/i);
      const word = normalizeCaptionWord(tokenMatch ? tokenMatch[2] : part);
      const isBlocked = filters.words.some((filter) => (
        maskToRegex(filter).test(word)
        || buildStretchRegex(filter).test(word)
        || expandWordFamily(filter).some((variant) => maskToRegex(variant).test(word))
      ));
      if (!isBlocked) return part;
      return tokenMatch
        ? `${tokenMatch[1]}___${tokenMatch[3]}`
        : '___';
    }).join('');
  }

  function setNativeCaptionVisualHidden(hidden) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const nativeElements = document.querySelectorAll(
      '.ytp-caption-window-container, .ytp-caption-window-rollup, .caption-window',
    );

    nativeElements.forEach((element) => {
      if (!element?.style) return;
      if (hidden) {
        if (!nativeCaptionStyleCache.has(element)) {
          nativeCaptionStyleCache.set(element, {
            display: element.style.getPropertyValue('display'),
            displayPriority: element.style.getPropertyPriority('display'),
            visibility: element.style.getPropertyValue('visibility'),
            visibilityPriority: element.style.getPropertyPriority('visibility'),
          });
        }
        element.style.setProperty('display', 'none', 'important');
        element.style.setProperty('visibility', 'hidden', 'important');
      } else {
        const previous = nativeCaptionStyleCache.get(element);
        if (!previous) return;
        if (previous.display) {
          element.style.setProperty('display', previous.display, previous.displayPriority);
        } else {
          element.style.removeProperty('display');
        }
        if (previous.visibility) {
          element.style.setProperty('visibility', previous.visibility, previous.visibilityPriority);
        } else {
          element.style.removeProperty('visibility');
        }
        nativeCaptionStyleCache.delete(element);
      }
    });
  }

  function getNormalizedCaptionPosition(
    width,
    height,
    overlayWidth,
    overlayHeight,
    centerX = Number(width) / 2,
    centerY = Number(height) / 2,
  ) {
    const safeWidth = Math.max(Number(width) || 0, 1);
    const safeHeight = Math.max(Number(height) || 0, 1);
    const safeOverlayWidth = Math.min(
      Math.max(Number(overlayWidth) || 0, 0),
      safeWidth,
    );
    const safeOverlayHeight = Math.min(
      Math.max(Number(overlayHeight) || 0, 0),
      safeHeight,
    );
    const minX = safeOverlayWidth / 2;
    const maxX = Math.max(minX, safeWidth - (safeOverlayWidth / 2));
    const minY = safeOverlayHeight / 2;
    const maxY = Math.max(
      minY,
      safeHeight - (safeOverlayHeight / 2) - CLEAN_CAPTION_CONTROL_SAFE_BOTTOM_PX,
    );
    const requestedX = Number.isFinite(Number(centerX)) ? Number(centerX) : safeWidth / 2;
    const requestedY = Number.isFinite(Number(centerY)) ? Number(centerY) : safeHeight / 2;

    return {
      x: Math.min(Math.max(requestedX, minX), maxX) / safeWidth,
      y: Math.min(Math.max(requestedY, minY), maxY) / safeHeight,
    };
  }

  function getCaptionVideoRect(video = findVideo()) {
    const rect = video?.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return rect;
  }

  function positionCleanCaptionOverlay(
    video = findVideo(),
    requestedPosition = cleanCaptionSettings.cleanCaptionPosition,
  ) {
    if (!cleanCaptionOverlayEl) return null;
    const videoRect = getCaptionVideoRect(video);
    if (!videoRect) return null;

    cleanCaptionOverlayEl.style.maxWidth = `${Math.max(videoRect.width * 0.82, 1)}px`;
    const overlayRect = cleanCaptionOverlayEl.getBoundingClientRect?.();
    const overlayWidth = Number(overlayRect?.width) || 0;
    const overlayHeight = Number(overlayRect?.height) || 0;
    const position = getNormalizedCaptionPosition(
      videoRect.width,
      videoRect.height,
      overlayWidth,
      overlayHeight,
      Number(requestedPosition?.x) * videoRect.width,
      Number(requestedPosition?.y) * videoRect.height,
    );

    cleanCaptionOverlayEl.style.left = `${videoRect.left + (position.x * videoRect.width)}px`;
    cleanCaptionOverlayEl.style.top = `${videoRect.top + (position.y * videoRect.height)}px`;
    cleanCaptionOverlayEl.style.setProperty(
      '--isweep-caption-left',
      `${videoRect.left + (position.x * videoRect.width)}px`,
    );
    cleanCaptionOverlayEl.style.setProperty(
      '--isweep-caption-top',
      `${videoRect.top + (position.y * videoRect.height)}px`,
    );
    cleanCaptionOverlayEl.style.setProperty(
      '--isweep-caption-max-width',
      `${Math.max(videoRect.width * 0.82, 1)}px`,
    );
    cleanCaptionOverlayEl.style.transform = 'translate(-50%, -50%)';
    return position;
  }

  function persistCleanCaptionPosition(position) {
    const normalized = normalizeCleanCaptionSettings({
      ...cleanCaptionSettings,
      cleanCaptionPosition: position,
    });
    cleanCaptionSettings = normalized;
    if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) return;
    chrome.storage.local.set({
      [STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]: normalized,
    }).catch(() => {});
  }

  function handleCaptionPointerDown(event) {
    if (!cleanCaptionOverlayEl || cleanCaptionOverlayEl.style.display === 'none') return;
    if (typeof event.button === 'number' && event.button !== 0) return;

    const video = findVideo();
    const videoRect = getCaptionVideoRect(video);
    const overlayRect = cleanCaptionOverlayEl.getBoundingClientRect?.();
    if (!videoRect || !overlayRect) return;

    cleanCaptionDragState = {
      pointerId: event.pointerId,
      video,
      videoRect,
      overlayWidth: Number(overlayRect.width) || 0,
      overlayHeight: Number(overlayRect.height) || 0,
      startClientX: Number(event.clientX) || 0,
      startClientY: Number(event.clientY) || 0,
      startPosition: { ...cleanCaptionSettings.cleanCaptionPosition },
      moved: false,
    };

    event.preventDefault();
    event.stopPropagation();
    try {
      cleanCaptionOverlayEl.setPointerCapture?.(event.pointerId);
    } catch (_) {}
  }

  function handleCaptionPointerMove(event) {
    const state = cleanCaptionDragState;
    if (!state || state.pointerId !== event.pointerId) return;

    const deltaX = (Number(event.clientX) || 0) - state.startClientX;
    const deltaY = (Number(event.clientY) || 0) - state.startClientY;
    if (!state.moved && Math.hypot(deltaX, deltaY) < CLEAN_CAPTION_DRAG_THRESHOLD_PX) return;

    state.moved = true;
    const centerX = (state.startPosition.x * state.videoRect.width) + deltaX;
    const centerY = (state.startPosition.y * state.videoRect.height) + deltaY;
    const nextPosition = getNormalizedCaptionPosition(
      state.videoRect.width,
      state.videoRect.height,
      state.overlayWidth,
      state.overlayHeight,
      centerX,
      centerY,
    );

    cleanCaptionSettings.cleanCaptionPosition = nextPosition;
    positionCleanCaptionOverlay(state.video, nextPosition);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleCaptionPointerEnd(event) {
    const state = cleanCaptionDragState;
    if (!state || state.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    if (state.moved) {
      persistCleanCaptionPosition(cleanCaptionSettings.cleanCaptionPosition);
    }
    try {
      cleanCaptionOverlayEl.releasePointerCapture?.(event.pointerId);
    } catch (_) {}
    cleanCaptionDragState = null;
  }

  function updateCleanOverlay(liveText = lastCaptionText, nowSec = 0) {
    if (!cleanCaptionSettings.cleanCaptionsEnabled || typeof document === 'undefined') {
      setNativeCaptionVisualHidden(false);
      if (cleanCaptionOverlayEl) cleanCaptionOverlayEl.style.display = 'none';
      return;
    }

    if (!cleanCaptionOverlayEl) {
      cleanCaptionOverlayEl = document.createElement('div');
      cleanCaptionTextEl = document.createElement('div');
      cleanCaptionOverlayEl.dataset.isweepCleanCaptions = 'true';
      cleanCaptionOverlayEl.style.position = 'fixed';
      cleanCaptionOverlayEl.style.zIndex = '2147483647';
      cleanCaptionOverlayEl.style.maxWidth = '80vw';
      cleanCaptionOverlayEl.style.pointerEvents = 'auto';
      cleanCaptionOverlayEl.style.textAlign = 'center';
      cleanCaptionOverlayEl.style.cursor = 'move';
      cleanCaptionOverlayEl.style.userSelect = 'none';
      cleanCaptionOverlayEl.style.touchAction = 'none';
      cleanCaptionOverlayEl.addEventListener('pointerdown', handleCaptionPointerDown, { passive: false });
      cleanCaptionOverlayEl.addEventListener('pointermove', handleCaptionPointerMove, { passive: false });
      cleanCaptionOverlayEl.addEventListener('pointerup', handleCaptionPointerEnd, { passive: false });
      cleanCaptionOverlayEl.addEventListener('pointercancel', handleCaptionPointerEnd, { passive: false });
      cleanCaptionOverlayEl.appendChild(cleanCaptionTextEl);
      (document.body || document.documentElement).appendChild(cleanCaptionOverlayEl);
    }

    const result = getBestCleanCaptionText(liveText, nowSec);
    const text = result.text || '';
    const hasValidCleanText = Boolean(text.trim()) && result.stale !== true && result.waiting !== true;
    setNativeCaptionVisualHidden(hasValidCleanText);
    cleanCaptionOverlayEl.dataset.isweepCaptionSource = result.source || '';
    cleanCaptionTextEl.textContent = text;
    cleanCaptionTextEl.style.fontSize = CLEAN_CAPTION_SIZE_PX[
      cleanCaptionSettings.cleanCaptionTextSize
    ] || CLEAN_CAPTION_SIZE_PX.medium;
    cleanCaptionTextEl.style.color = cleanCaptionSettings.cleanCaptionStyle === 'white_black' ? '#111' : '#fff';
    cleanCaptionTextEl.style.background = cleanCaptionSettings.cleanCaptionStyle === 'transparent_white'
      ? 'transparent'
      : cleanCaptionSettings.cleanCaptionStyle === 'white_black' ? '#fff' : '#000';
    cleanCaptionTextEl.style.textShadow = cleanCaptionSettings.cleanCaptionStyle === 'white_black'
      ? 'none'
      : '0 1px 3px #000, 0 1px 8px #000';
    cleanCaptionTextEl.style.padding = '0.15em 0.35em';
    cleanCaptionTextEl.style.borderRadius = '3px';
    cleanCaptionOverlayEl.style.pointerEvents = hasValidCleanText ? 'auto' : 'none';
    cleanCaptionOverlayEl.style.display = hasValidCleanText ? 'block' : 'none';
    if (hasValidCleanText) positionCleanCaptionOverlay();
  }

  function resolveOverlayDisplayState(current, previous, nowMs, bridgeGapMs, options = {}) {
    if (current?.stale) {
      return { ...current, text: '', source: 'stale', visible: false, stale: true };
    }
    const next = current && current.text ? current : null;
    if (next) return { ...next, visible: true, bridged: false };
    if (options.audioCaptionMode === 'stt_disabled') {
      return {
        text: options.sttDisabledText || CLEAN_CC_STT_DISABLED_TEXT,
        source: 'audio_stt_disabled',
        visible: true,
      };
    }
    if (previous?.visible && previous.text && nowMs - Number(previous.updatedAtMs || 0) <= bridgeGapMs) {
      return { ...previous, visible: true, bridged: true };
    }
    if (options.cleanCaptionsEnabled === true) {
      return { text: options.placeholderText || CLEAN_CC_PLACEHOLDER_TEXT, source: 'waiting_audio_text', visible: true, waiting: true };
    }
    return { text: '', source: 'disabled', visible: false };
  }

  function estimatePlaceholderWordWindow(text, captionStartSec, captionDurationSec, currentVideoTime, source) {
    const placeholderToken = '__ISWEEP_REDACTED_PLACEHOLDER__';
    const normalizedText = String(text || '').replace(REDACTED_PLACEHOLDER_PATTERN, placeholderToken);
    const words = normalizedText.trim().split(/\s+/).filter(Boolean);
    const index = words.findIndex((word) => word === placeholderToken);
    if (index < 0) return null;
    const duration = Math.max(Number(captionDurationSec) || 0, PLACEHOLDER_WORD_ESTIMATED_SEC * words.length);
    const wordDuration = duration / words.length;
    const estimated = Number(captionStartSec) + index * wordDuration;
    const adjustedStart = Math.max(estimated - PLACEHOLDER_WORD_PREROLL_SEC, 0);
    return {
      text: String(text),
      captionStartSec: Number(captionStartSec),
      captionDurationSec: duration,
      wordsBeforePlaceholder: index,
      wordsAfterPlaceholder: words.length - index - 1,
      totalWords: words.length,
      estimatedPlaceholderStartSec: estimated,
      estimatedNextCleanWordStartSec: estimated + wordDuration,
      adjustedStart,
      muteEndSec: Math.min(estimated + wordDuration + PLACEHOLDER_BLEED_SEC, adjustedStart + MAX_PLACEHOLDER_MUTE_SEC),
      muteEndSource: 'clean_word_anchor',
      source,
    };
  }

  function hasNearbyAudioMuteMarker(events, startSec, endSec, anchorSec) {
    return (events || []).some((event) => event?.action === 'mute'
      && Number(event.end_seconds) >= Number(startSec)
      && Number(event.start_seconds) <= Number(endSec)
      && Math.abs(Number(event.start_seconds) - Number(anchorSec)) <= 0.35);
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === 'isweep_get_video_clock') {
        sendResponse(getVideoClockSnapshot());
        return false;
      }

      if (message?.type === 'isweep_tab_audio_capture_status') {
        const state = String(message.state || '').trim();
        if (state === 'starting' || state === 'stopped' || state === 'unavailable') {
          resetCaptionTimelineState(`audio_capture_${state}`);
        }
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === 'isweep_audio_caption_text') {
        sendResponse({ ok: acceptAudioCaptionRelay(message) });
        return false;
      }

      return undefined;
    });
  }

  if (typeof __ISWEEP_TEST_MODE__ === 'undefined' || !__ISWEEP_TEST_MODE__) {
    setInterval(pollVisibleCaptions, 100);
    document.addEventListener('yt-navigate-finish', () => handleVideoIdChange(getCurrentVideoId()));
    window.addEventListener('resize', () => positionCleanCaptionOverlay());
    document.addEventListener('fullscreenchange', () => positionCleanCaptionOverlay());
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get?.([
        STORAGE_KEYS.PREFS,
        STORAGE_KEYS.CLEAN_CAPTION_SETTINGS,
        STORAGE_KEYS.LOCAL_REFERENCES,
      ])
        ?.then?.((values) => {
          setCachedPreferences(values?.[STORAGE_KEYS.PREFS]);
          cleanCaptionSettings = normalizeCleanCaptionSettings(values?.[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]);
          setCachedLocalReferences(values?.[STORAGE_KEYS.LOCAL_REFERENCES]);
        })
        .catch(() => {});

      chrome.storage.onChanged?.addListener?.((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes[STORAGE_KEYS.PREFS]) {
          setCachedPreferences(changes[STORAGE_KEYS.PREFS].newValue);
          lastPageSelectedWordMuteSignature = '';
          lastPageSelectedWordMuteAtMs = 0;
        }
        if (changes[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS]) {
          cleanCaptionSettings = normalizeCleanCaptionSettings(
            changes[STORAGE_KEYS.CLEAN_CAPTION_SETTINGS].newValue,
          );
          if (!cleanCaptionSettings.cleanCaptionsEnabled
            || !isSelectedWordMuteModeEnabled()) {
            if (isweepMuteActive) restoreMuteState('caption_settings_changed');
            if (pageSelectedWordMuteTimer) {
              clearTimeout(pageSelectedWordMuteTimer);
              pageSelectedWordMuteTimer = null;
            }
          }
          updateCleanOverlay(lastCaptionText, findVideo()?.currentTime || 0);
          ensureMarkerSchedulerRunning();
        }
      });
    }
  }

  if (typeof globalThis !== 'undefined' && globalThis.__ISWEEP_TEST_MODE__) {
    globalThis.__ISWEEP_YT_TEST_HOOKS__ = {
      constants: { CLEAN_CAPTION_STALE_MS, CLEAN_CC_BRIDGE_GAP_MS, CLEAN_CC_STT_DISABLED_TEXT, AUDIO_CHUNK_SEC, AUDIO_CHUNK_OVERLAP_SEC, AUDIO_STT_HOLD_MS, WATCH_AHEAD_SECONDS, CLEAN_CAPTION_SIZE_PX, ISWEEP_YOUTUBE_DOM_FALLBACK_ENABLED, AUDIO_STT_DISPLAY_REQUIRES_ALIGNMENT },
      normalizeCleanCaptionSettings, setCachedPreferences, setCachedLocalReferences,
      toCleanCaptionText, stripCategoryLabelsFromCaption, limitCaptionText, getCleanCaptionDisplayText, getBestCleanCaptionText,
      getMuteWindowFromMarker, shouldISweepUnmute, shouldSkipMuteBecauseUserMuted,
      estimatePlaceholderWordWindow, hasNearbyAudioMuteMarker, getMarkerEarlyWindowSec,
      shouldFireMarker, shouldAllowMarkerAction, resolveOverlayDisplayState, getEntryTimingBounds,
      normalizePreAnalyzedCaptions, buildAudioResponseCaptions, acceptAudioCaptionRelay, shouldDedupAudioMarker,
      markerSourcePriority, buildSelectedWordMuteWindows, deriveWordMatches,
      estimatePageWordDurationSec, estimatePageSelectedWordMuteDurationSec,
      isSelectedWordMuteModeEnabled, scheduleSelectedWordMutesFromAudioPayload,
      extractTimedWordsFromAudioPayload, fuseCaptionWithEvidence,
      evaluateReferenceAlignmentCandidate, resolveCaptionAlignment,
      setReferenceAlignmentState, getSourceHierarchy,
      runFastGuardFromTimedWords, triggerSpeechEndedClear,
      getCaptionStateSnapshot,
      getNormalizedCaptionPosition,
    };
  }

})();
