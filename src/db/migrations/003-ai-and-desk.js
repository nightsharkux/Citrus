'use strict';
/**
 * 1. Rebuild institution_ai_settings without the old CHECK constraint so new
 *    providers (e.g. Anthropic) can be added in code without schema changes.
 * 2. Move the 0.5/0.6 "My AI Desk" pseudo-workspaces into proper assistant
 *    threads and archive them, so they no longer clutter the workspace list.
 */
module.exports = {
  version: 3,
  name: 'ai-settings-and-assistant-threads',
  up(db) {
    db.exec(`
      CREATE TABLE ai_settings_new(
        institution_id INTEGER PRIMARY KEY REFERENCES institutions(id),
        provider TEXT NOT NULL, updated TEXT NOT NULL);
      INSERT INTO ai_settings_new(institution_id, provider, updated)
        SELECT institution_id, provider, updated FROM institution_ai_settings;
      DROP TABLE institution_ai_settings;
      ALTER TABLE ai_settings_new RENAME TO institution_ai_settings;
    `);

    const desks = db.all("SELECT id, creator_id, created FROM workspaces WHERE title = 'My AI Desk' AND kind = 'study' AND archived = 0");
    for (const desk of desks) {
      const messages = db.all('SELECT role, content, created FROM ai_chats WHERE workspace_id = ? AND user_id = ? ORDER BY id', desk.id, desk.creator_id);
      if (messages.length) {
        const first = messages.find((m) => m.role === 'user');
        const title = first ? first.content.slice(0, 60) : 'Earlier conversation';
        const last = messages[messages.length - 1].created;
        const threadId = db.insert('INSERT INTO assistant_threads(user_id, title, created, updated) VALUES(?, ?, ?, ?)', desk.creator_id, title, desk.created, last);
        for (const m of messages) {
          if (m.role === 'user' || m.role === 'assistant') {
            db.run('INSERT INTO assistant_messages(thread_id, role, content, created) VALUES(?, ?, ?, ?)', threadId, m.role, m.content, m.created);
          }
        }
      }
      db.run('UPDATE workspaces SET archived = 1 WHERE id = ?', desk.id);
    }
  },
};
