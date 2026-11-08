'use strict';
/**
 * Plain text out of files people attach to a chat, with Node built-ins only.
 *
 * Supported: text, Markdown, CSV, JSON and source code; HTML; Word (.docx),
 * PowerPoint (.pptx), Excel (.xlsx) and text-based PDFs. Scanned PDFs have no
 * text to read; the caller is told so and can ask for photos of the pages instead.
 */
const zlib = require('node:zlib');

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'toml', 'tex', 'bib', 'srt', 'vtt',
  'js', 'mjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sql', 'sh', 'css', 'r', 'm', 'ipynb']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const extension = (name) => (String(name).split('.').pop() || '').toLowerCase();

class Unreadable extends Error {}

/** Entries of a ZIP archive as { name -> Buffer }, only the ones `want` accepts. */
function unzip(buffer, want) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Unreadable('This file is not a valid document');
  const count = buffer.readUInt16LE(end + 10);
  let p = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let n = 0; n < count && p + 46 <= buffer.length && buffer.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extra = buffer.readUInt16LE(p + 30);
    const comment = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extra + comment;
    if (!want(name)) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    try {
      // A decompressed part is capped so a crafted archive cannot exhaust memory.
      files[name] = method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: 20_000_000 });
    } catch {
      /* skip a damaged part */
    }
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d) || 32))
  .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);

function fromHtml(source) {
  return decode(source
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
}

/** Paragraphs of a Word/PowerPoint XML part. */
function fromOffice(xml, paragraph, run) {
  return [...xml.matchAll(paragraph)].map((p) => {
    const pieces = [...p[0].matchAll(run)].map((r) => decode(r[1]));
    return pieces.join('');
  }).filter(Boolean).join('\n');
}

function fromDocx(buffer) {
  const files = unzip(buffer, (n) => n === 'word/document.xml');
  const xml = files['word/document.xml']?.toString('utf8');
  if (!xml) throw new Unreadable('This Word file has no readable text');
  return fromOffice(xml.replace(/<w:tab\/>/g, '<w:t>\t</w:t>'), /<w:p[ >][\s\S]*?<\/w:p>/g, /<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
}

function fromPptx(buffer) {
  const files = unzip(buffer, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  const number = (n) => Number(n.match(/(\d+)\.xml$/)[1]);
  const slides = Object.keys(files).filter((n) => n.includes('/slides/')).sort((a, b) => number(a) - number(b));
  if (!slides.length) throw new Unreadable('This presentation has no readable text');
  return slides.map((name, i) => {
    const body = fromOffice(files[name].toString('utf8'), /<a:p>[\s\S]*?<\/a:p>/g, /<a:t>([\s\S]*?)<\/a:t>/g);
    const notes = files[name.replace('slides/slide', 'notesSlides/notesSlide')];
    const speaker = notes ? fromOffice(notes.toString('utf8'), /<a:p>[\s\S]*?<\/a:p>/g, /<a:t>([\s\S]*?)<\/a:t>/g) : '';
    return `Slide ${i + 1}\n${body}${speaker ? `\nSpeaker notes: ${speaker}` : ''}`;
  }).join('\n\n');
}

function fromXlsx(buffer) {
  const files = unzip(buffer, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const strings = files['xl/sharedStrings.xml']
    ? [...files['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))
    : [];
  const sheets = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort();
  if (!sheets.length) throw new Unreadable('This spreadsheet has no readable cells');
  return sheets.map((name, i) => {
    const rows = [...files[name].toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => [...row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
      const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2] || '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2] || '')?.[1] ?? '';
      return /t="s"/.test(cell[1]) ? strings[Number(value)] ?? '' : decode(value);
    }).join('\t'));
    return `Sheet ${i + 1}\n${rows.slice(0, 400).join('\n')}`;
  }).join('\n\n');
}

/** Text shown by the content streams of a PDF. Handles the common cases; fonts with custom encodings may not decode. */
function fromPdf(buffer) {
  const raw = buffer.toString('latin1');
  const pages = [];
  for (const m of raw.matchAll(/<<([^>]*?)>>\s*stream\r?\n/g)) {
    if (/\/(Subtype\s*\/Image|Type\s*\/XObject|Type\s*\/ObjStm|Length1)/.test(m[1]) && !/\/Type\s*\/Page\b/.test(m[1])) continue;
    const start = m.index + m[0].length;
    const stop = raw.indexOf('endstream', start);
    if (stop < 0) continue;
    let data = buffer.subarray(start, stop);
    if (/\/FlateDecode/.test(m[1])) {
      try {
        data = zlib.inflateSync(data, { maxOutputLength: 20_000_000 });
      } catch {
        continue;
      }
    }
    const content = data.toString('latin1');
    if (!/\b(BT|Tj|TJ)\b/.test(content)) continue;
    const out = [];
    const unescape = (s) => s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? (/^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8)) : c)));
    const hex = (h) => Buffer.from(h.replace(/\s/g, '').padEnd(Math.ceil(h.replace(/\s/g, '').length / 2) * 2, '0'), 'hex');
    const hexText = (h) => {
      const b = hex(h);
      // Two-byte glyph ids are not text we can map; one-byte hex strings are.
      return b.length % 2 === 0 && b.some((x, i) => i % 2 === 0 && x === 0) ? b.filter((_, i) => i % 2 === 1).toString('latin1') : b.toString('latin1');
    };
    for (const op of content.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]+)>\s*Tj|\bT\*|\bET\b|(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+Td/g)) {
      if (op[1] !== undefined) {
        out.push([...op[1].matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]+)>|(-?\d*\.?\d+)/g)].map((t) => (t[1] !== undefined ? unescape(t[1]) : t[2] !== undefined ? hexText(t[2]) : Number(t[3]) < -250 ? ' ' : '')).join(''));
      } else if (op[2] !== undefined) out.push(unescape(op[2]));
      else if (op[3] !== undefined) out.push(hexText(op[3]));
      else if (op[0] === 'T*' || op[0] === 'ET' || (op[5] !== undefined && Math.abs(Number(op[5])) > 2)) out.push('\n');
      else out.push(' ');
    }
    pages.push(out.join('').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  }
  const text = pages.filter(Boolean).join('\n\n');
  const letters = (text.match(/[\p{L}]/gu) || []).length;
  if (letters < 40 || letters / Math.max(1, text.length) < 0.45) {
    throw new Unreadable('I could not read text in this PDF. It may be scanned or use special fonts. Try attaching photos or screenshots of the pages instead.');
  }
  return text;
}

