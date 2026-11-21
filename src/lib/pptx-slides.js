'use strict';
/**
 * A PowerPoint file as slides that can be drawn: for each slide its background, its text boxes (position, fill, and
 * paragraphs of styled runs) and its pictures, with the speaker notes kept apart. Node built-ins only, like the text
 * reader next to it (lib/extract-text.js).
 *
 * It draws what most lecture decks use: text boxes and placeholders (positions from the slide's layout and master
 * when the slide does not carry its own), solid fills, theme colours, bullets, bold and italic, sizes, alignment and
 * pictures (PNG, JPEG, GIF, WebP). It does not draw charts, SmartArt, shapes' outlines, gradients, animations or
 * videos, and shapes inside groups are placed as if the group were not scaled.
 *
 * Positions are fractions of the slide (0 to 1) and text sizes are percentages of the slide's width, so the page can
 * draw the slide at any size.
 */
const { unzip, Unreadable } = require('./extract-text');

const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_PICTURES_BYTES = 12_000_000;
const MAX_SLIDES = 300;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d) || 32))
  .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);

/** The value of an attribute in the first tag of a fragment. */
const attr = (xml, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(String(xml).match(/^<[^>]*>/)?.[0] || '')?.[1];
/** Every `<tag …>…</tag>` or `<tag …/>` in a fragment, in order. */
const elements = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`, 'g'))].map((m) => m[0]);
const first = (xml, tag) => elements(xml, tag)[0];

/** Relationships of a part: id -> target path (resolved against the part's folder). */
function relationships(files, partName) {
  const slash = partName.lastIndexOf('/');
  const folder = partName.slice(0, slash + 1);
  const rels = files[`${folder}_rels/${partName.slice(slash + 1)}.rels`]?.toString('utf8') || '';
  const out = {};
  for (const tag of elements(rels, 'Relationship')) {
    const id = attr(tag, 'Id');
    let target = attr(tag, 'Target') || '';
    if (!id || /TargetMode="External"/.test(tag)) continue;
    const parts = target.startsWith('/') ? target.slice(1).split('/') : [...folder.split('/').filter(Boolean), ...target.split('/')];
    const resolved = [];
    for (const p of parts) {
      if (p === '..') resolved.pop();
      else if (p && p !== '.') resolved.push(p);
    }
    out[id] = { path: resolved.join('/'), type: attr(tag, 'Type') || '' };
  }
  return out;
}

function themeColors(files) {
  const name = Object.keys(files).filter((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n)).sort()[0];
  const xml = name ? files[name].toString('utf8') : '';
  const scheme = first(xml, 'a:clrScheme') || '';
  const colors = {};
  for (const key of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
    const block = first(scheme, `a:${key}`) || '';
    const value = /<a:srgbClr[^>]*\sval="([0-9a-fA-F]{6})"/.exec(block)?.[1] || /<a:sysClr[^>]*\slastClr="([0-9a-fA-F]{6})"/.exec(block)?.[1];
    if (value) colors[key] = `#${value}`;
  }
  return colors;
}

const SCHEME = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
/** The first colour in a fragment (a solid fill, a run's properties) as #rrggbb, or null. */
function colorIn(xml, theme) {
  if (!xml) return null;
  const rgb = /<a:srgbClr[^>]*\sval="([0-9a-fA-F]{6})"/.exec(xml);
  if (rgb) return `#${rgb[1]}`;
  const scheme = /<a:schemeClr[^>]*\sval="(\w+)"/.exec(xml);
  if (scheme) return theme[SCHEME[scheme[1]] || scheme[1]] || null;
  const sys = /<a:sysClr[^>]*\slastClr="([0-9a-fA-F]{6})"/.exec(xml);
  return sys ? `#${sys[1]}` : null;
}
const solidFill = (xml, theme) => {
  const block = first(String(xml).replace(/<a:ln[\s\S]*?<\/a:ln>/g, ''), 'a:solidFill');
  return block ? colorIn(block, theme) : null;
};

