// ISweep AudioWorklet processor — runs in the dedicated AudioWorklet thread.
// Receives mono PCM blocks from the Web Audio graph and forwards each 128-sample
// quantum to the main thread so youtube_captions.js can accumulate and flush chunks.
// Replaces the deprecated ScriptProcessorNode.

class AudioChunkProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0]; // mono channel 0
    if (ch && ch.length) {
      // Slice creates a copy; the original buffer is reclaimed by the audio thread.
      this.port.postMessage(ch.slice());
    }
    return true; // Keep processor alive until explicitly disconnected.
  }
}

registerProcessor('audio-chunk-processor', AudioChunkProcessor);
