'use strict';
/**
 * Housekeeping that runs hourly: expired sessions, SSO states, device nonces
 * and activations, and recordings past the institution's retention period.
 */
const fs = require('node:fs');
const path = require('node:path');

function createMaintenance({ db, config, settings }) {
  function run() {
    const now = Date.now();
    db.run('DELETE FROM sessions WHERE expires < ?', now);
    db.run('DELETE FROM sso_states WHERE created < ?', now - 15 * 60_000);
    db.run('DELETE FROM device_nonces WHERE seen < ?', now - 15 * 60_000);
    db.run('DELETE FROM nfc_pairings WHERE expires < ?', now);
    db.run("UPDATE device_activations SET status = 'expired' WHERE status = 'pending' AND expires < ?", now);
    db.run("UPDATE device_commands SET status = 'expired' WHERE status = 'queued' AND created < ?", new Date(now - 3_600_000).toISOString());
    db.run('DELETE FROM recording_signals WHERE started < ?', now - 6 * 3_600_000);

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

  let timer = null;
  function start() {
    const tick = () => {
      try {
        run();
      } catch (error) {
        console.error('Maintenance failed:', error.message);
      }
    };
    setTimeout(tick, 5_000).unref();
    timer = setInterval(tick, 3_600_000);
    timer.unref();
  }

  return { run, start, stop: () => clearInterval(timer) };
}

module.exports = { createMaintenance };
