'use strict';
/**
 * Room status (open / quiet / do not disturb / consultation). One code path for
 * the app, the voice puck and door lights, so they can never disagree.
 */
const ROOM_STATUSES = ['open', 'quiet', 'do_not_disturb', 'consultation'];

function createRooms({ db, bus, audit, deviceCommands }) {
  function setStatus(user, room, status, note = '') {
    db.run(
      `INSERT INTO notices(institution_id, room, status, note, updated) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(institution_id, room) DO UPDATE SET status = excluded.status, note = excluded.note, updated = excluded.updated`,
      user.institution_id, room, status, note, new Date().toISOString(),
    );
    audit(user, 'room_updated', `${room}:${status}`);
    bus.publish(`institution:${user.institution_id}`, 'room.updated', { room, status, note });
    deviceCommands.toRoom(user.institution_id, room, 'room.status', { room, status, note });
  }

  function clear(user, room) {
    db.run('DELETE FROM notices WHERE institution_id = ? AND room = ?', user.institution_id, room);
    bus.publish(`institution:${user.institution_id}`, 'room.updated', { room, status: null });
    deviceCommands.toRoom(user.institution_id, room, 'room.status', { room, status: 'open', note: '' });
  }

  const get = (institutionId, room) => db.get('SELECT room, status, note, updated FROM notices WHERE institution_id = ? AND room = ?', institutionId, room) || null;

  return { setStatus, clear, get, ROOM_STATUSES };
}

module.exports = { createRooms, ROOM_STATUSES };
