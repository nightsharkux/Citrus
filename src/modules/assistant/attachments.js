'use strict';
/**
 * Pictures and documents attached to assistant messages.
 *
 * Upload first (POST /api/assistant/attachments), then send the message with the
 * returned ids. Documents are read to text once on upload; images are kept so the
 * model can look at them again in follow-up questions. Everything is scoped to
 * the uploading user and an attachment can only be sent once.
 */
const { badRequest, notFound } = require('../../http/errors');
const { extractText, IMAGE_TYPES } = require('../../lib/extract-text');
const { referenceBlock } = require('../../ai/prompts');

const MAX_IMAGE = 3_000_000;
const MAX_DOCUMENT = 3_000_000;
const MAX_PER_MESSAGE = 6;
const MAX_PENDING = 12;
const TEXT_PER_DOCUMENT = 60_000;
const TEXT_PER_TURN = 90_000;
const TEXT_PER_HISTORY = 24_000;
/** Pictures the model gets to look at per request: the newest ones. */
const IMAGES_PER_REQUEST = 4;

const MAGIC = [
  ['image/png', (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8'],
  ['image/webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
];

const cleanName = (name) => String(name || 'file').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';

function createAttachments({ db }) {
  const iso = () => new Date().toISOString();

  function add(user, body) {
    const name = cleanName(body.name);
    const encoded = typeof body.data === 'string' ? body.data.replace(/^data:[^,]*,/, '') : '';
    if (!encoded) throw badRequest('Choose a file to attach');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length) throw badRequest('That file is empty');

    const stale = new Date(Date.now() - 86_400_000).toISOString();
    db.run('DELETE FROM assistant_attachments WHERE user_id = ? AND message_id IS NULL AND created < ?', user.id, stale);
    if (db.get('SELECT COUNT(*) n FROM assistant_attachments WHERE user_id = ? AND message_id IS NULL', user.id).n >= MAX_PENDING) {
      throw badRequest('Send your message first, or remove some of the attached files');
    }

    const image = MAGIC.find(([, matches]) => matches(bytes));
    if (image && IMAGE_TYPES.has(image[0])) {
      if (bytes.length > MAX_IMAGE) throw badRequest('That picture is too large. Try a smaller one.');
      const attachmentId = db.insert(
        "INSERT INTO assistant_attachments(user_id, kind, name, mime, size, data, created) VALUES(?, 'image', ?, ?, ?, ?, ?)",
        user.id, name, image[0], bytes.length, bytes.toString('base64'), iso(),
      );
      return { id: attachmentId, kind: 'image', name, mime: image[0], size: bytes.length };
    }

    if (bytes.length > MAX_DOCUMENT) throw badRequest('That file is too large. The limit is 3 MB.');
    let text;
    try {
      text = extractText({ name, mime: String(body.mime || ''), buffer: bytes });
    } catch (error) {
      throw badRequest(error.message);
    }
    const truncated = text.length > TEXT_PER_DOCUMENT;
    const kept = text.slice(0, TEXT_PER_DOCUMENT);
    // Lecture notes (keep_file) keep a PDF's pages as well, so the lecturer can show it full screen. Others keep text only.
    const pdf = body.keep_file === true && bytes.length > 5 && bytes.toString('latin1', 0, 5) === '%PDF-';
    const attachmentId = db.insert(
      "INSERT INTO assistant_attachments(user_id, kind, name, mime, size, text, data, created) VALUES(?, 'document', ?, ?, ?, ?, ?, ?)",
      user.id, name, pdf ? 'application/pdf' : String(body.mime || '').slice(0, 100), bytes.length, kept, pdf ? bytes.toString('base64') : '', iso(),
    );
    return { id: attachmentId, kind: 'document', name, mime: String(body.mime || ''), size: bytes.length, chars: kept.length, truncated };
  }

  /** Unsent uploads of this user, in the order they were asked for. */
  function claim(user, ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const wanted = [...new Set(ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, MAX_PER_MESSAGE + 1);
    if (wanted.length > MAX_PER_MESSAGE) throw badRequest(`Attach up to ${MAX_PER_MESSAGE} files per message`);
    const rows = db.all(`SELECT * FROM assistant_attachments WHERE user_id = ? AND message_id IS NULL AND id IN (${wanted.map(() => '?').join(',')})`, user.id, ...wanted);
    if (rows.length !== wanted.length) throw badRequest('One of the attached files is no longer available. Attach it again.');
    return wanted.map((n) => rows.find((r) => r.id === n));
  }

  const link = (rows, messageId) => rows.forEach((r) => db.run('UPDATE assistant_attachments SET message_id = ? WHERE id = ? AND message_id IS NULL', messageId, r.id));

  /** What the client shows for a message: no bytes, no text. */
  const publicView = (r) => ({ id: r.id, kind: r.kind, name: r.name, mime: r.mime, size: r.size });

  function forMessages(messageIds) {
    if (!messageIds.length) return new Map();
    const rows = db.all(`SELECT id, message_id, kind, name, mime, size FROM assistant_attachments WHERE message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY id`, ...messageIds);
    const byMessage = new Map();
    for (const r of rows) byMessage.set(r.message_id, [...(byMessage.get(r.message_id) || []), publicView(r)]);
    return byMessage;
  }

  /**
   * The model's view of one message's files: documents as untrusted reference blocks
   * (so a document cannot give the assistant orders) and pictures as data URLs.
   */
  function forModel(rows, { textBudget = TEXT_PER_TURN } = {}) {
    const documents = rows.filter((r) => r.kind === 'document');
    const share = documents.length ? Math.floor(textBudget / documents.length) : 0;
    const blocks = documents.map((r) => referenceBlock('ATTACHMENT', { file: r.name, text: r.text.slice(0, share), ...(r.text.length > share ? { note: 'Shortened: the rest of the file is not shown.' } : {}) }));
    const images = rows.filter((r) => r.kind === 'image').map((r) => `data:${r.mime};base64,${r.data}`);
    return { blocks, images, names: rows.map((r) => r.name) };
  }

  /** History entries with their files, newest pictures and documents within budget. */
  function decorate(history) {
    const ids = history.filter((h) => h.id).map((h) => h.id);
    if (!ids.length) return history;
    const rows = db.all(`SELECT * FROM assistant_attachments WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids);
    if (!rows.length) return history;
    let textLeft = TEXT_PER_HISTORY;
    let imagesLeft = IMAGES_PER_REQUEST - 1;
    const extras = new Map();
    for (const h of [...history].reverse()) {
      const own = rows.filter((r) => r.message_id === h.id);
      if (!own.length) continue;
      const take = [];
      for (const r of own) {
        if (r.kind === 'image') {
          if (imagesLeft > 0) {
            imagesLeft--;
            take.push(r);
          }
        } else if (textLeft > 0) {
          const cut = { ...r, text: r.text.slice(0, textLeft) };
          textLeft -= cut.text.length;
          take.push(cut);
        }
      }
      const view = forModel(take, { textBudget: Infinity });
      const skipped = own.filter((r) => !take.includes(r) && !take.some((t) => t.id === r.id));
      extras.set(h.id, { ...view, skipped: skipped.map((r) => r.name) });
    }
    return history.map((h) => {
      const x = extras.get(h.id);
      if (!x) return h;
      const note = x.skipped.length ? `\n(Earlier attachments no longer shown: ${x.skipped.join(', ')}.)` : '';
      return { ...h, content: [h.content, ...x.blocks].filter(Boolean).join('\n\n') + note, images: x.images };
    });
  }

  function file(user, attachmentId) {
    const r = db.get(
      `SELECT a.* FROM assistant_attachments a WHERE a.id = ? AND a.user_id = ? AND a.kind = 'image'`,
      attachmentId, user.id,
    );
    if (!r) throw notFound('File not found');
    return { mime: r.mime, bytes: Buffer.from(r.data, 'base64'), name: r.name };
  }

  function remove(user, attachmentId) {
    db.run('DELETE FROM assistant_attachments WHERE id = ? AND user_id = ? AND message_id IS NULL', attachmentId, user.id);
  }

  return { add, claim, link, publicView, forMessages, forModel, decorate, file, remove, MAX_PER_MESSAGE };
}

module.exports = { createAttachments };
