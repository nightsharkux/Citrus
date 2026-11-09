'use strict';
/** A space's creator can open it to everyone at their university, who can then browse and join it without a code. */
const { addColumn } = require('../helpers');

module.exports = {
  version: 15,
  name: 'open-spaces',
  up(db) {
    addColumn(db, 'workspaces', 'open', 'INTEGER NOT NULL DEFAULT 0');
  },
};
