'use strict';
const { addColumn } = require('../helpers');
module.exports = {
  version: 12,
  name: 'ai-model-choice',
  up(db) { addColumn(db, 'institution_ai_settings', 'chat_model', 'TEXT'); },
};
