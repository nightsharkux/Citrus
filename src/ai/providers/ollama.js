'use strict';
/** Local models through Ollama (https://ollama.com). Prompts never leave your server. */
const { readLines, safeJson } = require('./stream');

function baseUrl(env) {
  // Only operators can set this variable; visitors cannot influence it.
  const value = String(env.CAMPUS_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid CAMPUS_OLLAMA_URL');
  }
  return value;
}

module.exports = {
  id: 'ollama',
  label: 'Local · Ollama',
  location: 'local',
  timeoutMs: 180_000,
  model: (env) => env.CAMPUS_OLLAMA_MODEL || 'llama3.2',
  missing: () => null,
  describe: () => 'Local Ollama selected. Use “Test connection” to confirm the model is running.',

  request({ env, model, system, messages, stream, maxTokens }) {
    return {
      url: `${baseUrl(env)}/api/chat`,
      headers: { 'Content-Type': 'application/json' },
      body: { model, messages: [{ role: 'system', content: system }, ...messages], stream, options: { num_predict: maxTokens } },
    };
  },

  parse: (json) => json?.message?.content,

  async *parseStream(response) {
    for await (const line of readLines(response.body)) {
      const json = safeJson(line);
      if (json?.error) throw new Error(String(json.error));
      if (json?.message?.content) yield json.message.content;
      if (json?.done) return;
    }
  },

  errors: {
    unreachable: 'Cannot reach local Ollama. Start Ollama and download the configured model.',
    status: (code) => `Ollama returned HTTP ${code}. Verify the model has been downloaded.`,
  },
};
