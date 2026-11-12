'use strict';
/**
 * A meeting in a space has a start and an end, so its captions and the notes taken during it can be turned into
 * minutes when it ends. Captions already live in live_captions; these columns mark the running meeting.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 19,
  name: 'meetings',
  up(db) {
    addColumn(db, 'workspaces', 'meeting_started', 'TEXT');
    addColumn(db, 'workspaces', 'meeting_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
    addColumn(db, 'meeting_reports', 'meeting_started', 'TEXT');
  },
};
