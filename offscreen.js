/*
ISWEEP COMPONENT: Offscreen Tab Audio Capture

Role: Own the extension tab-audio capture pipeline outside the service worker.
Receives start/stop commands from background.js, captures tab audio, chunks PCM,
and relays WAV chunks back to background for /captions/transcribe.
*/

const LOG_PREFIX = '[ISWEEP][AUDIO_CAPTIONS][OFFSCREEN]';
const AUDIO_DIAG_LOG = '[ISWEEP][AUDIO_DIAG]';
const CAPTION_LATENCY_LOG = '[ISWEEP][CAPTION_LATENCY]';
const AUDIO_SAMPLE_RATE = 16000;
// Recovery setting: do not send tiny 0.3s chunks to STT.
// Whisper-style transcription needs a few seconds of context or it guesses/hallucinates.
const AUDIO_CAPTION_CHUNK_SEC = 3.0;
const AUDIO_CAPTION_OVERLAP_SEC = 1.0;
const AUDIO_CAPTION_MIN_SEND_SEC = 2.25;
const VIDEO_CLOCK_POLL_MS = 250;
const VIDEO_CLOCK_DRIFT_TOLERANCE_SEC = 1.25;
const VAD_RMS_THRESHOLD = 0.012;
const VAD_SPEECH_END_HOLD_MS = 1200;

let offscreenChunkEmitCount = 0;
let audioChunkStartedAtMs = 0;
let captureStartedAtMs = 0;
let activeTabId = null;
let captureSessionId = '';
let captureSequenceNumber = 0;
let videoClockPollTimer = null;
let videoClockTimeSec = null;
let videoClockPaused = false;
let videoClockObservedAtMs = 0;
let vadSpeechActive = false;
let vadLastSpeechAtMs = 0;
let vadLastSentAtMs = 0;

console.log(LOG_PREFIX, 'loaded');
safeRuntimeSendMessage({ type: 'isweep_audio_diag', stage: 'offscreen_loaded' }).catch(() => {});

function isExtensionContextInvalidatedError(error) {
  const text = String(error?.message || error || '').trim().toLowerCase();
  return text.includes('extension context invalidated') || text.includes('receiving end does not exist');
}

async function safeRuntimeSendMessage(message) {
  if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
    console.warn('[ISWEEP][AUDIO_CAPTIONS] extension context invalidated; refresh page required');
    await stopCapture('extension_context_invalidated');
    return null;
  }
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      console.warn('[ISWEEP][AUDIO_CAPTIONS] extension context invalidated; refresh page required');
      await stopCapture('extension_context_invalidated');
      return null;
    }
    throw error;
  }
}

let audioCtx = null;
let audioProcessor = null;
let audioInputStream = null;
let audioSourceNode = null;
let monitorGainNode = null;
let workletKeepAliveGainNode = null;
let audioSampleBufs = [];
let audioChunkWarm = false;
let audioChunkStartSec = 0;
let running = false;
let activeVideoId = '';

