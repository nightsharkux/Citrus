'use strict';
/** Anthropic Messages API (Claude). Key stays on the server (ANTHROPIC_API_KEY). */
const { readSse, safeJson } = require('./stream');

const key = (env) => String(env.ANTHROPIC_API_KEY || '').trim();

/** The Messages API needs alternating turns that start with the user. */
function normaliseTurns(messages) {
  const turns = [];
  for (const m of messages) {
    if (!turns.length && m.role !== 'user') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else turns.push({ role: m.role, content: m.content });
  }
  return turns;
}

module.exports = {
  id: 'anthropic',
  label: 'Cloud · Anthropic',
  location: 'cloud',
  timeoutMs: 60_000,
  model: (env) => env.CAMPUS_ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  missing: (env) => (key(env) ? null : 'ANTHROPIC_API_KEY is missing on the server'),
  describe: () => 'Cloud AI selected (Anthropic).',

  request({ env, model, system, messages, stream, maxTokens }) {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key(env), 'anthropic-version': '2023-06-01' },
      body: { model, system, messages: normaliseTurns(messages), max_tokens: maxTokens, ...(stream ? { stream: true } : {}) },
    };
  },

  parse: (json) => (Array.isArray(json?.content) ? json.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : undefined),

  async *parseStream(response) {
    for await (const { event, data } of readSse(response.body)) {
      const json = safeJson(data);
      if (event === 'error' || json?.type === 'error') throw new Error(json?.error?.message || 'Cloud AI error');
      if (json?.type === 'content_block_delta' && json.delta?.type === 'text_delta') yield json.delta.text;
      if (json?.type === 'message_stop') return;
    }
  },

  errors: {
    unreachable: 'Cannot reach the cloud AI provider. Check connectivity and credentials.',
    status: (code) => `Cloud AI returned HTTP ${code}. Check your API key and model.`,
  },
};
