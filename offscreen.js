/*
ISWEEP COMPONENT: Offscreen Tab Audio Capture

Role: Own the extension tab-audio capture pipeline outside the service worker.
Receives start/stop commands from background.js, captures tab audio, chunks PCM,
and relays WAV chunks back to background for /captions/transcribe.
*/

const LOG_PREFIX = '[ISWEEP][AUDIO_CAPTIONS][OFFSCREEN]';
const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHUNK_SEC = 2.0;
const AUDIO_CHUNK_OVERLAP_SEC = 0.5;

console.log(LOG_PREFIX, 'loaded');

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
let audioSampleBufs = [];
let audioChunkWarm = false;
let audioChunkStartSec = 0;
let running = false;
let activeVideoId = '';

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

async function flushAudioChunk() {
  if (!running || !audioCtx || !audioSampleBufs.length) return;
  const bufs = audioSampleBufs.slice();
  const sampleRate = audioCtx.sampleRate;
  const sampleCount = bufs.reduce((n, b) => n + b.length, 0);
  const durationSec = sampleRate > 0 ? sampleCount / sampleRate : 0;
  const startSec = audioChunkStartSec;
  let endSec = startSec + durationSec;
  if (!(endSec > startSec)) {
    endSec = startSec + 0.05;
  }

  const overlapSamples = Math.floor(Math.max(AUDIO_CHUNK_OVERLAP_SEC, 0) * sampleRate);
  const overlapBufs = takeTailSampleBuffers(bufs, overlapSamples);
  const overlapCount = overlapBufs.reduce((n, b) => n + b.length, 0);
  const overlapDurationSec = sampleRate > 0 ? overlapCount / sampleRate : 0;
  audioSampleBufs = overlapBufs;
  audioChunkStartSec = Math.max(endSec - overlapDurationSec, 0);
  audioChunkWarm = true;

  const wavBuf = encodeWAV(bufs, sampleRate);
  const audioChunk = arrayBufferToBase64(wavBuf);

  console.log(LOG_PREFIX, 'chunk emitted', {
    videoId: activeVideoId,
    start_seconds: startSec,
    end_seconds: endSec,
  });
  await safeRuntimeSendMessage({
    type: 'isweep_audio_caption_chunk',
    video_id: activeVideoId,
    sampleRate,
    channels: 1,
    audio_chunk: audioChunk,
    mime_type: 'audio/wav',
    start_seconds: startSec,
    end_seconds: endSec,
  }).catch(() => {});
}

async function stopCapture(reason = 'stopped') {
  running = false;
  if (audioProcessor) {
    try { audioProcessor.disconnect(); } catch (_) {}
    audioProcessor = null;
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
  activeVideoId = '';
  console.log(LOG_PREFIX, 'tab capture stopped', { reason });
}

async function startCapture(streamId, videoId) {
  await stopCapture('restart');
  activeVideoId = String(videoId || '').trim();
  console.log(LOG_PREFIX, 'start received', { videoId: activeVideoId });

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

  audioInputStream = stream;
  audioCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const workletUrl = chrome.runtime.getURL('audio_chunk_processor.js');
  await audioCtx.audioWorklet.addModule(workletUrl);
  console.log(LOG_PREFIX, 'worklet loaded');

  const source = audioCtx.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(audioCtx, 'audio-chunk-processor');

  // Create a monitor gain node to preserve tab audio playback.
  // Chrome tabCapture may otherwise silence normal tab playback unless the captured stream
  // is explicitly routed back to the audio context destination.
  const monitorGain = audioCtx.createGain();
  monitorGain.gain.value = 1.0;

  workletNode.port.onmessage = (event) => {
    if (!running || !audioCtx) return;
    audioSampleBufs.push(new Float32Array(event.data));
    const total = audioSampleBufs.reduce((n, b) => n + b.length, 0);
    const required = (audioChunkWarm ? (AUDIO_CHUNK_SEC - AUDIO_CHUNK_OVERLAP_SEC) : AUDIO_CHUNK_SEC) * audioCtx.sampleRate;
    if (total >= required) {
      flushAudioChunk();
    }
  };

  // Route captured tab audio to both caption processing and speakers.
  // Caption path: source → worklet → (no output; worklet only extracts samples).
  // Playback path: source → monitorGain → destination (preserves normal audio).
  source.connect(workletNode);
  source.connect(monitorGain);
  monitorGain.connect(audioCtx.destination);
  console.log(LOG_PREFIX, 'tab audio routed to speakers');

  audioProcessor = workletNode;
  running = true;
  audioChunkStartSec = 0;
  audioChunkWarm = false;
  audioSampleBufs = [];
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
    startCapture(message.stream_id, message.video_id)
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
