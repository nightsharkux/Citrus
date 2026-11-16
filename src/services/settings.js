'use strict';
/**
 * Per-institution settings stored as key/value pairs. Defaults live here, so
 * adding a setting is one line.
 */
const DEFAULTS = Object.freeze({
  allowRegistration: true,
  lecturerApproval: false, // true: new lecturers wait for an administrator; false: anyone may register as a lecturer
  ssoOnly: false,
  recordingRetentionDays: 0, // 0 = keep until the owner deletes them
});

// Read on almost every request (sign-in page, registration, bootstrap) and changed a few times a year: each read is
// a round trip to the hosted database, so an instance keeps what it read for a few seconds. A change made through
// this instance shows at once; one made through another instance within TTL_MS.
const TTL_MS = 10_000;

function createSettings(db) {
  const cache = new Map();

  function all(institutionId) {
    const hit = cache.get(institutionId);
    if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value };
    const value = load(institutionId);
    cache.set(institutionId, { at: Date.now(), value });
    return { ...value };
  }

  function load(institutionId) {
    const rows = db.all('SELECT key, value FROM settings WHERE institution_id = ?', institutionId);
    const out = { ...DEFAULTS };
    for (const { key, value } of rows) {
      if (key in DEFAULTS) {
        try {
          out[key] = JSON.parse(value);
        } catch {
          out[key] = DEFAULTS[key];
        }
      }
    }
    return out;
  }

  const get = (institutionId, key) => all(institutionId)[key];

  function set(institutionId, changes) {
    cache.delete(institutionId);
    for (const [key, value] of Object.entries(changes)) {
      if (!(key in DEFAULTS)) continue;
      db.run(
        'INSERT INTO settings(institution_id, key, value) VALUES(?, ?, ?) ON CONFLICT(institution_id, key) DO UPDATE SET value = excluded.value',
        institutionId, key, JSON.stringify(value),
      );
    }
    cache.delete(institutionId);
    return all(institutionId);
  }

  return { all, get, set, DEFAULTS };
}

module.exports = { createSettings };
