'use strict';
/**
 * Everyone accepts the Data Service and Privacy Agreement to use the app, and again when it changes
 * (modules/legal). The users table holds the version each person last accepted (read with every request, so no
 * extra query), and a history keeps every acceptance: who, which version, when, in which role and how.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 29,
  name: 'agreement',
  up(db) {
    addColumn(db, 'users', 'agreement_version', 'TEXT');
    addColumn(db, 'users', 'agreement_at', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS agreement_acceptances(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        role TEXT NOT NULL,
        via TEXT NOT NULL,
        created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_agreement_acceptances ON agreement_acceptances(user_id, id);
    `);
  },
};
