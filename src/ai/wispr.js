'use strict';
const { unavailable } = require('../http/errors');
const BASE = 'https://platform-api.wisprflow.ai/api/v1/dash';
function createWispr({ env, fetchImpl = (...args) => fetch(...args) }) {
  const configured = () => !!String(env.WISPR_FLOW_API_KEY || '').trim();
  async function session({ user, language, dictionary = [], signal }) {
    let response;
    try {
      response = await fetchImpl(`${BASE}/generate_access_token`, { method: 'POST',
        headers: { Authorization: `Bearer ${String(env.WISPR_FLOW_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: `campus-${user.institution_id}-${user.id}`, duration_secs: 120 }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    } catch { throw unavailable('Cannot reach Wispr Flow. Please try voice input again.'); }
    if (!response.ok) throw unavailable('Wispr Flow could not start. Ask the administrator to check API access and credits.');
    let grant;
    try { grant = await response.json(); } catch { /* validate below */ }
    if (typeof grant?.access_token !== 'string' || !grant.access_token || /\s/.test(grant.access_token)) throw unavailable('Wispr Flow returned an invalid recognition session.');
    return { provider: 'wispr', model: 'Wispr Flow', url: 'wss://platform-api.wisprflow.ai/api/v1/dash/client_ws', token: grant.access_token, expiresIn: 120,
      language: language === 'multi' ? ['de', 'en'] : [language], context: { app: { name: 'Citrus', type: 'ai' }, dictionary_context: dictionary } };
  }
  return { configured, session };
}
module.exports = { createWispr };
