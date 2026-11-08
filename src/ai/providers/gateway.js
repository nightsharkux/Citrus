'use strict';
/** Vercel AI Gateway's OpenAI-compatible API. Credentials stay on the server. */
const { parse, parseStream } = require('./openai');

const key = (env) => String(env.AI_GATEWAY_API_KEY || '').trim();
const chatModel = (env) => String(env.CAMPUS_GATEWAY_MODEL || '').trim() || 'openai/gpt-6-luna';
const summaryModel = (env) => String(env.CAMPUS_GATEWAY_SUMMARY_MODEL || '').trim() || 'google/gemini-2.5-flash-lite';
const noThinkingModels = new Set(['openai/gpt-6-luna', 'google/gemini-2.5-flash-lite']);

module.exports = {
  id: 'gateway',
  label: 'Cloud · Vercel AI Gateway',
  location: 'cloud',
  timeoutMs: 60_000,
  model: (env, task) => task === 'summary' ? summaryModel(env) : chatModel(env),
  summaryModel,
  missing: (env) => key(env) ? null : 'AI_GATEWAY_API_KEY is missing on the server',
  describe: () => 'Cloud AI selected (Vercel AI Gateway). Summaries use a separate model.',

  request({ env, model, system, messages, stream, maxTokens }) {
    return {
      url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key(env)}` },
      body: {
        model,
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: maxTokens,
        stream,
        // Choose the least expensive provider for this model; no model escalation.
        provider: { sort: 'cost' },
        ...(noThinkingModels.has(model) ? { reasoning: { effort: 'none' } } : {}),
      },
    };
  },

  parse,
  parseStream,
  errors: {
    unreachable: 'Cannot reach Vercel AI Gateway. Check server connectivity.',
    status: (code) => `Vercel AI Gateway returned HTTP ${code}. Check the gateway key, credits and model access.`,
  },
};
