'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calmText, speechOptions } = require('../src/ai/voices');

test('spoken text has no exclamation marks, ellipses or emphasis marks', () => {
  assert.equal(calmText('Great! This is **key**... really!!'), 'Great. This is key. really.');
});

test('the delivery is calm and steady on models that take spoken directions', () => {
  const o = speechOptions('google/gemini-2.5-flash-preview-tts', {});
  assert.match(o.instructions, /calm/);
  assert.match(o.instructions, /steady/);
  assert.ok(!/upbeat/.test(o.instructions));
  assert.ok(speechOptions('openai/gpt-4o-mini-tts', {}).instructions, 'OpenAI directable model gets them too');
  assert.equal(speechOptions('openai/tts-1', {}).instructions, undefined);
});
