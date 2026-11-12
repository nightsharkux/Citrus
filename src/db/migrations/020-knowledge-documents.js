'use strict';
/**
 * Files uploaded to the knowledge library in whatever form they come (PDFs, scans, photos of slides, Word,
 * PowerPoint, Excel, text). Each file is read page by page, pictures and scanned pages by the AI, and kept as
 * plain text in the library format, so the assistant can search and cite it and anyone can download it as .txt.
 *
 *   knowledge_documents  one uploaded file and its status (reading → ready, or failed)
 *   knowledge_pages      its pages: text from the file itself, a picture waiting to be read by the AI, or (method
 *                        'pdf', last_page) a run of pages of a PDF the AI reads itself because its text cannot be
 *                        decoded. `source` keeps such a PDF only until it has been read.
 *   unit                 what a "page" is: page (PDF, picture), slide, sheet or part (Word, text)
 * Library entries made from a document have external_id 'doc<id>:...', so deleting the document removes them.
 */
module.exports = {
  version: 20,
  name: 'knowledge-documents',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents(
        id INTEGER PRIMARY KEY,
        institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
        uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL DEFAULT 'page',
        source TEXT,
        category TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'reading' CHECK(status IN ('reading','ready','failed')),
        error TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        pages INTEGER NOT NULL DEFAULT 0,
        entries INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL,
        updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_kdocs ON knowledge_documents(institution_id, id);
      CREATE TABLE IF NOT EXISTS knowledge_pages(
        document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        page INTEGER NOT NULL,
        method TEXT NOT NULL CHECK(method IN ('text','vision','pdf')),
        last_page INTEGER,
        status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('pending','done','failed')),
        image TEXT,
        mime TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (document_id, page));
    `);
  },
};
