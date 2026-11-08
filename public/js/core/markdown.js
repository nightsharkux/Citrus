/**
 * Safe Markdown + LaTeX for assistant answers: paragraphs, headings, nested
 * lists, tables, blockquotes (a bold first word makes a callout), rules, fenced
 * code, inline code, bold, italic, links, [n] citations and maths ($…$ inline,
 * $$…$$ on its own lines). Everything is escaped first; only known patterns
 * become tags. Maths is drawn by ./math.js.
 *
 *   markdown(text, { citations, streaming })
 *
 * While an answer is still streaming, an unfinished $$ block shows a small
 * placeholder instead of half a formula.
 */
import { escape, raw } from './dom.js';
import { mathHtml } from './math.js';

const MATH_ENV = /^\s*\\begin\{(align\*?|aligned|equation\*?|gather\*?|cases|array|[pbBvV]?matrix|split|eqnarray\*?)\}/;

// ---------------------------------------------------------------- inline

/** Finds the closing single `$` of an inline formula, following the usual rules (no space inside the edges, not before a digit). */
function closingDollar(text, from) {
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (c === '\\') j += 1;
    else if (c === '$') {
      if (/\s/.test(text[j - 1]) || /\d/.test(text[j + 1] || '')) return -1;
      return j;
    }
  }
  return -1;
}

/** Pull maths out of a line before escaping, leaving numbered placeholders. */
function extractMath(text, stash) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '(') {
      const end = text.indexOf('\\)', i + 2);
      if (end > 0) {
        out += stash(text.slice(i + 2, end), false);
        i = end + 2;
        continue;
      }
    }
    if (c === '\\' && text[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (c === '$') {
      if (text[i + 1] === '$') {
        const end = text.indexOf('$$', i + 2);
        if (end > 0) {
          out += stash(text.slice(i + 2, end), true);
          i = end + 2;
          continue;
        }
      } else if (text[i + 1] && !/\s/.test(text[i + 1])) {
        const end = closingDollar(text, i + 1);
        if (end > i + 1) {
          out += stash(text.slice(i + 1, end), false);
          i = end + 1;
          continue;
        }
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

function inline(text, citations) {
  const stashed = [];
  const hold = (html) => {
    stashed.push(html);
    return `\u0000${stashed.length - 1}\u0000`;
  };
  // Maths and code first: nothing inside them is formatted.
  let out = String(text).replace(/`([^`]+)`/g, (_, c) => hold(`<code>${escape(c)}</code>`));
  out = escape(extractMath(out, (latex, display) => hold(mathHtml(latex, { display }))));
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  if (citations?.size) {
    out = out.replace(/\[(\d{1,2})\]/g, (m, n) => (citations.has(Number(n)) ? `<a class="cite" href="#" data-cite="${n}">${n}</a>` : m));
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => stashed[Number(i)]);
}

// ---------------------------------------------------------------- blocks

const isFence = (line) => /^\s*```/.test(line);
const isHeading = (line) => /^\s{0,3}#{1,4}\s+\S/.test(line);
const isRule = (line) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
const isQuote = (line) => /^\s{0,3}>/.test(line);
const isTableSep = (line) => line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const itemOf = (line) => {
  const m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
  if (!m || isRule(line)) return null;
  const ordered = /\d/.test(m[2]);
  return { indent: m[1].replace(/\t/g, '    ').length, ordered, number: ordered ? parseInt(m[2], 10) : 0, text: m[3] };
};

/** If a display-maths block starts at `lines[i]`, returns { latex, next, open } (open = never closed). */
function mathBlockAt(lines, i) {
  const line = lines[i];
  let m = /^\s*\$\$(.+?)\$\$\s*$/.exec(line) || /^\s*\\\[(.+?)\\\]\s*$/.exec(line);
  if (m) return { latex: m[1], next: i + 1 };
  const dollars = /^\s*\$\$(.*)$/.exec(line);
  const bracket = /^\s*\\\[(.*)$/.exec(line);
  if (dollars || bracket) {
    const close = dollars ? '$$' : '\\]';
    const body = [(dollars || bracket)[1]];
    for (let j = i + 1; j < lines.length; j += 1) {
      const at = lines[j].indexOf(close);
      if (at >= 0) {
        body.push(lines[j].slice(0, at));
        return { latex: body.join('\n'), next: j + 1 };
      }
      body.push(lines[j]);
    }
    return { latex: body.join('\n'), next: lines.length, open: true };
  }
  m = MATH_ENV.exec(line);
  if (m) {
    const end = `\\end{${m[1]}}`;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j].includes(end)) return { latex: lines.slice(i, j + 1).join('\n'), next: j + 1 };
    }
    return { latex: lines.slice(i).join('\n'), next: lines.length, open: true };
  }
  return null;
}

function mathBlock(found, streaming) {
  if (found.open && streaming) return '<div class="math-block is-pending" aria-hidden="true"><span></span><span></span><span></span></div>';
  return `<div class="math-block">${mathHtml(found.latex, { display: true })}</div>`;
}

function parseTable(lines, i, citations) {
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const head = cells(lines[i]);
  const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
  const body = [];
  let j = i + 2;
  while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
    body.push(cells(lines[j]));
    j += 1;
  }
  const td = (tag, c, k) => `<${tag}${align[k] ? ` class="al-${align[k]}"` : ''}>${inline(c, citations)}</${tag}>`;
  const html = `<div class="table-wrap"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`;
  return { html, next: j };
}

function parseList(lines, start, opts) {
  const first = itemOf(lines[start]);
  const base = first.indent;
  const items = [];
  let i = start;
  const sibling = (m) => m && Math.abs(m.indent - base) < 2 && m.ordered === first.ordered;

  while (i < lines.length) {
    const line = lines[i];
    const m = itemOf(line);
    if (sibling(m)) {
      items.push({ text: m.text, blocks: [] });
      i += 1;
    } else if (m && m.indent >= base + 2 && items.length) {
      const nested = parseList(lines, i, opts);
      items[items.length - 1].blocks.push(nested.html);
      i = nested.next;
    } else if (m) {
      break;
    } else if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const upcoming = j < lines.length ? itemOf(lines[j]) : null;
      const indented = j < lines.length && /^\s{2,}\S/.test(lines[j]);
      if (upcoming && (sibling(upcoming) || upcoming.indent >= base + 2) && items.length) i = j;
      else if (indented && !upcoming && items.length && (mathBlockAt(lines, j) || isFence(lines[j]))) i = j;
      else break;
    } else if (items.length) {
      const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
      const math = mathBlockAt(lines, i);
      if (math && indent > base) {
        items[items.length - 1].blocks.push(mathBlock(math, opts.streaming));
        i = math.next;
      } else if (math) {
        // A formula between numbered steps stays inside the list when the steps carry on after it.
        let j = math.next;
        while (j < lines.length && !lines[j].trim()) j += 1;
        const after = j < lines.length ? itemOf(lines[j]) : null;
        if (!sibling(after)) break;
        items[items.length - 1].blocks.push(mathBlock(math, opts.streaming));
        i = j;
      } else if (indent > base && isFence(line)) {
        const code = [];
        let j = i + 1;
        for (; j < lines.length && !isFence(lines[j]); j += 1) code.push(lines[j]);
        items[items.length - 1].blocks.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
        i = j + 1;
      } else if (indent > base) {
        items[items.length - 1].text += ` ${line.trim()}`;
        i += 1;
      } else break;
    } else break;
  }
  const tag = first.ordered ? 'ol' : 'ul';
  const startAttr = first.ordered && first.number > 1 ? ` start="${first.number}"` : '';
  return {
    html: `<${tag}${startAttr}>${items.map((it) => `<li>${inline(it.text, opts.citations)}${it.blocks.join('')}</li>`).join('')}</${tag}>`,
    next: i,
  };
}

