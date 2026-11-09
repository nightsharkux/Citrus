'use strict';
/**
 * Per-institution switches for the AI Gateway's tools: web search for the assistant and natural (server) voices.
 * Both default to on; an administrator turns them off in Admin → AI & knowledge.
 */
const { addColumn } = require('../helpers');

module.exports = {
  version: 9,
  name: 'ai-tools',
  up(db) {
    addColumn(db, 'institution_ai_settings', 'web_search', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'institution_ai_settings', 'speech', 'INTEGER NOT NULL DEFAULT 1');
  },
};