function buildCaptureSessionId(tabId, videoId) {
  const safeTab = Number.isFinite(Number(tabId)) ? Number(tabId) : 0;
  const safeVideo = String(videoId || '').trim() || 'unknown_video';
  return `${safeTab}:${safeVideo}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function resolveSourceTimelineWindow(chunkStartSec, durationSec, clockTimeSec, paused = false) {
  const start = Number(chunkStartSec);
  const duration = Number(durationSec);
  const clock = Number(clockTimeSec);

  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
    return { discard: true, reason: 'invalid_audio_window', start_seconds: Number.isFinite(clock) ? clock : 0 };
  }

  if (paused && Number.isFinite(clock)) {
    return { discard: true, reason: 'video_paused', start_seconds: Math.max(clock, 0) };
  }

  const predictedEnd = start + duration;
  if (Number.isFinite(clock)) {
    const drift = clock - predictedEnd;
    if (Math.abs(drift) > VIDEO_CLOCK_DRIFT_TOLERANCE_SEC) {
      return { discard: true, reason: 'video_clock_discontinuity', start_seconds: Math.max(clock, 0) };
    }

    return {
      discard: false,
      start_seconds: Math.max(clock - duration, 0),
      end_seconds: Math.max(clock, 0),
      clock_aligned: true,
    };
  }

  return {
    discard: false,
    start_seconds: Math.max(start, 0),
    end_seconds: Math.max(predictedEnd, start + 0.05),
    clock_aligned: false,
  };
}

async function pollVideoClock() {
  if (!running || !Number.isFinite(Number(activeTabId)) || !chrome?.tabs?.sendMessage) return;

  try {
    const response = await chrome.tabs.sendMessage(Number(activeTabId), {
      type: 'isweep_get_video_clock',
      video_id: activeVideoId,
    });
    const currentTime = Number(response?.current_time);
    if (
      response?.ok === true
      && String(response.video_id || '').trim() === activeVideoId
      && Number.isFinite(currentTime)
    ) {
      videoClockTimeSec = Math.max(currentTime, 0);
      videoClockPaused = response.paused === true;
      videoClockObservedAtMs = Date.now();
    }
  } catch (_) {
    // The content script can be between YouTube SPA documents. Keep the last
    // source clock until the next successful poll rather than shifting time.
  }
}

function startVideoClockPolling() {
  if (videoClockPollTimer) clearInterval(videoClockPollTimer);
  void pollVideoClock();
  videoClockPollTimer = setInterval(() => {
    void pollVideoClock();
  }, VIDEO_CLOCK_POLL_MS);
}

if (typeof globalThis !== 'undefined' && globalThis.__ISWEEP_TEST_MODE__) {
  globalThis.__ISWEEP_OFFSCREEN_TEST_HOOKS__ = {
    resolveSourceTimelineWindow,
  };
}

function encodeWAV(sampleBufs, sampleRate) {
  const totalSamples = sampleBufs.reduce((n, b) => n + b.length, 0);
  const dataBytes = totalSamples * 2;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  sampleBufs.forEach((buf) => {
    for (let i = 0; i < buf.length; i += 1) {
      const value = Math.max(-1, Math.min(1, buf[i]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  });
  return out;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const parts = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length))));
  }
  return btoa(parts.join(''));
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

function measureAudioBuffers(sampleBufs) {
  let sampleCount = 0;
  let sumSquares = 0;
  let peak = 0;

  for (const buffer of sampleBufs || []) {
    if (!buffer || !buffer.length) continue;
    for (let index = 0; index < buffer.length; index += 1) {
      const value = Number(buffer[index]) || 0;
      const absolute = Math.abs(value);
      sampleCount += 1;
      sumSquares += value * value;
      if (absolute > peak) peak = absolute;
    }
  }

  return {
    sampleCount,
    rms: sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0,
    peak,
  };
}

async function flushAudioChunk(options = {}) {
  if (!running || !audioCtx || !audioSampleBufs.length) return;
  const force = options.force === true;
  const bufs = audioSampleBufs.slice();
  const sampleRate = audioCtx.sampleRate;
  const sampleCount = bufs.reduce((n, b) => n + b.length, 0);
  const audioMetrics = measureAudioBuffers(bufs);
  const durationSec = sampleRate > 0 ? sampleCount / sampleRate : 0;
  if (!force && durationSec < AUDIO_CAPTION_MIN_SEND_SEC) {
    return;
  }
  const sourceWindow = resolveSourceTimelineWindow(
    audioChunkStartSec,
    durationSec,
    videoClockTimeSec,
    videoClockPaused,
  );
  if (sourceWindow.discard) {
    audioSampleBufs = [];
    audioChunkWarm = false;
    audioChunkStartSec = Number(sourceWindow.start_seconds) || 0;
    audioChunkStartedAtMs = Date.now();
    console.log(LOG_PREFIX, 'audio window discarded', {
      videoId: activeVideoId,
      reason: sourceWindow.reason,
      source_start_seconds: audioChunkStartSec,
    });
    return;
  }

  const startSec = sourceWindow.start_seconds;
  const endSec = sourceWindow.end_seconds;
  const chunkStartedAt = Number.isFinite(Number(audioChunkStartedAtMs)) && audioChunkStartedAtMs > 0
    ? Number(audioChunkStartedAtMs)
    : Date.now();
  const chunkFlushedAt = Date.now();

  const overlapSamples = Math.floor(Math.max(AUDIO_CAPTION_OVERLAP_SEC, 0) * sampleRate);
  const overlapBufs = takeTailSampleBuffers(bufs, overlapSamples);
  const overlapCount = overlapBufs.reduce((n, b) => n + b.length, 0);
  const overlapDurationSec = sampleRate > 0 ? overlapCount / sampleRate : 0;
  audioSampleBufs = overlapBufs;
  audioChunkStartSec = Math.max(endSec - overlapDurationSec, 0);
  audioChunkStartedAtMs = Math.max(chunkFlushedAt - Math.round(overlapDurationSec * 1000), 0);
  audioChunkWarm = true;

  const wavBuf = encodeWAV(bufs, sampleRate);
  const audioChunk = arrayBufferToBase64(wavBuf);

  offscreenChunkEmitCount += 1;
  captureSequenceNumber += 1;
  const sequenceNumber = captureSequenceNumber;
  const chunkId = `${captureSessionId || 'session'}:${sequenceNumber}`;
  const audioWindowStartMs = Math.max(Math.round(startSec * 1000), 0);
  const audioWindowEndMs = Math.max(Math.round(endSec * 1000), audioWindowStartMs);
  console.log(LOG_PREFIX, 'chunk emitted', {
    videoId: activeVideoId,
    tabId: activeTabId,
    sessionId: captureSessionId,
    sequenceNumber,
    chunkId,
    start_seconds: startSec,
    end_seconds: endSec,
    sample_rate: sampleRate,
    sample_count: audioMetrics.sampleCount,
    rms: Number(audioMetrics.rms.toFixed(6)),
    peak: Number(audioMetrics.peak.toFixed(6)),
  });
  console.log(AUDIO_DIAG_LOG, 'offscreen chunk emitted', {
    videoId: activeVideoId,
    chunkCount: offscreenChunkEmitCount,
  });
  console.log(CAPTION_LATENCY_LOG, 'chunk flushed', {
    videoId: activeVideoId,
    chunkStartedAt,
    chunkFlushedAt,
    chunkDurationMs: Math.max(chunkFlushedAt - chunkStartedAt, 0),
    chunkWindowSec: AUDIO_CAPTION_CHUNK_SEC,
    overlapSec: AUDIO_CAPTION_OVERLAP_SEC,
    forced: force,
  });
  if (offscreenChunkEmitCount % 10 === 0) {
    safeRuntimeSendMessage({
      type: 'isweep_audio_diag',
      stage: 'offscreen_chunk_emitted',
      chunkCount: offscreenChunkEmitCount,
      sampleCount: bufs.reduce((n, b) => n + b.length, 0),
      chunkStartedAt,
      chunkFlushedAt,
      chunkWindowSec: AUDIO_CAPTION_CHUNK_SEC,
    }).catch(() => {});
  }
  await safeRuntimeSendMessage({
    type: 'isweep_audio_caption_chunk',
    tab_id: Number.isFinite(Number(activeTabId)) ? Number(activeTabId) : null,
    video_id: activeVideoId,
    session_id: captureSessionId,
    sequence_number: sequenceNumber,
    chunk_id: chunkId,
    sampleRate,
    channels: 1,
    audio_chunk: audioChunk,
    mime_type: 'audio/wav',
    start_seconds: startSec,
    end_seconds: endSec,
    capture_started_at: chunkStartedAt,
    chunk_started_at: chunkStartedAt,
    chunk_flushed_at: chunkFlushedAt,
    chunk_emitted_at: chunkFlushedAt,
    audio_window_start_ms: audioWindowStartMs,
    audio_window_end_ms: audioWindowEndMs,
    chunk_window_sec: AUDIO_CAPTION_CHUNK_SEC,
    chunk_overlap_sec: AUDIO_CAPTION_OVERLAP_SEC,
    vad_state: vadSpeechActive ? 'speech_active' : 'speech_end',
    audio_rms: Number(audioMetrics.rms.toFixed(6)),
    audio_peak: Number(audioMetrics.peak.toFixed(6)),
    sample_count: audioMetrics.sampleCount,
  }).catch(() => {});
}

function computeFrameRms(samples) {
  const frame = Array.isArray(samples) || samples instanceof Float32Array ? samples : [];
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = Number(frame[i]) || 0;
    sum += value * value;
  }
  return Math.sqrt(sum / frame.length);
}

function maybeSendVadState(speechActive, reason = 'frame') {
  const now = Date.now();
  const changed = speechActive !== vadSpeechActive;
  const periodic = (now - vadLastSentAtMs) >= 600;
  if (!changed && !periodic) return;
  vadSpeechActive = speechActive;
  vadLastSentAtMs = now;
  safeRuntimeSendMessage({
    type: 'isweep_audio_vad_state',
    tab_id: Number.isFinite(Number(activeTabId)) ? Number(activeTabId) : null,
    video_id: activeVideoId || null,
    session_id: captureSessionId || null,
    speech_active: speechActive === true,
    reason,
    observed_at: now,
  }).catch(() => {});
}

function updateVadFromFrame(samples) {
  const now = Date.now();
  const rms = computeFrameRms(samples);
  if (rms >= VAD_RMS_THRESHOLD) {
    vadLastSpeechAtMs = now;
    maybeSendVadState(true, 'rms_active');
    return;
  }
  if ((now - vadLastSpeechAtMs) >= VAD_SPEECH_END_HOLD_MS) {
    maybeSendVadState(false, 'rms_speech_end');
  }
}

async function stopCapture(reason = 'stopped') {
  if (running && audioCtx && audioSampleBufs.length) {
    try {
      await flushAudioChunk({ force: true });
    } catch (_) {
      // best-effort final flush
    }
  }
  running = false;
  if (audioSourceNode) {
    try { audioSourceNode.disconnect(); } catch (_) {}
    audioSourceNode = null;
  }
  if (audioProcessor) {
    try { audioProcessor.disconnect(); } catch (_) {}
    audioProcessor = null;
  }
  if (monitorGainNode) {
    try { monitorGainNode.disconnect(); } catch (_) {}
    monitorGainNode = null;
  }
  if (workletKeepAliveGainNode) {
    try { workletKeepAliveGainNode.disconnect(); } catch (_) {}
    workletKeepAliveGainNode = null;
  }
  if (audioCtx) {
    try { await audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  if (audioInputStream && typeof audioInputStream.getTracks === 'function') {
    audioInputStream.getTracks().forEach((track) => {
      try { track.stop(); } catch (_) {}
    });
  }
  audioInputStream = null;
  audioSampleBufs = [];
  audioChunkWarm = false;
  audioChunkStartSec = 0;
  audioChunkStartedAtMs = 0;
  if (videoClockPollTimer) clearInterval(videoClockPollTimer);
  videoClockPollTimer = null;
  videoClockTimeSec = null;
  videoClockPaused = false;
  videoClockObservedAtMs = 0;
  captureStartedAtMs = 0;
  captureSequenceNumber = 0;
  vadSpeechActive = false;
  vadLastSpeechAtMs = 0;
  vadLastSentAtMs = 0;
  captureSessionId = '';
  activeTabId = null;
  activeVideoId = '';
  console.log(LOG_PREFIX, 'tab capture stopped', { reason });
}

async function startCapture(streamId, videoId, tabId, sourceStartSeconds = 0) {
  await stopCapture('restart');
  activeVideoId = String(videoId || '').trim();
  activeTabId = Number.isFinite(Number(tabId)) ? Number(tabId) : null;
  videoClockTimeSec = Number.isFinite(Number(sourceStartSeconds))
    ? Math.max(Number(sourceStartSeconds), 0)
    : 0;
  videoClockPaused = false;
  videoClockObservedAtMs = 0;
  captureSessionId = buildCaptureSessionId(activeTabId, activeVideoId);
  captureSequenceNumber = 0;
  console.log(LOG_PREFIX, 'start received', { videoId: activeVideoId });
  safeRuntimeSendMessage({ type: 'isweep_audio_diag', stage: 'offscreen_start_received', videoId: activeVideoId }).catch(() => {});

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const tracks = typeof stream?.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
  if (!tracks.length) {
    throw new Error('audio_capture_unavailable');
  }

  console.log(LOG_PREFIX, 'stream ready', {
    videoId: activeVideoId,
    tracks: tracks.length,
  });
  safeRuntimeSendMessage({ type: 'isweep_audio_diag', stage: 'offscreen_stream_ready', videoId: activeVideoId }).catch(() => {});

  audioInputStream = stream;
  audioCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  console.log(LOG_PREFIX, 'audio context ready', {
    requested_sample_rate: AUDIO_SAMPLE_RATE,
    actual_sample_rate: audioCtx.sampleRate,
  });

  const workletUrl = chrome.runtime.getURL('audio_chunk_processor.js');
  await audioCtx.audioWorklet.addModule(workletUrl);
  console.log(LOG_PREFIX, 'worklet loaded');
  safeRuntimeSendMessage({ type: 'isweep_audio_diag', stage: 'offscreen_worklet_loaded' }).catch(() => {});

  const source = audioCtx.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(audioCtx, 'audio-chunk-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  // The worklet only reports PCM frames. Its own output is routed through a
  // zero-gain branch so Chrome keeps that branch of the graph active without
  // adding any sound to the user's tab audio.
  const workletKeepAliveGain = audioCtx.createGain();
  workletKeepAliveGain.gain.value = 0;

  // Create a monitor gain node to preserve tab audio playback.
  // Chrome tabCapture may otherwise silence normal tab playback unless the captured stream
  // is explicitly routed back to the audio context destination.
  const monitorGain = audioCtx.createGain();
  monitorGain.gain.value = 1.0;

  workletNode.port.onmessage = (event) => {
    if (!running || !audioCtx) return;
    if (videoClockPaused) {
      audioSampleBufs = [];
      audioChunkWarm = false;
      if (Number.isFinite(Number(videoClockTimeSec))) {
        audioChunkStartSec = Math.max(Number(videoClockTimeSec), 0);
      }
      return;
    }
    updateVadFromFrame(event.data);
    if (!audioSampleBufs.length) {
      audioChunkStartedAtMs = Date.now();
    }
    audioSampleBufs.push(new Float32Array(event.data));
    const total = audioSampleBufs.reduce((n, b) => n + b.length, 0);
    const required = (audioChunkWarm
      ? (AUDIO_CAPTION_CHUNK_SEC - AUDIO_CAPTION_OVERLAP_SEC)
      : AUDIO_CAPTION_CHUNK_SEC) * audioCtx.sampleRate;
    if (total >= required) {
      flushAudioChunk();
    }
  };

  // Route captured tab audio to both caption processing and speakers.
  // Caption path: source → worklet → zero-gain → destination.
  // The zero-gain node keeps the worklet graph alive but cannot change what the
  // user hears. Playback path: source → monitorGain → destination.
  source.connect(workletNode);
  workletNode.connect(workletKeepAliveGain);
  workletKeepAliveGain.connect(audioCtx.destination);
  source.connect(monitorGain);
  monitorGain.connect(audioCtx.destination);
  console.log(LOG_PREFIX, 'tab audio routed to speakers and active worklet');

  audioSourceNode = source;
  audioProcessor = workletNode;
  monitorGainNode = monitorGain;
  workletKeepAliveGainNode = workletKeepAliveGain;
  running = true;
  audioChunkStartSec = Number.isFinite(Number(sourceStartSeconds))
    ? Math.max(Number(sourceStartSeconds), 0)
    : 0;
  captureStartedAtMs = Date.now();
  audioChunkStartedAtMs = Date.now();
  audioChunkWarm = false;
  audioSampleBufs = [];
  vadLastSpeechAtMs = Date.now();
  startVideoClockPolling();
  maybeSendVadState(false, 'capture_started');
}

function classifyCaptureError(error) {
  const text = String(error?.message || error || '').trim();
  if (/notallowederror|permission|denied|not allowed/i.test(text)) {
    return 'audio_capture_permission_denied';
  }
  return 'audio_capture_unavailable';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'isweep_offscreen_start_tab_capture') {
    console.log(LOG_PREFIX, 'start received', {
      videoId: String(message.video_id || '').trim(),
    });
    startCapture(
      message.stream_id,
      message.video_id,
      message.tab_id,
      message.source_start_seconds,
    )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, failure_reason: classifyCaptureError(error) }));
    return true;
  }

  if (message?.type === 'isweep_offscreen_stop_tab_capture') {
    stopCapture(message.reason || 'stopped')
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }

  return undefined;
});
