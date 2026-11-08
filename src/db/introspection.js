'use strict';

/** Schema questions shared by the local and hosted drivers. */
function addIntrospection(db) {
  db.columns = (table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
  db.hasTable = (table) => !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
  return db;
}

module.exports = { addIntrospection };
