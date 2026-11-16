'use strict';
/**
 * A link for every lecture, behind its QR code (src/modules/live/links.js): anyone who scans it joins the lecture,
 * with or without an account. Made the first time the lecturer asks for the QR code; empty until then.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 26,
  name: 'lecture-links',
  up(db) {
    addColumn(db, 'lectures', 'join_token', "TEXT NOT NULL DEFAULT ''");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_lectures_join_token ON lectures(join_token) WHERE join_token != ''");
  },
};
