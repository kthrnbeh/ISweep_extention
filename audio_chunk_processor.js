// ISweep AudioWorklet Processor — Audio Capture Only
// ====================================================
// Role: Low-level audio capture in the dedicated AudioWorklet thread.
// This processor does NOT perform speech-to-text (STT) transcription by itself.
// 
// Workflow:
//   1. Processor receives raw PCM audio blocks (128-sample quantums) from Web Audio API
//   2. Each quantum is converted to Float32Array and posted to main thread
//   3. Main thread (youtube_captions.js) accumulates chunks into buffers
//   4. Accumulated buffers are sent to backend /audio/analyze endpoint for STT
//   5. Backend performs actual speech-to-text and returns cleaned caption text
//   6. Caption text is rendered in the overlay
//
// If no STT endpoint is connected:
//   - Extension safely shows "ISweep Captions listening…" placeholder
//   - No errors or crashes occur
//   - Console logs indicate live STT is not yet configured
//   - User sees overlay but no real caption text until STT is enabled
//
// IMPORTANT: This is not a STT model. It is purely an audio capture mechanism.
// Do not add transcription logic here. Speech-to-text must happen server-side
// in the ISweep backend or via a cloud STT service.

class AudioChunkProcessor extends AudioWorkletProcessor {
  // Process audio blocks from the Web Audio graph.
  // Called once per 128-sample quantum (~2.7ms at 48kHz).
  process(inputs) {
    const ch = inputs[0]?.[0]; // Extract mono channel 0 (left channel fallback)
    if (ch && ch.length) {
      // Slice creates a copy; original buffer is reclaimed by the audio system.
      // This prevents memory leaks from holding references to shared buffers.
      this.port.postMessage(ch.slice());
    }
    // Return true to keep the processor alive for continuous audio capture.
    // Return false would disconnect the processor immediately.
    return true;
  }
}

// Register this processor with Web Audio API using the canonical name.
// Referenced from manifest.json web_accessible_resources and loaded by youtube_captions.js.
registerProcessor('audio-chunk-processor', AudioChunkProcessor);
