'use strict';
/** OpenAI Chat Completions. Key stays on the server (OPENAI_API_KEY). */
const { readSse, safeJson } = require('./stream');

const key = (env) => String(env.OPENAI_API_KEY || '').trim();

module.exports = {
  id: 'openai',
  label: 'Cloud · OpenAI',
  location: 'cloud',
  timeoutMs: 60_000,
  model: (env) => env.CAMPUS_AI_MODEL || 'gpt-4.1-mini',
  missing: (env) => (key(env) ? null : 'OPENAI_API_KEY is missing on the server'),
  describe: () => 'Cloud AI selected (OpenAI).',

  request({ env, model, system, messages, stream, maxTokens }) {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key(env)}` },
      body: { model, messages: [{ role: 'system', content: system }, ...messages], max_completion_tokens: maxTokens, ...(stream ? { stream: true } : {}) },
    };
  },

  parse: (json) => json?.choices?.[0]?.message?.content,

  async *parseStream(response) {
    for await (const { data } of readSse(response.body)) {
      if (data === '[DONE]') return;
      const json = safeJson(data);
      if (json?.error) throw new Error(json.error.message || 'Cloud AI error');
      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  },

  /** Speech-to-text. Only used when CAMPUS_TRANSCRIPTION_PROVIDER=openai. */
  async transcribe({ env, fetchImpl, buffer, mime }) {
    const form = new FormData();
    form.append('model', env.CAMPUS_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe');
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
    form.append('file', new Blob([buffer], { type: mime }), `meeting.${ext}`);
    const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key(env)}` },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      console.error('Campus OS transcription status:', response.status);
      return '';
    }
    const payload = await response.json();
    return String(payload.text || '').trim().slice(0, 100_000);
  },
  transcriptionReady: (env) => env.CAMPUS_TRANSCRIPTION_PROVIDER === 'openai' && !!key(env),

  errors: {
    unreachable: 'Cannot reach the cloud AI provider. Check connectivity and credentials.',
    status: (code) => `Cloud AI returned HTTP ${code}. Check your API key and model.`,
  },
};
