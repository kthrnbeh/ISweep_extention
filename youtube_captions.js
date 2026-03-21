// ISWEEP COMPONENT: YouTube Caption Listener
// Listens to on-page caption DOM changes, sends text to the background script,
// and applies the returned decision (mute/skip/fast-forward). Safety logic keeps
// mutes aligned to caption changes with a timeout fallback.
(function () {
  'use strict';

  const LOG_PREFIX = '[ISWEEP][YT]';
  // Track caption text and when it started so we can measure how long words are spoken.
  // Playback-only: ISweep never edits media or captions; it only controls live playback state (mute/unmute/seek/rate).
  let lastCaptionText = '';
  let captionStartTime = null; // When the current caption started; used to time how long it was spoken.
  let videoEl = null;
  let restoreMuteTimeout = null;
  let restoreRateTimeout = null;
  let previousMuteState = null;
  let previousRate = null;
  let muteUntilNextCaption = false;
  let muteLockUntilSec = 0; // Active mute window end (seconds, video time)
  let hardRestoreTimeout = null; // Final fail-safe unmute
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
      previousMuteState = video.muted; // Preserve prior mute state
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
      const v = findVideo();
      if (v) {
        v.muted = previousMuteState; // Restore previous mute state
      }
      muteUntilNextCaption = false;
      muteLockUntilSec = 0;
      restoreMuteTimeout = null;
      console.log('[ISweep Timing] mute restored (primary timer)', { endSec });
    }, remainingMs);

    // Hard fail-safe to guarantee unmute
    clearHardRestore();
    hardRestoreTimeout = setTimeout(() => {
      const v = findVideo();
      if (v) v.muted = previousMuteState;
      muteLockUntilSec = 0;
      muteUntilNextCaption = false;
      restoreMuteTimeout = null;
      console.log('[ISweep Timing] hard restore fired', { endSec });
    }, remainingMs + HARD_RESTORE_GRACE_MS);
  }

  function applyDecision(decision, captionStartSec, captionDurationSec) {
    // Apply backend decision with timing alignment using caption timing.
    const video = findVideo();
    if (!video) {
      log('No video element found for decision');
      return;
    }

    const action = decision.action || 'none';
    const backendDuration = decision.duration_seconds || 0;
    const nowSec = video.currentTime || 0;

    if (action === 'mute') {
      const durationSec = Math.max(backendDuration, captionDurationSec || backendDuration || 0); // Use caption duration if longer
      const startSec = (captionStartSec !== null && captionStartSec !== undefined)
        ? Math.max(captionStartSec - MUTE_PRE_BUFFER_MS / 1000, 0)
        : nowSec;
      const endSecRaw = startSec + durationSec;
      const endSec = endSecRaw + MUTE_POST_BUFFER_MS / 1000;

      // Skip stale windows (caption ended long ago)
      const staleMs = (nowSec - endSec) * 1000;
      if (staleMs > STALE_CAPTION_THRESHOLD_MS) {
        console.log('[ISweep Timing] stale caption skipped', { startSec, endSec, nowSec, staleMs });
        return;
      }

      applyMuteWindow(startSec, endSec, decision.reason || 'caption');
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
      applyDecision(response, payload.caption_start_sec, payload.caption_duration_seconds);
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
    sendCaption({ text, caption_duration_seconds: durationSeconds, caption_start_sec: startSec }); // Send ended caption with timing
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
    findVideo(); // Cache video element if present
    startObserving(); // Begin observing captions
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init); // Wait for DOM if still loading
  } else {
    init(); // DOM ready; start immediately
  }
})();
