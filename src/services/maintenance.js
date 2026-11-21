'use strict';
/**
 * Housekeeping that runs hourly (and keeps the database small): expired sessions, SSO states, device nonces
 * and activations, and recordings past the institution's retention period.
 */
const fs = require('node:fs');
const path = require('node:path');

const EVERY_MS = 3_600_000;

function createMaintenance({ db, config, settings, vault = null }) {
  function run() {
    const now = Date.now();
    const days = (n) => new Date(now - n * 86_400_000).toISOString();
    // All in one round trip to the database (on a hosted one, each statement on its own was a round trip, and the
    // server instance could answer nobody meanwhile).
    db.batch([
      ['DELETE FROM sessions WHERE expires < ?', now],
      // Guest accounts nobody came back to are retired after a month.
      ["UPDATE users SET deleted = 1 WHERE auth_provider = 'guest' AND deleted = 0 AND COALESCE(last_login, created) < ?", days(30)],
      ['DELETE FROM sso_states WHERE created < ?', now - 15 * 60_000],
      ['DELETE FROM device_nonces WHERE seen < ?', now - 15 * 60_000],
      ['DELETE FROM nfc_pairings WHERE expires < ?', now],
      ["UPDATE device_activations SET status = 'expired' WHERE status = 'pending' AND expires < ?", now],
      ["UPDATE device_commands SET status = 'expired' WHERE status = 'queued' AND created < ?", new Date(now - 3_600_000).toISOString()],
      ['DELETE FROM recording_signals WHERE started < ?', now - 6 * 3_600_000],
      // Keep the database small. None of this is visible in the app: old log lines, read notifications, finished
      // device traffic and attachments that were uploaded but never sent with a message or added to a lecture.
      ['DELETE FROM audit WHERE created < ?', days(180)],
      ['DELETE FROM notifications WHERE read = 1 AND created < ?', days(60)],
      ['DELETE FROM notifications WHERE created < ?', days(180)],
      ['DELETE FROM device_events WHERE created < ?', days(30)],
      ["DELETE FROM device_commands WHERE status != 'queued' AND created < ?", days(30)],
      ['DELETE FROM assistant_attachments WHERE message_id IS NULL AND created < ? AND id NOT IN (SELECT attachment_id FROM live_notes)', days(2)],
      // When it last ran, so other instances (each new one on Vercel) leave it for an hour.
      ["INSERT INTO app_keys(name, value, created) VALUES('maintenance', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", String(now), new Date(now).toISOString()],
    ]);
    // Lecture text written before it was sealed gets sealed, a few hundred rows an hour.
    try {
      vault?.sealLegacy(db);
    } catch (error) {
      console.warn('Sealing older lecture text failed:', error.message);
    }
    if (!db.remote) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const free = db.get('PRAGMA freelist_count');
      if (Number(free?.freelist_count || 0) > 2000) db.exec('VACUUM');
    }

    let removed = 0;
    for (const { id } of db.all('SELECT id FROM institutions')) {
      const days = Number(settings.get(id, 'recordingRetentionDays')) || 0;
      if (days <= 0) continue;
      const cutoff = new Date(now - days * 86_400_000).toISOString();
      const old = db.all(
        `SELECT r.id, r.filename FROM meeting_recordings r JOIN workspaces w ON w.id = r.workspace_id
         WHERE w.institution_id = ? AND r.created < ?`,
        id, cutoff,
      );
      for (const rec of old) {
        db.run('DELETE FROM meeting_reports WHERE recording_id = ?', rec.id);
        db.run('DELETE FROM meeting_recordings WHERE id = ?', rec.id);
        try {
          fs.unlinkSync(path.join(config.audioDir, rec.filename));
        } catch {
          /* already gone */
        }
        removed += 1;
      }
    }
    return { recordingsRemoved: removed };
  }

  /** Has another instance (or this one) done it within the hour? One read. */
  const doneRecently = () => {
    const last = Number(db.get("SELECT value FROM app_keys WHERE name = 'maintenance'")?.value || 0);
    return Date.now() - last < EVERY_MS;
  };

  let timer = null;
  function start() {
    const tick = () => {
      try {
        if (!doneRecently()) run();
      } catch (error) {
        console.error('Maintenance failed:', error.message);
      }
    };
    setTimeout(tick, 5_000).unref();
    timer = setInterval(tick, EVERY_MS);
    timer.unref();
  }

  return { run, start, doneRecently, stop: () => clearInterval(timer) };
}

module.exports = { createMaintenance };
