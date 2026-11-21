'use strict';
/**
 * What a lecturer said in a lecture, kept encrypted.
 *
 * The transcript lines and the excerpts of the moments the class got lost in are the lecturer's own words. They are
 * stored sealed (AES-256-GCM), with a key of their own for each lecture, derived from the server's master key (HKDF),
 * so a copy of the database, a backup or a stray query shows nothing readable, and one lecture's key opens no other.
 *
 * Only two doors open them, and both are named for what they are for:
 *   lecturer(session, user)             an opener for the lecturer who teaches the lecture (checked here, once, not by
 *                                       the caller): open(stored) returns the plain text
 *   forAi(session, stored)              as input to a model request, to write something for someone; the words
 *                                       themselves are never sent back to the person who asked
 * Nothing that serves a student's screen calls the first, and a student's record never reads the sealed columns at
 * all (their routes read their own rows and the lecturer's key points for the parts they struggled with, which are
 * not sealed). The cost is a few microseconds per line, paid when a lecturer opens a report or Citrus writes notes,
 * never while a lecture is running (writing a line is one encryption of a few hundred bytes).
 *
 * Rows written before this existed are plain text; they read as they always did, and the maintenance job can seal
 * them (sealLegacy).
 */
const crypto = require('node:crypto');
const { forbidden } = require('../../http/errors');

const PREFIX = 'enc1:';
const SALT = Buffer.from('citrus-lecture-vault-v1');

function createVault(master, { access } = {}) {
  const keys = new Map();
  const keyOf = (sessionId) => {
    let key = keys.get(sessionId);
    if (!key) {
      key = Buffer.from(crypto.hkdfSync('sha256', master, SALT, Buffer.from(`lecture:${sessionId}`), 32));
      if (keys.size > 200) keys.delete(keys.keys().next().value);
      keys.set(sessionId, key);
    }
    return key;
  };
  const aad = (sessionId) => Buffer.from(`citrus-lecture:${sessionId}`);

  /** Seal a text for a lecture. Empty stays empty. */
  function seal(sessionId, plain) {
    const text = String(plain ?? '');
    if (!text) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(sessionId), iv);
    cipher.setAAD(aad(sessionId));
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }

  const isSealed = (stored) => typeof stored === 'string' && stored.startsWith(PREFIX);

  function unseal(sessionId, stored) {
    if (!isSealed(stored)) return String(stored ?? ''); // written before the vault: plain
    try {
      const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(sessionId), raw.subarray(0, 12));
      decipher.setAAD(aad(sessionId));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return ''; // a line that does not open (damaged, or from another lecture) is left out, never shown garbled
    }
  }

  return {
    seal,
    isSealed,
    /** For the lecturer who teaches this lecture, and nobody else. */
    lecturer(session, user) {
      if (!user || user.role === 'student' || !access?.teachingCourse(user, session.course_id)) throw forbidden('Only the lecturer can read this');
      return (stored) => unseal(session.id, stored);
    },
    /** As input to a model request. The text is not returned to the person it is written for. */
    forAi(session, stored) {
      return unseal(session.id, stored);
    },
    /**
     * Seal rows that are still plain (written before the vault), a few hundred at a time in one round trip, so the
     * hourly maintenance never holds up a hosted database. Returns how many were sealed.
     */
    sealLegacy(db, { limit = 300 } = {}) {
      const lines = db.all("SELECT id, session_id, text FROM live_transcript WHERE text NOT LIKE 'enc1:%' LIMIT ?", limit);
      const moments = db.all("SELECT id, session_id, excerpt FROM live_moments WHERE excerpt != '' AND excerpt NOT LIKE 'enc1:%' LIMIT ?", limit);
      const statements = [
        ...lines.map((r) => ['UPDATE live_transcript SET text = ? WHERE id = ?', seal(r.session_id, r.text), r.id]),
        ...moments.map((r) => ['UPDATE live_moments SET excerpt = ? WHERE id = ?', seal(r.session_id, r.excerpt), r.id]),
      ];
      if (statements.length) db.batch(statements);
      return statements.length;
    },
  };
}

module.exports = { createVault, PREFIX };
