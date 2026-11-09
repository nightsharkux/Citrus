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