/** Position and size of a shape as { x, y, w, h } in EMU, or null. */
function frame(xml) {
  const xfrm = first(xml, 'a:xfrm');
  if (!xfrm) return null;
  const off = first(xfrm, 'a:off');
  const ext = first(xfrm, 'a:ext');
  if (!off || !ext) return null;
  const f = { x: Number(attr(off, 'x')), y: Number(attr(off, 'y')), w: Number(attr(ext, 'cx')), h: Number(attr(ext, 'cy')) };
  return Object.values(f).every(Number.isFinite) && f.w > 0 && f.h > 0 ? f : null;
}

/** Placeholder positions of a layout or master: [{ type, idx, frame }]. */
function placeholders(xml) {
  return elements(xml || '', 'p:sp').map((sp) => {
    const ph = first(sp, 'p:ph');
    return ph ? { type: attr(ph, 'type') || 'body', idx: attr(ph, 'idx') ?? null, frame: frame(sp) } : null;
  }).filter(Boolean);
}

const TITLE = new Set(['title', 'ctrTitle']);
function inheritedFrame(ph, layout, master) {
  if (!ph) return null;
  const type = attr(ph, 'type') || 'body';
  const idx = attr(ph, 'idx') ?? null;
  const match = (list) => list.find((p) => p.frame && ((idx !== null && p.idx === idx) || (p.type === type) || (TITLE.has(type) && TITLE.has(p.type))));
  return match(layout)?.frame || match(master)?.frame || null;
}

const DEFAULT_SIZE = { ctrTitle: 4400, title: 3600, subTitle: 2400, body: 2400, other: 1800 };

function paragraphsOf(sp, theme, { type, scale }) {
  const body = first(sp, 'p:txBody') || '';
  const noBullets = /<a:buNone\s*\/>/.test(first(body, 'a:lstStyle') || '');
  const paras = [];
  for (const p of elements(body, 'a:p')) {
    const props = first(p, 'a:pPr') || '';
    const level = Number(attr(props, 'lvl')) || 0;
    const bullet = /<a:buNone\s*\/>/.test(props) ? false : /<a:bu(?:Char|AutoNum)/.test(props) ? true : (type === 'body' && !noBullets);
    const runs = [];
    for (const r of elements(p, 'a:r')) {
      const text = decode(first(r, 'a:t')?.replace(/^<a:t[^>]*>|<\/a:t>$/g, '') || '');
      if (!text) continue;
      const rpr = first(r, 'a:rPr') || '';
      const size = Number(attr(rpr, 'sz')) || DEFAULT_SIZE[type] || DEFAULT_SIZE.other;
      runs.push({ t: text, size: Math.round(size * scale), bold: attr(rpr, 'b') === '1' || undefined, italic: attr(rpr, 'i') === '1' || undefined, color: solidFill(rpr, theme) || undefined });
    }
    // A line break inside a paragraph is a new line of the same paragraph.
    if (!runs.length) {
      if (/<a:endParaRPr/.test(p) && paras.length) paras.push({ gap: true });
      continue;
    }
    paras.push({ align: { ctr: 'center', r: 'right', just: 'justify' }[attr(props, 'algn')] || undefined, level: level || undefined, bullet: bullet || undefined, runs });
  }
  return paras;
}

function pictureSrc(pic, rels, files, budget) {
  const id = /<a:blip[^>]*\sr:embed="([^"]+)"/.exec(pic)?.[1];
  const target = id && rels[id]?.path;
  const mime = target && MEDIA[target.split('.').pop().toLowerCase()];
  const data = target && files[target];
  if (!mime || !data || budget.left < data.length) return null;
  budget.left -= data.length;
  return `data:${mime};base64,${data.toString('base64')}`;
}

