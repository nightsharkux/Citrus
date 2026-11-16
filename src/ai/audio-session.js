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

/**
 * GPT-Live: a single-use pass for one voice conversation on the gateway's native Live socket. The browser sends
 * `session.start` itself (features/live.js); the pass is bound to the model and the Live route.
 */
const LIVE_URL = 'wss://ai-gateway.vercel.sh/v1/live/sessions';

async function liveSession({ env, fetchImpl = (...args) => fetch(...args), model, signal }) {
  let response;
  try {
    response = await fetchImpl('https://ai-gateway.vercel.sh/v1/realtime/client-secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(env.AI_GATEWAY_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, routeKind: 'live' }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
  } catch {
    throw unavailable('Cannot reach the live voice service. Citrus uses its standard voice instead.');
  }
  let grant = null;
  if (response.ok) {
    try { grant = await response.json(); } catch { /* handled below */ }
  }
  // The token travels in a WebSocket subprotocol, so it may only contain token characters.
  if (typeof grant?.token !== 'string' || !/^[A-Za-z0-9_.-]{8,4096}$/.test(grant.token)) {
    const error = unavailable('Live voice is not available for this account. Citrus uses its standard voice instead.');
    error.refused = response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429);
    throw error;
  }
  const expiresAt = Number(grant.expiresAt) || Math.floor(Date.now() / 1000) + 60;
  return { token: grant.token, expiresAt, url: LIVE_URL, model };
}

module.exports = { audioSession, liveSession, LIVE_URL, TRANSCRIPTION_MODEL, STREAMING_SPEECH_MODEL };
