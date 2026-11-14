'use strict';
/**
 * A student may choose to show their name to the lecturer with their answers and flags in a lecture, so the
 * lecturer can help them personally (notes for them, an email, a word after class). Off unless they turn it on.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 23,
  name: 'share-names',
  up(db) {
    addColumn(db, 'live_attendees', 'share_name', 'INTEGER NOT NULL DEFAULT 0');
  },
};
