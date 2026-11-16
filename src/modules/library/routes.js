'use strict';
/**
 * Documents for Citrus: lecturers and administrators upload files in whatever form they have them, and Citrus reads
 * them into the knowledge library (see service.js). Everyone's assistant at the university can then find and cite
 * them. Lecturers manage their own uploads; administrators manage all of them.
 *
 *   GET    /api/library/documents              the uploads I may manage
 *   POST   /api/library/documents              { name, mime, data: base64 }  upload and start reading
 *   POST   /api/library/documents/:id/read     read the next pages → { document, retryIn? }  (call until ready)
 *   GET    /api/library/documents/:id/text     the document as a .txt file in the library format
 *   GET    /api/library/export.txt             every ready document I manage, as one .txt file
 *   DELETE /api/library/documents/:id          remove it and its library entries
 */
const { text, id } = require('../../lib/validate');
const { badRequest, forbidden, notFound, tooLarge } = require('../../http/errors');
const { createLibrary } = require('./service');

const STAFF = { roles: ['lecturer', 'admin'] };
const MAX_BYTES = 10 * 1024 * 1024;

const cleanName = (name) => String(name || 'file').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) || 'file';
const fileName = (name) => `${name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'document'}.txt`;

function register(router, { db, ai, audit }) {
  const library = createLibrary({ db, ai });

  /** A document this person may manage: their own upload, or any upload at their university for an admin. */
  function manageable(user, docId) {
    const doc = db.get('SELECT * FROM knowledge_documents WHERE id = ? AND institution_id = ?', id(docId, 'Document'), user.institution_id);
    if (!doc) throw notFound('Document not found');
    if (user.role !== 'admin' && doc.uploader_id !== user.id) throw forbidden('Only the person who uploaded this, or an administrator, can change it');
    return doc;
  }

  function view(doc) {
    const counts = db.get(
      "SELECT COUNT(*) total, SUM(status = 'pending') pending, SUM(status = 'failed') failed FROM knowledge_pages WHERE document_id = ?",
      doc.id,
    );
    const uploader = doc.uploader_id ? db.get('SELECT name FROM users WHERE id = ?', doc.uploader_id)?.name : '';
    return {
      id: doc.id, name: doc.name, title: doc.category || '', kind: doc.kind, unit: doc.unit, status: doc.status, error: doc.error,
      summary: doc.summary, pages: doc.pages, entries: doc.entries, bytes: doc.bytes, created: doc.created, updated: doc.updated,
      pending: Number(counts.pending || 0), unreadable: Number(counts.failed || 0), uploader: uploader || '',
    };
  }

  const mine = (user) => db.all(
    `SELECT * FROM knowledge_documents WHERE institution_id = ? AND (? = 'admin' OR uploader_id = ?) ORDER BY id DESC LIMIT 300`,
    user.institution_id, user.role, user.id,
  );

  router.get('/api/library/documents', (ctx) => ({ documents: mine(ctx.user).map(view), aiEnabled: ai.status(ctx.user).aiEnabled }), STAFF);

  router.post('/api/library/documents', async (ctx) => {
    const b = await ctx.json(Math.ceil(MAX_BYTES * 1.4) + 4096);
    const name = cleanName(text(b.name, { min: 1, max: 200, label: 'File name' }));
    const encoded = typeof b.data === 'string' ? b.data.replace(/^data:[^,]*,/, '') : '';
    if (!encoded) throw badRequest('Choose a file to upload');
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length) throw badRequest('That file is empty');
    if (buffer.length > MAX_BYTES) throw tooLarge('That file is larger than 10 MB. Split it, or upload the pages as pictures.');
    let doc;
    try {
      doc = await library.add(ctx.user, { name, buffer, mime: b.mime });
    } catch (error) {
      if (error.status) throw error;
      throw badRequest(error.message || 'This file could not be read');
    }
    audit(ctx.user, 'library_document_uploaded', `${name} (${doc.status})`);
    ctx.status = 201;
    return { document: view(doc) };
  }, STAFF);

  router.post('/api/library/documents/:id/read', async (ctx) => {
    const doc = manageable(ctx.user, ctx.params.id);
    const { doc: next, retryIn } = await library.readNext(ctx.user, doc.id);
    return { document: view(next), ...(retryIn ? { retryIn } : {}) };
  }, STAFF);

  router.get('/api/library/documents/:id/text', (ctx) => {
    const doc = manageable(ctx.user, ctx.params.id);
    if (doc.status !== 'ready') throw badRequest('This document is not ready yet');
    const institution = db.get('SELECT name FROM institutions WHERE id = ?', ctx.user.institution_id)?.name;
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName(doc.name)}"`, 'Cache-Control': 'no-store' });
    ctx.res.end(library.corpusText(institution, [doc]));
  }, STAFF);

  router.get('/api/library/export.txt', (ctx) => {
    const docs = mine(ctx.user).filter((d) => d.status === 'ready').reverse();
    if (!docs.length) throw notFound('No documents are ready yet');
    const institution = db.get('SELECT name FROM institutions WHERE id = ?', ctx.user.institution_id)?.name;
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="campusos-documents-${new Date().toISOString().slice(0, 10)}.txt"`, 'Cache-Control': 'no-store' });
    ctx.res.end(library.corpusText(institution, docs));
  }, STAFF);

  router.delete('/api/library/documents/:id', (ctx) => {
    const doc = manageable(ctx.user, ctx.params.id);
    library.remove(ctx.user, doc.id);
    audit(ctx.user, 'library_document_deleted', doc.name);
    return { ok: true };
  }, STAFF);
}

module.exports = { register };
