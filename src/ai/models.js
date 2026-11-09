'use strict';
/** Verified against the public Gateway catalog. Reasoning levels are part of our configuration, not the API ID. */
const { badRequest } = require('../http/errors');
const MODEL_CHOICES = Object.freeze([
  { id: 'openai/gpt-6.1-sol/low', label: 'GPT-6.1 Sol', detail: 'Responsive reasoning for explanations and app assistance.' },
  { id: 'openai/gpt-6-astra/high', label: 'GPT-6 Astra', detail: 'More demanding reasoning. Expect higher cost and longer waits.' },
  { id: 'openai/gpt-6.1-terra/medium', label: 'GPT-6.1 Terra', detail: 'Fast visual reasoning and concise writing.' },
  { id: 'openai/gpt-6-luna/low', label: 'GPT-6 Luna', detail: 'Efficient handling of focused, frequent questions.' },
]);
function readModelOverride(value) {
  if (value === '' || value === null) return null;
  if (typeof value !== 'string' || !MODEL_CHOICES.some((m) => m.id === value)) throw badRequest('Choose a supported assistant model');
  return value;
}
module.exports = { MODEL_CHOICES, readModelOverride };
