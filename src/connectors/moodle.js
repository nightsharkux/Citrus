'use strict';
/**
 * Moodle Web Services connector (REST, JSON).
 *
 * Users link their own Moodle account with a personal web-service token
 * (Moodle → Preferences → Security keys). Campus OS never asks for or stores
 * a Moodle password. Tokens are encrypted at rest.
 *
 * Connector contract (copy this shape for new connectors in this folder):
 *   createXConnector({ baseUrl, fetchImpl }) -> { configured(), verify(token), <read methods> }
 */
function createMoodleConnector({ baseUrl, fetchImpl = (...a) => fetch(...a) }) {
  const configured = () => !!baseUrl;

  async function call(token, wsfunction, params = {}) {
    if (!configured()) throw new Error('Moodle is not configured on this server');
    const url = new URL(`${baseUrl}/webservice/rest/server.php`);
    const body = new URLSearchParams({ wstoken: token, wsfunction, moodlewsrestformat: 'json', ...params });
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Moodle returned HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.exception) throw new Error(json.message || 'Moodle rejected the request');
    return json;
  }

  /** Check a token and return the Moodle identity it belongs to. */
  async function verify(token) {
    const info = await call(token, 'core_webservice_get_site_info');
    return { userId: info.userid, fullName: info.fullname, siteName: info.sitename };
  }

  async function courses(token, moodleUserId) {
    const list = await call(token, 'core_enrol_get_users_courses', { userid: String(moodleUserId) });
    return (Array.isArray(list) ? list : []).map((c) => ({
      id: c.id,
      name: c.fullname,
      shortName: c.shortname,
      url: `${baseUrl}/course/view.php?id=${c.id}`,
      progress: typeof c.progress === 'number' ? Math.round(c.progress) : null,
    }));
  }

  return { configured, verify, courses };
}

module.exports = { createMoodleConnector };
