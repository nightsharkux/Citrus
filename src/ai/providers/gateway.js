'use strict';
/** Vercel AI Gateway's OpenAI-compatible API. Credentials stay on the server. */
const { readSse, safeJson } = require('./stream');

const key = (env) => String(env.AI_GATEWAY_API_KEY || '').trim();
const defaultModel = (env) => String(env.CAMPUS_AI_DEFAULT_MODEL || '').trim() || 'openai/gpt-6.1-sol/low';
const summaryModel = (env) => String(env.CAMPUS_AI_SUMMARY_MODEL || '').trim() || 'openai/gpt-6-luna/low';
/** Text to speech (beta on the gateway). "off" turns natural voices off; the browser's voices are used instead. */
const speechModel = (env) => {
  const value = String(env.CAMPUS_AI_SPEECH_MODEL || '').trim();
  return value.toLowerCase() === 'off' ? null : value || 'elevenlabs/eleven-flash-v2.5';
};
/** A spoken conversation wants a quick answer: a reasoning model thinks briefly there (CAMPUS_AI_VOICE_REASONING). */
const voiceEffort = (env) => String(env.CAMPUS_AI_VOICE_REASONING || '').trim() || 'low';
const reasoningEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const reasoningRequired = new Set(['openai/gpt-6.1-sol', 'openai/gpt-6-astra']);

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
  if (effort && reasoningRequired.has(`${provider}/${model}`) && ['none', 'minimal'].includes(effort)) {
    throw new Error('This model requires a reasoning level of low, medium, high, xhigh or max');
  }
  return { model: provider + '/' + model, ...(effort ? { reasoning: { effort } } : {}) };
}

module.exports = {
  id: 'gateway',
  label: 'Cloud · Vercel AI Gateway',
  location: 'cloud',
  timeoutMs: 60_000,
  model(env, task) {
    if (task === 'summary') return summaryModel(env);
    // Voice: same model, shorter thinking, but only when the configured model is a reasoning model (has a level).
    if (task === 'voice') {
      const parts = defaultModel(env).split('/');
      const configuredEffort = voiceEffort(env);
      const effort = reasoningRequired.has(`${parts[0]}/${parts[1]}`) && ['none', 'minimal'].includes(configuredEffort) ? 'low' : configuredEffort;
      return parts.length === 3 && reasoningEfforts.has(effort) ? `${parts[0]}/${parts[1]}/${effort}` : defaultModel(env);
    }
    return defaultModel(env);
  },
  summaryModel,
  speechModel,
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

  /**
   * `web`: 'auto' lets the model search the web when it needs to, 'required' makes it search first. The gateway
   * runs the search itself (Perplexity) and returns only the final answer, so the model cites pages as links.
   */
  request({ env, model, system, messages, stream, maxTokens, web, task }) {
    return {
      url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key(env)}` },
      body: {
        ...parseModel(model),
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: maxTokens,
        stream,
        ...(web ? { tools: [{ type: 'vercel:perplexity_search', config: { max_results: 6 } }], tool_choice: web === 'required' ? 'required' : 'auto' } : {}),
        // Interactive answers prioritize first-token latency; background summaries stay cost-focused.
        provider: { sort: task === 'summary' ? 'cost' : 'ttft' },
      },
    };
  },

  /** One piece of speech. The gateway answers with the audio as base64 in JSON (no streaming for most models). */
  speechRequest({ env, model, text, voice, format, speed, instructions, language }) {
    return {
      url: 'https://ai-gateway.vercel.sh/v4/ai/speech-model',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key(env)}`,
        'ai-gateway-protocol-version': '0.0.1',
        'ai-speech-model-specification-version': '4',
        'ai-model-id': model,
      },
      body: { text, outputFormat: format, ...(voice ? { voice } : {}), ...(speed ? { speed } : {}), ...(instructions ? { instructions } : {}), ...(language ? { language } : {}) },
    };
  },
  parseSpeech: (json) => (typeof json?.audio === 'string' && json.audio ? Buffer.from(json.audio, 'base64') : null),

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
