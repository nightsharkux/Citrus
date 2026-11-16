'use strict';
/**
 * Cookie sessions. The browser holds a random token; the database stores only
 * its SHA-256 digest, so a leaked database cannot be replayed as sessions.
 */
const { randomToken, sha256 } = require('../../lib/crypto');

const COOKIE = 'campus_session';

function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function createSessions({ db, config }) {
  const maxAgeSeconds = config.sessionDays * 86_400;
  // A signed-in person stays signed in while they use the app: activity pushes the end of the session forward.
  const EXTEND_AFTER_MS = 300_000;

  function cookieHeader(value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;
  }

  function start(user, req, res) {
    const token = randomToken();
    const now = Date.now();
    // Both writes in one round trip to the database.
    db.batch([
      ['INSERT INTO sessions(token, user_id, expires, created, last_seen, user_agent) VALUES(?, ?, ?, ?, ?, ?)',
        sha256(token), user.id, now + maxAgeSeconds * 1000, now, now, String(req.headers['user-agent'] || '').slice(0, 200)],
      ['UPDATE users SET last_login = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', new Date(now).toISOString(), user.id],
    ]);
    res.setHeader('Set-Cookie', cookieHeader(token, maxAgeSeconds));
  }

  /** Resolve the signed-in user (or null). Touches last_seen at most every 5 minutes. */
  function identify(req, res) {
    const token = readCookie(req);
    if (!token) return null;
    const digest = sha256(token);
    const row = db.get(
      `SELECT u.id, u.institution_id, u.name, u.email, u.role, u.requested_role, u.can_publish, u.preferences,
              u.auth_provider, i.name AS institution, s.last_seen, s.token AS session_digest
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN institutions i ON i.id = u.institution_id
       WHERE s.token = ? AND s.expires > ? AND u.deleted = 0`,
      digest, Date.now(),
    );
    if (!row) return null;
    if (!row.last_seen || Date.now() - row.last_seen > 300_000) {
      const now = Date.now();
      db.run('UPDATE sessions SET last_seen = ?, expires = ? WHERE token = ?', now, now + maxAgeSeconds * 1000, digest);
      if (res && !res.headersSent) res.setHeader('Set-Cookie', cookieHeader(token, maxAgeSeconds));
    }
    let preferences = {};
    try {
      preferences = JSON.parse(row.preferences || '{}');
    } catch {
      preferences = {};
    }
    const { last_seen, preferences: _p, ...user } = row;
    return { ...user, can_publish: !!row.can_publish, preferences };
  }

  function end(req, res) {
    const token = readCookie(req);
    if (token) db.run('DELETE FROM sessions WHERE token = ?', sha256(token));
    res.setHeader('Set-Cookie', cookieHeader('', 0));
  }

  /** Public session id = first 12 hex chars of the digest (never the token itself). */
  function list(user) {
    return db
      .all('SELECT token, created, last_seen, user_agent FROM sessions WHERE user_id = ? AND expires > ? ORDER BY last_seen DESC', user.id, Date.now())
      .map((s) => ({ id: s.token.slice(0, 12), created: s.created, lastSeen: s.last_seen, userAgent: s.user_agent, current: s.token === user.session_digest }));
  }

  function revoke(user, publicId) {
    const match = db.all('SELECT token FROM sessions WHERE user_id = ?', user.id).find((s) => s.token.slice(0, 12) === publicId);
    if (match) db.run('DELETE FROM sessions WHERE token = ?', match.token);
    return !!match;
  }

  function revokeOthers(user) {
    db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', user.id, user.session_digest || '');
  }

  return { start, identify, end, list, revoke, revokeOthers };
}

module.exports = { createSessions, readCookie };
