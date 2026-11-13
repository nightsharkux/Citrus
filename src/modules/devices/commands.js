'use strict';
/**
 * Server → device command queue. Devices fetch commands on heartbeat; a
 * heartbeat may long-poll (wait up to 25 s) so lights and pucks react
 * immediately without hammering the server.
 *
 * Command types sent today:
 *   room.status      { room, status, note }       door lights, displays
 *   display.message  { text }                     any device with a screen/LED
 *   class.pulse      { session, status, following, unsure, lost, answered }
 *                    the live class status in the lecture's room: good · watch · trouble · quiet · off (pucks)
 *   speak            { text }                     voice puck
 *   session.started  { lecturer, course, sessionId }
 *   session.ended    {}
 *   nfc.pair         { name }                     reader: "tap the card to pair"
 *   ping             {}
 */
function createDeviceCommands({ db }) {
  const waiters = new Map();

  function wake(deviceId) {
    const set = waiters.get(deviceId);
    if (!set) return;
    waiters.delete(deviceId);
    for (const resolve of set) resolve();
  }

  function queue(deviceId, type, payload = {}) {
    const commandId = db.insert(
      'INSERT INTO device_commands(device_id, type, payload, created) VALUES(?, ?, ?, ?)',
      deviceId, type, JSON.stringify(payload), new Date().toISOString(),
    );
    wake(deviceId);
    return commandId;
  }

  /** Send to every active device registered in a room. */
  function toRoom(institutionId, room, type, payload = {}) {
    if (!room) return 0;
    const targets = db.all("SELECT id FROM devices WHERE institution_id = ? AND room = ? AND status = 'active'", institutionId, room);
    for (const d of targets) queue(d.id, type, payload);
    return targets.length;
  }

  /** Take queued commands (marks them delivered). */
  function take(deviceId) {
    const rows = db.all("SELECT id, type, payload FROM device_commands WHERE device_id = ? AND status = 'queued' ORDER BY id LIMIT 20", deviceId);
    const at = new Date().toISOString();
    for (const r of rows) db.run("UPDATE device_commands SET status = 'delivered', delivered = ? WHERE id = ?", at, r.id);
    return rows.map((r) => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload) }));
  }

  /** Resolve after a command arrives or `ms` passes. */
  function waitFor(deviceId, ms) {
    return new Promise((resolve) => {
      const set = waiters.get(deviceId) || new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      set.add(done);
      waiters.set(deviceId, set);
    });
  }

  function ack(deviceId, commandId, result) {
    const row = db.get('SELECT id FROM device_commands WHERE id = ? AND device_id = ?', commandId, deviceId);
    if (!row) return false;
    db.run("UPDATE device_commands SET status = 'acked', acked = ?, result = ? WHERE id = ?", new Date().toISOString(), JSON.stringify(result ?? null).slice(0, 2000), commandId);
    return true;
  }

  return { queue, toRoom, take, waitFor, ack };
}

module.exports = { createDeviceCommands };
