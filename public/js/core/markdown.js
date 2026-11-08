/**
 * Safe Markdown subset for assistant answers: paragraphs, headings, lists,
 * blockquotes, fenced code, inline code, bold, italic, links and [n]
 * citations. Everything is escaped first; only known patterns become tags.
 */
import { escape, raw } from './dom.js';

function inline(text, citations) {
  const codes = [];
  let out = escape(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  if (citations?.size) {
    out = out.replace(/\[(\d{1,2})\]/g, (m, n) => (citations.has(Number(n)) ? `<a class="cite" href="#" data-cite="${n}">${n}</a>` : m));
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

export function markdown(source, { citations } = {}) {
  const lines = String(source || '').replace(/\r/g, '').split('\n');
  const html = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '), citations)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i, citations)}</li>`).join('')}</${list.type}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^```/.exec(line.trim());
    if (fence) {
      flushPara();
      flushList();
      const code = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i].trim()); i += 1) code.push(lines[i]);
      html.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      html.push(`<h4>${inline(heading[2], citations)}</h4>`);
    } else if (bullet || numbered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet || numbered)[1]);
    } else if (quote) {
      flushPara();
      flushList();
      html.push(`<blockquote>${inline(quote[1], citations)}</blockquote>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return raw(html.join(''));
}