/** @returns {{ kind: 'image' | 'document', text: string }} */
function classify({ name, mime }) {
  if (IMAGE_TYPES.has(mime)) return 'image';
  return 'document';
}

function extractText({ name, mime = '', buffer }) {
  const ext = extension(name);
  let text;
  if (ext === 'docx') text = fromDocx(buffer);
  else if (ext === 'pptx') text = fromPptx(buffer);
  else if (ext === 'xlsx') text = fromXlsx(buffer);
  else if (ext === 'pdf' || mime === 'application/pdf') text = fromPdf(buffer);
  else if (ext === 'html' || ext === 'htm' || mime === 'text/html') text = fromHtml(buffer.toString('utf8'));
  else if (TEXT_EXT.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
    text = buffer.toString('utf8');
    if (text.includes('\u0000')) throw new Unreadable('This file is not text');
  } else if (ext === 'doc' || ext === 'ppt' || ext === 'xls') {
    throw new Unreadable('Old Office formats are not supported. Save it as .docx, .pptx or .xlsx and attach that.');
  } else {
    throw new Unreadable('This file type is not supported. Attach a PDF, Word, PowerPoint, Excel or text file, or an image.');
  }
  text = text.replace(/\r\n?/g, '\n').replace(/[^\S\n]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Unreadable('I could not find any text in this file.');
  return text;
}

module.exports = { extractText, classify, Unreadable, IMAGE_TYPES, unzip };
