'use strict';
/** Gateway's single-use, model-bound audio grants. Never return the deployment credential. */
const { unavailable } = require('../http/errors');

const TRANSCRIPTION_MODEL = 'openai/gpt-live-transcribe';
const STREAMING_SPEECH_MODEL = 'elevenlabs/eleven-flash-v2.5';

async function audioSession({ env, fetchImpl = (...args) => fetch(...args), kind, model, signal }) {
  let response;
  try {
    response = await fetchImpl('https://ai-gateway.vercel.sh/v1/realtime/client-secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(env.AI_GATEWAY_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, routeKind: kind, expiresIn: 60 }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('grant refused');
    const grant = await response.json();
    if (typeof grant.token !== 'string' || !/^vcst_[A-Za-z0-9_.-]+$/.test(grant.token)) throw new Error('invalid grant');
    const url = new URL(`wss://ai-gateway.vercel.sh/v4/ai/${kind}-model`);
    url.searchParams.set('ai-model-id', model);
    return { token: grant.token, url: url.href, model, provider: 'gateway', expiresIn: 60 };
  } catch {
    throw unavailable(`Cannot start streaming ${kind === 'speech' ? 'speech' : 'recognition'}. Ask the administrator to check AI Gateway audio access and credits.`);
  }
}

module.exports = { audioSession, TRANSCRIPTION_MODEL, STREAMING_SPEECH_MODEL };
