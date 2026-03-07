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
  let captionBuffer = '';
  let bufferTimer = null;
  const BUFFER_DELAY_MS = 150;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function findVideo() {
    if (videoEl && typeof videoEl.paused !== 'undefined') return videoEl;
    const candidate = document.querySelector('video');
    if (candidate) {
      videoEl = candidate;
      log('Video element attached');
    }
    return videoEl;
  }

  function applyDecision(decision) {
    // Apply backend decision to the video element; mute uses caption-change restore plus safety cap.
    // Playback-only guard: we only change player state (mute/seek/rate) and never alter the underlying media or captions.
    const video = findVideo();
    if (!video) {
      log('No video element found for decision');
      return;
    }

    const durationMs = (decision.duration_seconds || 0) * 1000;
    const action = decision.action || 'none';
    log('Applying action:', action, 'for', decision.duration_seconds, 'seconds');

    if (action === 'mute') {
      if (restoreMuteTimeout) clearTimeout(restoreMuteTimeout);
      previousMuteState = video.muted;
      video.muted = true;
      muteUntilNextCaption = true;
      log('Muted; will restore on next caption change (safety cap active)');
      const safetyMs = Math.min(durationMs > 0 ? durationMs : 2000, 2500); // Prevents long mutes if caption timing fails.
      log('Applied mute for', decision.duration_seconds, 'seconds');
      restoreMuteTimeout = setTimeout(() => {
        video.muted = previousMuteState;
        muteUntilNextCaption = false;
        restoreMuteTimeout = null;
        log('Restored mute state (safety timeout)');
      }, safetyMs);
    } else if (action === 'skip') {
      video.currentTime = video.currentTime + (decision.duration_seconds || 0);
      log('Skipped ahead by', decision.duration_seconds, 'seconds');
    } else if (action === 'fast_forward') {
      if (restoreRateTimeout) clearTimeout(restoreRateTimeout);
      previousRate = video.playbackRate;
      video.playbackRate = 2.0;
      log('Fast-forwarding at 2x for', decision.duration_seconds, 'seconds');
      restoreRateTimeout = setTimeout(() => {
        video.playbackRate = previousRate || 1.0;
        log('Restored playback rate');
      }, durationMs || 8000);
    } else {
      muteUntilNextCaption = false;
      log('No action applied');
    }
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
      log('Decision received', response);
      applyDecision(response);
    } catch (err) {
      log('Failed to send caption', err);
    }
  }

  function restoreMuteAfterCaptionChange() {
    // Caption changed: immediately restore audio and clear the safety timeout.
    if (!muteUntilNextCaption) return;
    const video = findVideo();
    if (restoreMuteTimeout) {
      clearTimeout(restoreMuteTimeout);
      restoreMuteTimeout = null;
    }
    if (video && previousMuteState !== null) {
      video.muted = previousMuteState;
      log('Restored mute state on caption change');
    }
    previousMuteState = null;
    muteUntilNextCaption = false;
  }

  function processEndedCaption(text, durationSeconds, videoTime) {
    if (!text || durationSeconds === null) return;
    const words = text.split(/\s+/).filter(Boolean);
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
    sendCaption({ text, caption_duration_seconds: durationSeconds });
  }

  function processBufferedCaption(rawText) {
    // YouTube captions arrive incrementally; buffer small DOM updates so we react to stabilized phrases instead of partial words.
    const text = (rawText || '').trim();
    if (!text || text.length < 2 || text === lastCaptionText) return;

    const video = findVideo();
    const now = video && typeof video.currentTime === 'number' ? video.currentTime : null;
    const prevDuration = captionStartTime !== null && now !== null ? Math.max(0, now - captionStartTime) : null;

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
    const segments = Array.from(document.querySelectorAll('.ytp-caption-segment'));
    if (segments.length === 0) return '';
    return segments.map((el) => el.textContent.trim()).join(' ').trim();
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

    if (bufferTimer) clearTimeout(bufferTimer);
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
    observer.observe(captionsRoot, { childList: true, subtree: true });
    log('Caption observer attached to caption container');
  }

  function init() {
    findVideo();
    startObserving();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
