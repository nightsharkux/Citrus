'use strict';
/**
 * The one place the rest of the app talks to AI.
 *
 *   ai.status(user)                      -> provider status for the user's institution
 *   ai.complete({ user, system, prompt, history })
 *   ai.stream({ user, system, prompt, history, signal })   (async iterator of text)
 *   ai.retrieve(user, query)             -> numbered sources for citations
 *   ai.setProvider(user, mode)
 *
 * Every request is attributed to a user so institution settings, quotas and
 * data boundaries are always applied.
 */
const { makeProviders } = require('./providers');
const { createRetrieval, toSource } = require('./retrieval');
const { createRateLimiter } = require('../http/rate-limit');
const { tooMany, badRequest } = require('../http/errors');

function createAiService({ db, env = process.env, fetchImpl }) {
  const providers = makeProviders({ env, ...(fetchImpl ? { fetchImpl } : {}) });
  const retrieval = createRetrieval(db);
  const quota = createRateLimiter({ windowMs: 60_000, max: Number(env.CAMPUS_AI_RATE_PER_MINUTE || 12) });

  const defaultProvider = () => env.CAMPUS_AI_PROVIDER || 'gateway';

  function selected(institutionId) {
    const row = db.get('SELECT provider FROM institution_ai_settings WHERE institution_id = ?', institutionId);
    return providers.providerName(row?.provider || defaultProvider());
  }

  const status = (user) => providers.status(selected(user.institution_id));

  function setProvider(user, mode) {
    if (!providers.modes.includes(mode)) throw badRequest(`Choose one of: ${providers.modes.join(', ')}`);
    db.run(
      `INSERT INTO institution_ai_settings(institution_id, provider, updated) VALUES(?, ?, ?)
       ON CONFLICT(institution_id) DO UPDATE SET provider = excluded.provider, updated = excluded.updated`,
      user.institution_id, mode, new Date().toISOString(),
    );
    return status(user);
  }

  function checkQuota(user) {
    if (!quota.hit(user.id)) throw tooMany('Please allow a minute before sending more AI requests');
  }

  async function complete({ user, system, prompt, history = [], maxTokens, task = 'chat' }) {
    checkQuota(user);
    return providers.generate(selected(user.institution_id), system, prompt, history, { maxTokens, task });
  }

  function stream({ user, system, prompt, history = [], signal, maxTokens }) {
    checkQuota(user);
    return providers.stream(selected(user.institution_id), system, prompt, history, { signal, maxTokens });
  }

  function retrieve(user, query, limit = 4) {
    return retrieval.find(user.institution_id, query, { limit }).map((hit, i) => toSource(hit, i + 1));
  }

  /** Longer passages for the model; short citations remain suitable for the UI. */
  function retrieveContext(user, query, limit = 4) {
    const hits = retrieval.find(user.institution_id, query, { limit });
    return {
      sources: hits.map((hit, i) => toSource(hit, i + 1)),
      references: hits.map((hit, i) => ({ ...toSource(hit, i + 1), excerpt: hit.content.slice(0, 3500) })),
    };
  }

  return {
    status,
    setProvider,
    complete,
    stream,
    retrieve,
    retrieveContext,
    providers: providers.list,
  };
}

module.exports = { createAiService };
