'use strict';
/**
 * AI provider registry.
 *
 * To add a provider, create a file next to this one that exports:
 *   { id, label, location: 'local'|'cloud', timeoutMs,
 *     model(env), missing(env) -> string|null, describe(env),
 *     request({ env, model, system, messages, stream, maxTokens }) -> { url, headers, body },
 *     parse(json) -> string, async *parseStream(response),
 *     errors: { unreachable, status(code) },
 *     transcribe?(...), transcriptionReady?(env) }
 * then add it to PROVIDERS below. Nothing else in the app needs to change.
 *
 * Credentials are read from `env` at call time and never returned to clients.
 */
const { HttpError } = require('../../http/errors');

const PROVIDERS = [require('./ollama'), require('./gateway'), require('./openai'), require('./anthropic')];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
const MODES = ['off', ...BY_ID.keys()];

/** Errors from a provider surface to users as 503 with a readable message. */
class AiError extends HttpError {
  constructor(message) {
    super(503, message);
  }
}

const NOT_CONFIGURED = 'The selected AI provider is not configured. Ask the administrator to check AI settings.';

function makeProviders({ fetchImpl = (...args) => fetch(...args), env = process.env } = {}) {
  const providerName = (mode) => (MODES.includes(mode) ? mode : 'off');

  function transcriptionReady() {
    return PROVIDERS.some((p) => p.transcriptionReady?.(env));
  }

  function status(mode) {
    const id = providerName(mode);
    const provider = BY_ID.get(id);
    const missing = provider ? provider.missing(env) : 'AI disabled by administrator';
    return {
      provider: id,
      label: provider ? provider.label : 'Off',
      location: provider ? provider.location : null,
      aiEnabled: !!provider && !missing,
      model: provider ? provider.model(env) : null,
      ...(provider?.summaryModel ? { summaryModel: provider.summaryModel(env) } : {}),
      transcription: transcriptionReady() ? 'OpenAI (explicitly enabled)' : 'Disabled',
      description: missing || provider.describe(env),
    };
  }

  function list() {
    return [{ id: 'off', label: 'Off', location: null, ready: true, missing: null }, ...PROVIDERS.map((p) => ({ id: p.id, label: p.label, location: p.location, model: p.model(env), ready: !p.missing(env), missing: p.missing(env) }))];
  }

  function buildMessages(input, history) {
    return [
      ...history
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant'))
        .slice(-10)
        .map((h) => ({ role: h.role, content: String(h.content).slice(0, 4000) })),
      { role: 'user', content: String(input).slice(0, 25_000) },
    ];
  }

  async function call(mode, system, input, history, { stream, signal, maxTokens = 1200, task = 'chat' }) {
    const provider = BY_ID.get(providerName(mode));
    if (!provider || provider.missing(env)) throw new AiError(NOT_CONFIGURED);
    const req = provider.request({ env, model: provider.model(env, task), system: String(system).slice(0, 26_000), messages: buildMessages(input, history), stream, maxTokens });
    const timeout = AbortSignal.timeout(provider.timeoutMs);
    let response;
    try {
      response = await fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AiError(provider.errors.unreachable);
    }
    if (!response.ok) {
      console.error('Campus OS AI provider status:', provider.id, response.status);
      throw new AiError(provider.errors.status(response.status));
    }
    return { provider, response };
  }

  /** Complete a prompt and return the full text. */
  async function generate(mode, system, input, history = [], options = {}) {
    const { provider, response } = await call(mode, system, input, history, { ...options, stream: false });
    let json;
    try {
      json = await response.json();
    } catch {
      throw new AiError('Invalid response from AI provider');
    }
    const text = provider.parse(json);
    if (typeof text !== 'string' || !text.trim()) throw new AiError('AI provider did not return a text response');
    return text.slice(0, 12_000);
  }

  /** Stream a completion as text deltas. */
  async function* stream(mode, system, input, history = [], options = {}) {
    const { provider, response } = await call(mode, system, input, history, { ...options, stream: true });
    let total = 0;
    try {
      for await (const delta of provider.parseStream(response)) {
        if (typeof delta !== 'string') throw new AiError('Invalid text from AI provider');
        const text = delta.slice(0, 12_000 - total);
        total += text.length;
        if (text) yield text;
        if (total >= 12_000) return;
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      throw new AiError('The AI stream was interrupted. Please try again.');
    }
  }

  async function transcribe(buffer, mime) {
    const provider = PROVIDERS.find((p) => p.transcriptionReady?.(env));
    if (!provider) return '';
    return provider.transcribe({ env, fetchImpl, buffer, mime });
  }

  return { status, list, generate, stream, transcribe, transcriptionReady, providerName, modes: MODES };
}

module.exports = { makeProviders, AiError, MODES };
