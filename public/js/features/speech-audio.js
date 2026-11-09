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
