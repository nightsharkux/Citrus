'use strict';
/** Store the optional illustration cue that accompanies an assistant answer. */
const { addColumn } = require('../helpers');

module.exports = {
  version: 4,
  name: 'assistant-visuals',
  up(db) {
    addColumn(db, 'assistant_messages', 'visual', 'TEXT');
  },
};
