/** 16 kHz AudioContext input -> fixed 50 ms little-endian PCM packets. Output remains silent. */
class CampusPCM extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(800); this.at = 0; this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush' && !this.finished) {
        this.finished = true;
        if (this.at) this.send();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  send() {
    const bytes = new ArrayBuffer(1600); const view = new DataView(bytes); let energy = 0;
    for (let i = 0; i < 800; i++) {
      const value = i < this.at ? Math.max(-1, Math.min(1, this.samples[i])) : 0;
      energy += value * value; view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    this.port.postMessage({ pcm: bytes, volume: Math.sqrt(energy / 800) }, [bytes]); this.at = 0;
  }
  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0]?.[0];
    if (input) for (const value of input) { this.samples[this.at++] = value; if (this.at === 800) this.send(); }
    return true;
  }
}
registerProcessor('campus-pcm', CampusPCM);
