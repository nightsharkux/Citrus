'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('speech loudness correction lifts quiet clips, reduces loud clips and leaves silence alone', async () => {
  const { speechGain } = await import(pathToFileURL(path.join(__dirname, '../public/js/features/speech-audio.js')).href);
  const buffer = (...channels) => ({ numberOfChannels: channels.length, getChannelData: (i) => Float32Array.from(channels[i]) });
  assert.equal(speechGain(buffer([0, 0])), 1);
  assert.equal(speechGain(buffer([0.001, -0.001])), 1);
  assert.equal(speechGain(buffer([0.01, -0.01])), 3.5);
  assert.ok(Math.abs(speechGain(buffer([0.14, -0.14])) - 1) < 0.001);
  assert.equal(speechGain(buffer([0.9, -0.9])), 0.65);
  assert.ok(Math.abs(speechGain(buffer([0.1], [0.2])) - 0.14 / Math.sqrt(0.025)) < 0.001);
  assert.equal(speechGain(null), 1);
});

test('streaming PCM preserves sample values across odd byte boundaries and zero volume stays muted', async () => {
  const { PcmDecoder } = await import(pathToFileURL(path.join(__dirname, '../public/js/features/speech-audio.js')).href);
  const { voiceTuning } = await import(pathToFileURL(path.join(__dirname, '../public/js/features/voices.js')).href);
  const decoder = new PcmDecoder();
  const context = { createBuffer(channels, length, sampleRate) { const samples = new Float32Array(length); return { sampleRate, getChannelData: () => samples }; } };
  const bytes = Buffer.alloc(6); bytes.writeInt16LE(-32768, 0); bytes.writeInt16LE(16384, 2); bytes.writeInt16LE(32767, 4);
  assert.equal(decoder.decode(bytes.subarray(0, 1).toString('base64'), context), null);
  const a = decoder.decode(bytes.subarray(1, 5).toString('base64'), context);
  const b = decoder.decode(bytes.subarray(5).toString('base64'), context);
  assert.deepEqual([...a.getChannelData(0), ...b.getChannelData(0)], [-1, 0.5, 32767 / 32768]);
  assert.equal(a.sampleRate, 24000); assert.equal(decoder.tail, null);
  assert.equal(voiceTuning({ volume: 0 }).volume, 0);
  assert.equal(voiceTuning({ volume: 'invalid' }).volume, 1);
});
