'use strict';
/** Store what the assistant did on the user's behalf (calendar changes etc.) with the answer, so it can be shown and undone. */
const { addColumn } = require('../helpers');

module.exports = {
  version: 6,
  name: 'assistant-actions',
  up(db) {
    addColumn(db, 'assistant_messages', 'actions', 'TEXT');
  },
};
