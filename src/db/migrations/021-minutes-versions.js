'use strict';
/**
 * Minutes in several versions: "one copy with the students' questions and one without", "only the decisions".
 * A version is a meeting report with a label and the report it was made from.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 21,
  name: 'minutes-versions',
  up(db) {
    addColumn(db, 'meeting_reports', 'label', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'meeting_reports', 'parent_id', 'INTEGER REFERENCES meeting_reports(id) ON DELETE CASCADE');
  },
};
