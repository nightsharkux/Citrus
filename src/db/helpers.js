'use strict';

/** Adds a column only if it does not exist yet (SQLite has no ADD COLUMN IF NOT EXISTS). */
function addColumn(db, table, column, definition) {
  if (!db.columns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

module.exports = { addColumn };
