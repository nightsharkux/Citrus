/** Conservative per-clip loudness correction; the playback compressor catches brief peaks. */
export function speechGain(buffer) {
  if (!buffer?.getChannelData || !buffer.numberOfChannels) return 1;
  let energy = 0; let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    for (const value of buffer.getChannelData(channel)) { energy += value * value; count++; }
  }
  const rms = Math.sqrt(energy / Math.max(1, count));
  return rms < 0.003 ? 1 : Math.min(3.5, Math.max(0.65, 0.14 / rms));
}

/** Decode streaming signed 16-bit little-endian audio, including chunks split inside one sample. */
export class PcmDecoder {
  constructor() { this.tail = null; }
  decode(encoded, context, rate = 24000) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length + (this.tail === null ? 0 : 1));
    let at = 0;
    if (this.tail !== null) bytes[at++] = this.tail;
    for (let i = 0; i < binary.length; i++) bytes[at++] = binary.charCodeAt(i);
    this.tail = bytes.length % 2 ? bytes[bytes.length - 1] : null;
    const length = Math.floor(bytes.length / 2);
    if (!length) return null;
    const buffer = context.createBuffer(1, length, rate);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return buffer;
  }
}