function blocks(lines, opts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
    } else if (isFence(line)) {
      const lang = /^\s*```\s*([\w+#-]+)/.exec(line)?.[1] || '';
      const code = [];
      i += 1;
      for (; i < lines.length && !isFence(lines[i]); i += 1) code.push(lines[i]);
      i += 1;
      out.push(`<pre${lang ? ` data-lang="${escape(lang)}"` : ''}><code>${escape(code.join('\n'))}</code></pre>`);
    } else if (mathBlockAt(lines, i)) {
      const found = mathBlockAt(lines, i);
      out.push(mathBlock(found, opts.streaming));
      i = found.next;
    } else if (isHeading(line)) {
      const m = /^\s{0,3}(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
      out.push(`<h${m[1].length <= 2 ? 3 : 4}>${inline(m[2], opts.citations)}</h${m[1].length <= 2 ? 3 : 4}>`);
      i += 1;
    } else if (isRule(line)) {
      out.push('<hr>');
      i += 1;
    } else if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const table = parseTable(lines, i, opts.citations);
      out.push(table.html);
      i = table.next;
    } else if (isQuote(line)) {
      const inner = [];
      for (; i < lines.length && isQuote(lines[i]); i += 1) inner.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
      const body = blocks(inner, opts).join('');
      out.push(`<blockquote${/^<p><strong>/.test(body) ? ' class="callout"' : ''}>${body}</blockquote>`);
    } else if (itemOf(line)) {
      const list = parseList(lines, i, opts);
      out.push(list.html);
      i = list.next;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isHeading(lines[i]) && !isQuote(lines[i]) && !itemOf(lines[i]) && !isRule(lines[i]) && !mathBlockAt(lines, i)
        && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])); i += 1) para.push(lines[i].trim());
      if (!para.length) {
        para.push(lines[i].trim());
        i += 1;
      }
      out.push(`<p>${inline(para.join(' '), opts.citations)}</p>`);
    }
  }
  return out;
}

export function markdown(source, { citations, streaming = false } = {}) {
  const text = String(source || '')
    .replace(/\r/g, '')
    .replace(/^\s*(?:\[(?:visual|action):[^\n]*\]\s*)+/i, ''); // a cue that slipped through is never shown
  return raw(blocks(text.split('\n'), { citations, streaming }).join(''));
}
