'use strict';
/**
 * The one place the rest of the app talks to AI.
 *
 *   ai.status(user)                      -> provider status for the user's institution
 *   ai.complete({ user, system, prompt, history })
 *   ai.read({ user, system, prompt })    -> reading an uploaded page or picture (own rate limit, lookup model)
 *   ai.stream({ user, system, prompt, history, signal })   (async iterator of text)
 *   ai.retrieve(user, query)             -> numbered sources for citations
 *   ai.setProvider(user, mode)
 *
 * Every request is attributed to a user so institution settings, quotas and
 * data boundaries are always applied.
 */
const crypto = require('node:crypto');
const { makeProviders } = require('./providers');
const { createRetrieval, toSource } = require('./retrieval');
const { voiceCatalog, speechOptions, calmText } = require('./voices');
const { createRecognitionProvider } = require('./recognition');
const { audioSession, liveSession: openLiveSession, STREAMING_SPEECH_MODEL } = require('./audio-session');
const { MODEL_CHOICES, readModelOverride } = require('./models');
const { createRateLimiter } = require('../http/rate-limit');
const { tooMany, badRequest, unavailable } = require('../http/errors');

function createAiService({ db, env = process.env, fetchImpl, packs = [], readPack, academic = null }) {
  const providers = makeProviders({ env, ...(fetchImpl ? { fetchImpl } : {}) });
  const retrieval = createRetrieval(db, { packs, read: readPack, academic });
  const quota = createRateLimiter({ windowMs: 60_000, max: Number(env.CAMPUS_AI_RATE_PER_MINUTE || 12) });
  // Speech is requested one sentence at a time, so it has its own, larger allowance.
  const speechQuota = createRateLimiter({ windowMs: 60_000, max: Number(env.CAMPUS_AI_SPEECH_PER_MINUTE || 240) });
  const recognition = createRecognitionProvider({ env, fetchImpl });
  // Phones reopen the microphone after every answer, and streams rotate every two minutes; six a minute was
  // reached in a brisk conversation, which dropped it to the browser's recogniser mid-sentence.
  const recognitionQuota = createRateLimiter({ windowMs: 60_000, max: 20 });
  const wisprQuota = createRateLimiter({ windowMs: 60_000, max: 24 });
  // Live voice (GPT-Live): one pass per conversation, so a small allowance is plenty.
  const liveQuota = createRateLimiter({ windowMs: 60_000, max: 6 });
  const liveModel = () => {
    const value = String(env.CAMPUS_AI_LIVE_MODEL || '').trim();
    return value.toLowerCase() === 'off' ? null : value || 'openai/gpt-live-1';
  };
  // A refused pass (no access to the model yet) rests live voice; conversations use the standard voice meanwhile.
  let liveRestsUntil = 0;

  const defaultProvider = () => env.CAMPUS_AI_PROVIDER || 'gateway';

  /** The institution's choices: provider, and whether web search and natural voices are allowed (both on by default). */
  function settingsFor(institutionId) {
    const row = db.get('SELECT * FROM institution_ai_settings WHERE institution_id = ?', institutionId);
    return {
      mode: providers.providerName(row?.provider || defaultProvider()),
      model: row?.chat_model || null,
      webSearch: row?.web_search === undefined || row?.web_search === null ? true : !!row.web_search,
      speech: row?.speech === undefined || row?.speech === null ? true : !!row.speech,
    };
  }
  const selected = (institutionId) => settingsFor(institutionId).mode;

  function status(user) {
    const s = settingsFor(user.institution_id);
    const base = providers.status(s.mode, { model: s.model });
    const speechModel = base.aiEnabled && s.speech ? providers.speechModel(s.mode) : null;
    return {
      ...base,
      modelOverride: s.model,
      modelChoices: MODEL_CHOICES,
      webSearch: base.aiEnabled && s.webSearch && providers.webAvailable(),
      webSearchAllowed: s.webSearch,
      speech: !!speechModel,
      speechStreaming: speechModel === STREAMING_SPEECH_MODEL && env.CAMPUS_AI_SPEECH_STREAMING !== 'off',
      speechAllowed: s.speech,
      recognition: base.aiEnabled ? recognition.info() : { enabled: false, provider: 'browser' },
      live: base.aiEnabled && s.speech && base.provider === 'gateway' && !!liveModel() && Date.now() >= liveRestsUntil,
      ...(speechModel ? { speechModel } : {}),
    };
  }

  /** Turn web search and natural voices on or off for the institution. */
  function setTools(user, { webSearch, speech }) {
    const s = settingsFor(user.institution_id);
    const next = { webSearch: webSearch === undefined ? s.webSearch : !!webSearch, speech: speech === undefined ? s.speech : !!speech };
    db.run(
      `INSERT INTO institution_ai_settings(institution_id, provider, web_search, speech, updated) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(institution_id) DO UPDATE SET web_search = excluded.web_search, speech = excluded.speech, updated = excluded.updated`,
      user.institution_id, s.mode, next.webSearch ? 1 : 0, next.speech ? 1 : 0, new Date().toISOString(),
    );
    return status(user);
  }

  function setProvider(user, mode) {
    if (!providers.modes.includes(mode)) throw badRequest(`Choose one of: ${providers.modes.join(', ')}`);
    db.run(
      `INSERT INTO institution_ai_settings(institution_id, provider, updated) VALUES(?, ?, ?)
       ON CONFLICT(institution_id) DO UPDATE SET provider = excluded.provider, updated = excluded.updated`,
      user.institution_id, mode, new Date().toISOString(),
    );
    return status(user);
  }

  function setModel(user, value) {
    const model = readModelOverride(value);
    db.run(`INSERT INTO institution_ai_settings(institution_id, provider, chat_model, updated) VALUES(?, ?, ?, ?)
      ON CONFLICT(institution_id) DO UPDATE SET chat_model = excluded.chat_model, updated = excluded.updated`,
    user.institution_id, selected(user.institution_id), model, new Date().toISOString());
    return status(user);
  }

  function checkQuota(user) {
    if (!quota.hit(user.id)) throw tooMany('Please allow a minute before sending more AI requests');
  }

  /** 'auto' | 'required' when the institution allows web search, otherwise null. */
  const webFor = (user, web) => (web && settingsFor(user.institution_id).webSearch ? web : null);

  /** `web`: 'auto' (the model decides) or 'required' (search first); ignored when the institution turned search off. */
  async function complete({ user, system, prompt, history = [], maxTokens, task = 'chat', web = null, onMeta }) {
    checkQuota(user);
    const s = settingsFor(user.institution_id);
    return providers.generate(s.mode, system, prompt, history, { maxTokens, task, web: webFor(user, web), onMeta, model: s.model });
  }

  // Reading uploaded documents goes a page at a time, so it has its own allowance: a 30-page scan must not use up
  // the chat's, and the chat must not stop a document half read.
  const readQuota = createRateLimiter({ windowMs: 60_000, max: Number(env.CAMPUS_AI_READ_PER_MINUTE || 60) });
  /**
   * Read a document page (text, or a picture as `prompt.images`) with the lookup model (Gemini by default), which
   * reads scans and long text well. Throws 429 when the allowance is used; callers retry on the next round.
   */
  async function read({ user, system, prompt, maxTokens = 3000 }) {
    if (!readQuota.hit(user.id)) throw tooMany('Reading pauses for a minute and then continues.');
    const s = settingsFor(user.institution_id);
    return providers.generate(s.mode, system, prompt, [], { maxTokens, task: 'search', model: s.model });
  }

  /** `onMeta({ searched })` says whether the web was searched for this answer. */
  function stream({ user, system, prompt, history = [], signal, maxTokens, task = 'chat', web = null, onMeta }) {
    checkQuota(user);
    const s = settingsFor(user.institution_id);
    return providers.stream(s.mode, system, prompt, history, { signal, maxTokens, task, web: webFor(user, web), onMeta, model: s.model });
  }

  // Recently made audio, so samples and repeated sentences cost nothing the second time.
  const audioCache = new Map();
  let audioCacheBytes = 0;
  const remember = (key, value) => {
    audioCache.set(key, value);
    audioCacheBytes += value.audio.length;
    while (audioCacheBytes > 24_000_000 || audioCache.size > 400) {
      const [oldest, entry] = audioCache.entries().next().value;
      audioCache.delete(oldest);
      audioCacheBytes -= entry.audio.length;
    }
  };

  /** Voices of the institution's speech model, for the settings screen. */
  function speechInfo(user) {
    const s = status(user);
    if (!s.speech) return { enabled: false, voices: [], default: '' };
    return { enabled: true, model: s.speechModel, streaming: s.speechStreaming, ...voiceCatalog(s.speechModel) };
  }

  async function playbackSession({ user, voice, speed, signal }) {
    const s = status(user);
    if (!s.speech || !s.speechStreaming) throw unavailable('Streaming speech is not available.');
    if (!speechQuota.hit(`${user.institution_id}:${user.id}`)) throw tooMany('Please wait a moment before starting more speech.');
    const options = speechOptions(s.speechModel, { voice, speed });
    return { ...await audioSession({ env, fetchImpl, kind: 'speech', model: s.speechModel, signal }),
      voice: options.voice, speed: options.speed || 1, outputFormat: { type: 'audio/pcm', rate: 24000 } };
  }

  async function recognitionSession({ user, language, terms = [], signal }) {
    const info = status(user).recognition;
    if (!info.enabled) throw unavailable('External recognition is not available. Browser speech recognition is available.');
    if (!(info.provider === 'wispr' ? wisprQuota : recognitionQuota).hit(`${user.institution_id}:${user.id}`)) throw tooMany('Voice input is reconnecting too often. Please wait a moment.');
    // The current Gateway streaming adapter does not forward vocabulary. Avoid an unused profile round trip.
    if (info.provider === 'gateway') return recognition.session({ language, user, signal });
    const profile = db.get('SELECT p.programme FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.institution_id = ?', user.id, user.institution_id);
    // Lecture terms first (they matter most), then the campus basics; Deepgram takes about a hundred keyterms.
    const dictionary = [...terms, 'Campus', 'OTH Amberg-Weiden', 'HSG', 'WTC', 'Mensa', 'Prüfungsamt', profile?.programme, user.preferences?.assistantName].filter(Boolean).map((s) => String(s).slice(0, 120)).slice(0, 100);
    return recognition.session({ language, user, dictionary, signal });
  }

  /** One piece of speech in a natural voice: { audio: Buffer, mime }. */
  async function speak({ user, text, voice = '', speed = 1, language = null, signal }) {
    const s = status(user);
    if (!s.speech) throw unavailable('Natural voices are not available. Campus uses this device’s voices.');
    if (!speechQuota.hit(`${user.institution_id}:${user.id}`)) throw tooMany('Campus is speaking a lot right now. Please wait a moment.');
    const options = speechOptions(s.speechModel, { voice, language, speed });
    text = calmText(text);
    const key = crypto.createHash('sha256').update(JSON.stringify([user.institution_id, user.id, s.speechModel, options, text])).digest('hex');
    const hit = audioCache.get(key);
    if (hit) {
      audioCache.delete(key);
      audioCache.set(key, hit);
      return hit;
    }
    const { mime, ...request } = options;
    const audio = await providers.speech(selected(user.institution_id), text, request, { signal });
    const result = { audio, mime };
    remember(key, result);
    return result;
  }

  function retrieve(user, query, limit = 4) {
    return retrieval.find(user.institution_id, query, { limit }).map((hit, i) => toSource(hit, i + 1));
  }

  /** Longer passages for the model; short citations remain suitable for the UI. */
  function retrieveContext(user, query, limit = 6) {
    const profile = academic ? db.get('SELECT p.programme, p.semester FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.institution_id = ?', user.id, user.institution_id) : null;
    const found = retrieval.find(user.institution_id, query, { limit, profile });
    const hits = []; const references = []; let remaining = 28000;
    for (const hit of found) {
      const reference = { ...toSource(hit, hits.length + 1), excerpt: hit.academic ? hit.content : hit.content.slice(0, 3000),
        ...(hit.academic ? { metadata: hit.header || '', pageHeading: hit.page_heading || '' } : {}) };
      const size = JSON.stringify(reference).length;
      if (size > remaining) continue; // Never chop a layout, OCR row or provenance in the middle.
      remaining -= size; hits.push(hit); references.push(reference);
    }
    return {
      sources: hits.map((hit, i) => toSource(hit, i + 1)),
      references,
    };
  }

  /** A pass for one live voice conversation: { token, expiresAt, url, model }. */
  async function liveSession({ user, signal }) {
    if (!status(user).live) throw unavailable('Live voice is not available. Campus uses its standard voice instead.');
    if (!liveQuota.hit(`${user.institution_id}:${user.id}`)) throw tooMany('Please wait a moment before starting another voice conversation.');
    try {
      return await openLiveSession({ env, fetchImpl, model: liveModel(), signal });
    } catch (error) {
      if (error.refused) liveRestsUntil = Date.now() + 10 * 60_000;
      throw error;
    }
  }

  /** Build the knowledge indexes ahead of time, so the first question after a restart does not wait for them. */
  function warm() {
    for (const { id } of db.all('SELECT id FROM institutions ORDER BY id LIMIT 10')) retrieval.find(id, 'campus', { limit: 1 });
  }

  return {
    status,
    setProvider,
    warm,
    setModel,
    setTools,
    complete,
    read,
    stream,
    speak,
    speechInfo,
    playbackSession,
    recognitionSession,
    liveSession,
    retrieve,
    retrieveContext,
    bundledCount: retrieval.bundledCount,
    providers: (user) => providers.list({ model: user ? settingsFor(user.institution_id).model : null }),
  };
}

module.exports = { createAiService };
