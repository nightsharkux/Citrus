'use strict';
/** Vercel AI Gateway's OpenAI-compatible API. Credentials stay on the server. */
const { readSse, safeJson } = require('./stream');

const key = (env) => String(env.AI_GATEWAY_API_KEY || '').trim();
const defaultModel = (env) => String(env.CAMPUS_AI_DEFAULT_MODEL || '').trim() || 'openai/gpt-6.1-terra/medium';
const summaryModel = (env) => String(env.CAMPUS_AI_SUMMARY_MODEL || '').trim() || 'openai/gpt-6-luna/low';
const reasoningEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Campus OS configuration: provider/model[/effort]. The gateway receives the base ID. */
function parseModel(slug) {
  const parts = slug.split('/');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !part || /\s/.test(part))) {
    throw new Error('Use provider/model or provider/model/reasoning for AI model settings');
  }
  const [provider, model, effort] = parts;
  if (effort && !reasoningEfforts.has(effort)) {
    throw new Error('Unknown AI reasoning level. Use none, minimal, low, medium, high, xhigh or max');
  }
  return { model: provider + '/' + model, ...(effort ? { reasoning: { effort } } : {}) };
}

module.exports = {
  id: 'gateway',
  label: 'Cloud · Vercel AI Gateway',
  location: 'cloud',
  timeoutMs: 60_000,
  model: (env, task) => task === 'summary' ? summaryModel(env) : defaultModel(env),
  summaryModel,
  missing(env) {
    if (!key(env)) return 'AI_GATEWAY_API_KEY is missing on the server';
    try {
      parseModel(defaultModel(env));
      parseModel(summaryModel(env));
      return null;
    } catch (error) {
      return error.message;
    }
  },
  describe: () => 'Cloud AI selected (Vercel AI Gateway). Summaries use a separate model.',

  request({ env, model, system, messages, stream, maxTokens }) {
    return {
      url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key(env)}` },
      body: {
        ...parseModel(model),
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: maxTokens,
        stream,
        // Choose the least expensive provider for this model; no model escalation.
        provider: { sort: 'cost' },
      },
    };
  },

  parse: (json) => json?.choices?.[0]?.message?.content,

  async *parseStream(response) {
    for await (const { data } of readSse(response.body)) {
      if (data === '[DONE]') return;
      const json = safeJson(data);
      if (json?.error) throw new Error('Gateway stream error');
      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  },
  errors: {
    unreachable: 'Cannot reach Vercel AI Gateway. Check server connectivity.',
    status: (code) => `Vercel AI Gateway returned HTTP ${code}. Check the gateway key, credits and model access.`,
  },
};