/** Slides of a .pptx as { width, height, slides: [{ bg, shapes, notes }] } (EMU turned into fractions). */
function parsePptx(buffer) {
  const files = unzip(buffer, (n) => /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(_rels\/)?slide\d+\.xml(\.rels)?|slideLayouts\/(_rels\/)?slideLayout\d+\.xml(\.rels)?|slideMasters\/(_rels\/)?slideMaster\d+\.xml(\.rels)?|notesSlides\/notesSlide\d+\.xml|theme\/theme\d+\.xml|media\/[^/]+)$/.test(n));
  const presentation = files['ppt/presentation.xml']?.toString('utf8');
  if (!presentation) throw new Unreadable('This presentation has no slides to show');
  const size = first(presentation, 'p:sldSz');
  const width = Number(attr(size || '', 'cx')) || 12_192_000;
  const height = Number(attr(size || '', 'cy')) || 6_858_000;
  const theme = themeColors(files);
  const presRels = relationships(files, 'ppt/presentation.xml');
  let order = elements(presentation, 'p:sldId').map((tag) => presRels[attr(tag, 'r:id')]?.path).filter((p) => p && files[p]);
  if (!order.length) order = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  if (!order.length) throw new Unreadable('This presentation has no slides to show');

  const budget = { left: MAX_PICTURES_BYTES };
  const cache = new Map();
  const layoutOf = (path) => {
    if (!cache.has(path)) cache.set(path, placeholders(files[path]?.toString('utf8')));
    return cache.get(path);
  };
  const fx = (n) => Math.round((n / width) * 10000) / 10000;
  const fy = (n) => Math.round((n / height) * 10000) / 10000;

  const slides = order.slice(0, MAX_SLIDES).map((name) => {
    const xml = files[name].toString('utf8');
    const rels = relationships(files, name);
    const layoutPath = Object.values(rels).find((r) => /slideLayout$/.test(r.type))?.path;
    const layoutRels = layoutPath ? relationships(files, layoutPath) : {};
    const masterPath = Object.values(layoutRels).find((r) => /slideMaster$/.test(r.type))?.path;
    const layout = layoutPath ? layoutOf(layoutPath) : [];
    const master = masterPath ? layoutOf(masterPath) : [];

    const background = /<p:bg>[\s\S]*?<\/p:bg>/.exec(xml)?.[0];
    const bg = (background && solidFill(background, theme))
      || (layoutPath && (() => { const b = /<p:bg>[\s\S]*?<\/p:bg>/.exec(files[layoutPath].toString('utf8'))?.[0]; return b && solidFill(b, theme); })())
      || (masterPath && (() => { const b = /<p:bg>[\s\S]*?<\/p:bg>/.exec(files[masterPath].toString('utf8'))?.[0]; return b && solidFill(b, theme); })())
      || null;

    const shapes = [];
    for (const m of xml.matchAll(/<p:(sp|pic)[ >][\s\S]*?<\/p:\1>/g)) {
      const el = m[0];
      const ph = first(el, 'p:ph');
      const box = frame(el) || inheritedFrame(ph, layout, master);
      if (!box) continue;
      const at = { x: fx(box.x), y: fy(box.y), w: fx(box.w), h: fy(box.h) };
      if (m[1] === 'pic') {
        const src = pictureSrc(el, rels, files, budget);
        if (src) shapes.push({ kind: 'image', ...at, src });
        continue;
      }
      const type = ph ? (attr(ph, 'type') || 'body') : 'other';
      const fit = Number(attr(first(el, 'a:normAutofit') || '', 'fontScale')) || 100000;
      const paras = paragraphsOf(el, theme, { type, scale: fit / 100000 });
      const fill = solidFill(first(el, 'p:spPr') || '', theme);
      if (!paras.length && !fill) continue;
      const body = first(el, 'a:bodyPr') || '';
      shapes.push({ kind: 'text', ...at, fill: fill || undefined, anchor: { ctr: 'center', b: 'end' }[attr(body, 'anchor')] || (TITLE.has(type) ? 'center' : 'start'), paras: paras.map((p) => (p.runs ? { ...p, runs: p.runs.map((r) => ({ ...r, size: Math.round(((r.size / 100) * 12700 / width) * 10000) / 100 })) } : p)) });
    }

    const notesXml = files[name.replace('slides/slide', 'notesSlides/notesSlide')]?.toString('utf8') || '';
    // Only the notes text, not the slide image or the slide number that sit on a notes page.
    const notes = elements(notesXml, 'p:sp').filter((sp) => /type="body"/.test(first(sp, 'p:ph') || '')).map((sp) => elements(sp, 'a:p').map((p) => elements(p, 'a:t').map((t) => decode(t.replace(/^<a:t[^>]*>|<\/a:t>$/g, ''))).join('')).filter(Boolean).join('\n')).join('\n').trim();
    return { bg, shapes, notes };
  });
  return { width, height, slides };
}

module.exports = { parsePptx };
