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
      console.log('[ISWEEP][WORD_MUTE] mute end', {
        reason,
        restore_to_muted: targetMuted,
      });
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
  const PAGE_SELECTED_WORD_MUTE_SEC = 0.85;
  const PAGE_SELECTED_WORD_MUTE_RETRIGGER_MS = 900;

  const MARKER_SCHEDULER_INTERVAL_MS = 100;
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
    cleanCaptionStyle: 'transparent_white',
    cleanCaptionTextSize: 'medium',
    cleanCaptionWordMuteMode: 'captions_only',
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
  let lastSelectedWordsLogSignature = '';
  let lastPageSelectedWordMuteSignature = '';
  let lastPageSelectedWordMuteAtMs = 0;

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

    captionTimelineState.referenceLineIndex = null;
    captionTimelineState.referenceLineId = null;
    captionTimelineState.referenceVideoTime = null;

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

  function getCleanCaptionDisplayText(entry) {
    if (!entry || typeof entry !== 'object') return '';

    const cleanCandidates = [
      entry.clean_text,
      entry.cleaned_text
    ];

    const cleanMatch = cleanCandidates.find(
      (value) => typeof value === 'string' && value.trim()
    );

    if (cleanMatch) {
      return stripCategoryLabelsFromCaption(cleanMatch.trim());
    }

    const rawCandidates = [
      entry.caption_text,
      entry.text
    ];

    const rawMatch = rawCandidates.find(
      (value) => typeof value === 'string' && value.trim()
    );

    if (!rawMatch) return '';

    return stripCategoryLabelsFromCaption(
      toCleanCaptionText(rawMatch.trim())
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
        source: typeof payload.source === 'string'
          ? payload.source
          : null,
        words: normalizedWords,
      },
    ]);
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