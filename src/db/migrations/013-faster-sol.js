'use strict';
/** The old Sol preset was medium; preserve model choices while moving that preset to the faster level. */
module.exports = { version: 13, name: 'faster-sol', up(db) {
  db.exec("UPDATE institution_ai_settings SET chat_model = 'openai/gpt-6.1-sol/low' WHERE chat_model = 'openai/gpt-6.1-sol/medium'");
} };
