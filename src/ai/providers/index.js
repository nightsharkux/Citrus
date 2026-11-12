'use strict';
/** Gateway transport and bounded responses. Credentials remain on the server. */
const { HttpError } = require('../../http/errors');

const PROVIDERS = [require('./gateway')];
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
  const modelEnv = (model) => model ? { ...env, CAMPUS_AI_DEFAULT_MODEL: model } : env;

  function status(mode, { model } = {}) {
    const id = providerName(mode);
    const provider = BY_ID.get(id);
    const configured = modelEnv(model);
    const missing = provider ? provider.missing(configured) : 'AI disabled by administrator';
    return {
      provider: id,
      label: provider ? provider.label : 'Off',
      location: provider ? provider.location : null,
      aiEnabled: !!provider && !missing,
      model: provider ? provider.model(configured) : null,
      ...(provider?.summaryModel ? { summaryModel: provider.summaryModel(env) } : {}),
      ...(provider?.searchModel?.(env) ? { searchModel: provider.searchModel(env) } : {}),
      transcription: 'Disabled',
      description: missing || provider.describe(env),
    };
  }

  function list({ model } = {}) {
    const configured = modelEnv(model);
    return [{ id: 'off', label: 'Off', location: null, ready: true, missing: null }, ...PROVIDERS.map((p) => ({ id: p.id, label: p.label, location: p.location, model: p.model(configured), ready: !p.missing(configured), missing: p.missing(configured) }))];
  }

  /**
   * A message's content is plain text, or text plus pictures (and at most one PDF) for the model to look at.
   * `images` are data URLs and `files` PDFs that the server itself produced from validated uploads.
   */
  function content(text, images, limit, files) {
    const body = String(text).slice(0, limit);
    if (!images?.length && !files?.length) return body;
    return [
      { type: 'text', text: body },
      ...(images || []).slice(0, 4).map((url) => ({ type: 'image_url', image_url: { url } })),
      // A PDF for the model to read itself (scans, unusual fonts): { name, mime, data: base64 }, produced by the server.
      ...(files || []).slice(0, 1).map((f) => ({ type: 'file', file: { data: f.data, media_type: f.mime, filename: f.name } })),
    ];
  }

  function buildMessages(input, history) {
    const turn = input && typeof input === 'object' ? input : { text: input };
    return [
      ...history
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant'))
        .slice(-24)
        .map((h) => ({ role: h.role, content: content(h.content, h.images, 40_000) })),
      { role: 'user', content: content(turn.text, turn.images, 90_000, turn.files) },
    ];
  }

  // Web search is a gateway tool that may not be enabled for the account. When a request with it is refused, the
  // same request is sent again without it and search rests for a while, so the assistant itself never breaks.
  let webRestsUntil = 0;
  const webAvailable = () => Date.now() >= webRestsUntil;

  async function call(mode, system, input, history, { stream, signal, maxTokens = 1200, task = 'chat', web = null, model = null }) {
    const provider = BY_ID.get(providerName(mode));
    const configured = modelEnv(model);
    if (!provider || provider.missing(configured)) throw new AiError(NOT_CONFIGURED);
    const messages = buildMessages(input, history);
    const send = async (withWeb) => {
      const req = provider.request({ env: configured, model: provider.model(configured, task), system: String(system).slice(0, 64_000), messages, stream, maxTokens, web: withWeb, task });
      const timeout = AbortSignal.timeout(provider.timeoutMs * (withWeb ? 1.5 : 1));
      try {
        return await fetchImpl(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new AiError(provider.errors.unreachable);
      }
    };
    const withWeb = web && webAvailable() ? web : null;
    let response = await send(withWeb);
    let searched = !!withWeb;
    if (!response.ok && withWeb && response.status >= 400 && response.status < 500 && response.status !== 429) {
      console.error('Campus OS web search refused, answering without it:', provider.id, response.status);
      webRestsUntil = Date.now() + 15 * 60_000;
      response = await send(null);
      searched = false;
    }
    if (!response.ok) {
      console.error('Campus OS AI provider status:', provider.id, response.status);
      throw new AiError(provider.errors.status(response.status));
    }
    return { provider, response, searched };
  }

  /** Complete a prompt and return the full text. */
  async function generate(mode, system, input, history = [], options = {}) {
    const { provider, response, searched } = await call(mode, system, input, history, { ...options, stream: false });
    options.onMeta?.({ searched });
    let json;
    try {
      json = await response.json();
    } catch {
      throw new AiError('Invalid response from AI provider');
    }
    const text = provider.parse(json);
    if (typeof text !== 'string' || !text.trim()) throw new AiError('AI provider did not return a text response');
    // A translation may expand relative to its input. Never silently return a cut-off translation.
    if (options.task === 'translation') {
      if (json.choices?.[0]?.finish_reason === 'length' || text.length > 32000) throw new AiError('The translation is too long. Select a shorter passage and try again.');
      return text;
    }
    return text.slice(0, 12_000);
  }

  /** Stream a completion as text deltas. */
  async function* stream(mode, system, input, history = [], options = {}) {
    const { provider, response, searched } = await call(mode, system, input, history, { ...options, stream: true });
    options.onMeta?.({ searched });
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

  // Natural voices are in beta on the gateway. A refusal (no access yet, unknown model) rests them for a while,
  // and clients use the browser's voices meanwhile; a passing network problem does not.
  let speechRestsUntil = 0;

  /** The speech model for a mode, or null when natural voices are off, unsupported or resting. */
  function speechModel(mode) {
    const provider = BY_ID.get(providerName(mode));
    if (!provider?.speechModel || provider.missing(env)) return null;
    return Date.now() < speechRestsUntil ? null : provider.speechModel(env);
  }

  /**
   * Turn text into audio. `options` come from voices.js speechOptions (voice, format, speed, instructions,
   * language). Returns a Buffer.
   */
  async function speech(mode, text, options, { signal } = {}) {
    const provider = BY_ID.get(providerName(mode));
    const model = speechModel(mode);
    if (!provider || !model) throw new AiError('Natural voices are not available right now.');
    const req = provider.speechRequest({ env, model, text: String(text).slice(0, 1200), ...options });
    const timeout = AbortSignal.timeout(20_000);
    let response;
    try {
      response = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AiError(provider.errors.unreachable);
    }
    if (!response.ok) {
      console.error('Campus OS speech status:', provider.id, model, response.status);
      // Only a refusal of access (key, credits, model) rests voices for everyone. A 400 is about this one
      // piece of text, and must not switch every user to the device voice for ten minutes.
      if ([401, 402, 403, 404].includes(response.status)) speechRestsUntil = Date.now() + 10 * 60_000;
      throw new AiError(response.status === 429 ? 'Natural voices are busy. Please try again in a moment.' : 'Natural voices are not available right now.');
    }
    let json;
    try {
      json = await response.json();
    } catch {
      throw new AiError('Invalid audio from the speech model');
    }
    const audio = provider.parseSpeech(json);
    if (!audio?.length) throw new AiError('The speech model returned no audio');
    return audio;
  }

  return { status, list, generate, stream, speech, speechModel, webAvailable, providerName, modes: MODES };
}

module.exports = { makeProviders, AiError, MODES };
