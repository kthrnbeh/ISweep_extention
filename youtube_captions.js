// ISWEEP COMPONENT: YouTube Caption Listener
// Listens to on-page caption DOM changes, sends text to the background script,
// and applies the returned decision (mute/skip/fast-forward). Safety logic keeps
// mutes aligned to caption changes with a timeout fallback.
(function () {
  'use strict';

  const LOG_PREFIX = '[ISWEEP][YT]';
  // Track caption text and when it started so we can measure how long words are spoken.
  let lastCaptionText = '';
  let captionStartTime = null; // When the current caption started; used to time how long it was spoken.
  let videoEl = null;
  let restoreMuteTimeout = null;
  let restoreRateTimeout = null;
  let previousMuteState = null;
  let previousRate = null;
  let muteUntilNextCaption = false;

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
      const safetyMs = Math.min(durationMs > 0 ? durationMs : 2000, 2500); // Cap fallback mute to 2.5s to prevent over-muting.
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

  function handleCaptionText(rawText) {
    // YouTube can emit multiple DOM updates per caption; ignore empty, tiny, or unchanged text to avoid duplicates.
    const text = (rawText || '').trim();
    if (!text || text.length < 2 || text === lastCaptionText) return;

    const video = findVideo();
    const now = video && typeof video.currentTime === 'number' ? video.currentTime : null;
    // Duration is how long the previous caption stayed visible; aligns mute length to the word that just finished.
    const prevDuration = captionStartTime !== null && now !== null ? Math.max(0, now - captionStartTime) : null;

    // Restore audio immediately when the caption changes; background safety timeout is only a fallback.
    restoreMuteAfterCaptionChange();

    // Send the caption that just ended with its measured duration so backend can match mute timing to speech.
    if (lastCaptionText && prevDuration !== null) {
      console.log('[ISWEEP][CAPTION]', { text: lastCaptionText, duration: Number(prevDuration || 0), videoTime: now });
      sendCaption({ text: lastCaptionText, caption_duration_seconds: prevDuration });
    }

    // Start timing the new caption from this moment; its duration will be computed on the next change.
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
    if (caption) handleCaptionText(caption);
  });

  function startObserving() {
    // Observe the YouTube caption container instead of the whole DOM to cut down on noisy mutations.
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
