'use strict';
/** Deepgram Nova-3 live recognition. The project key stays server-side; grants expire after 30 seconds. */
const { unavailable } = require('../http/errors');

function createRecognitionProvider({ env, fetchImpl = (...args) => fetch(...args) }) {
  const key = () => String(env.DEEPGRAM_API_KEY || '').trim();
  const host = () => env.CAMPUS_STT_REGION === 'global' ? 'api.deepgram.com' : 'api.eu.deepgram.com';
  const enabled = () => (env.CAMPUS_STT_PROVIDER || (key() ? 'deepgram' : 'browser')) === 'deepgram' && !!key();
  const info = () => ({ enabled: enabled(), provider: enabled() ? 'deepgram' : 'browser',
    ...(enabled() ? { model: 'nova-3', multilingual: true, region: host().includes('.eu.') ? 'eu' : 'global' } : {}) });

  async function session({ language = 'multi', signal } = {}) {
    if (!enabled()) throw unavailable('Deepgram recognition is not configured. Browser speech recognition is available.');
    let response;
    try {
      response = await fetchImpl(`https://${host()}/v1/auth/grant`, {
        method: 'POST', headers: { Authorization: `Token ${key()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: 30 }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      });
    } catch {
      throw unavailable('Cannot reach Deepgram. Please try voice input again.');
    }
    if (!response.ok) throw unavailable('Deepgram could not start recognition. Ask the administrator to check its key, permissions and credits.');
    let grant;
    try { grant = await response.json(); } catch { /* handled below */ }
    if (typeof grant?.access_token !== 'string' || !grant.access_token || /\s/.test(grant.access_token)) throw unavailable('Deepgram returned an invalid recognition session.');
    const url = new URL(`wss://${host()}/v1/listen`);
    for (const [name, value] of Object.entries({ model: 'nova-3', language, interim_results: 'true', smart_format: 'true', punctuate: 'true', endpointing: '300', vad_events: 'true', mip_opt_out: 'true' })) url.searchParams.set(name, value);
    // Genuine multilingual decoding, rather than reopening a monolingual recognizer after a guessed switch.
    if (language === 'multi') { url.searchParams.append('language_hint', 'de'); url.searchParams.append('language_hint', 'en'); }
    return { url: url.href, token: grant.access_token, expiresIn: 30, provider: 'deepgram', model: 'nova-3' };
  }
  return { info, session };
}

module.exports = { createRecognitionProvider };
