'use strict';
/** Register migrations in order. Never edit a migration that has shipped — add a new one. */
module.exports = [
  require('./001-baseline'),
  require('./002-platform'),
  require('./003-ai-and-desk'),
  require('./004-assistant-visuals'),
  require('./005-app-keys'),
  require('./006-assistant-actions'),
  require('./007-lecture-insights'),
  require('./008-assistant-attachments'),
  require('./009-ai-tools'),
  require('./010-quizzes'),
];
