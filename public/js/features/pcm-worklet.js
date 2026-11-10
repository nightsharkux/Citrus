/** Fixed-size little-endian PCM packets. Wispr uses 800 samples; Gateway uses 1200 (50 ms). */
class CampusPCM extends AudioWorkletProcessor {
  constructor({ processorOptions = {} } = {}) {
    super();
    const size = processorOptions.frameSamples === 1200 ? 1200 : 800;
    this.samples = new Float32Array(size); this.at = 0; this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'drain' && !this.finished) {
        if (this.at) this.send();
        this.port.postMessage({ drained: true });
      }
      if (data === 'flush' && !this.finished) {
        this.finished = true;
        if (this.at) this.send();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  send() {
    const size = this.samples.length;
    const bytes = new ArrayBuffer(size * 2); const view = new DataView(bytes); let energy = 0;
    for (let i = 0; i < size; i++) {
      const value = i < this.at ? Math.max(-1, Math.min(1, this.samples[i])) : 0;
      energy += value * value; view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    this.port.postMessage({ pcm: bytes, volume: Math.sqrt(energy / size) }, [bytes]); this.at = 0;
  }
  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0]?.[0];
    if (input) for (const value of input) { this.samples[this.at++] = value; if (this.at === this.samples.length) this.send(); }
    return true;
  }
}
registerProcessor('campus-pcm', CampusPCM);
