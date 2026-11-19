'use strict';
/**
 * Builds the OTH Amberg-Weiden website knowledge pack (resources/OTH_Website_Knowledge.jsonl)
 * from the university's public pages, German and English.
 *
 *   node scripts/crawl-oth.js [--delay 800] [--limit 50] [--out resources/OTH_Website_Knowledge.jsonl]
 *
 * Rules it follows:
 *   - robots.txt of www.oth-aw.de is read and its "*" rules are applied.
 *   - The staff directory (/hochschule/ueber-uns/personen/) is skipped even though only AI
 *     crawlers are asked to stay out of it: the university has said it does not want it
 *     collected by AI tools. Contact details come from the pages that publish them.
 *   - One request at a time with a pause between requests; 429/5xx are retried with backoff.
 *   - Raw pages are cached in storage/oth-crawl/ (git-ignored), so a re-run only fetches what is new.
 *
 * Node built-ins only, like the rest of the project.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const HOST = 'https://www.oth-aw.de';
const UA = 'Citrus-OTH-pack/1.0 (student project, private; https://github.com/nightsharkux/CampusOS_One)';
const CACHE = path.join(ROOT, 'storage', 'oth-crawl');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DELAY = Number(flag('delay', 800));
const LIMIT = Number(flag('limit', 0));
const OUT = path.resolve(ROOT, flag('out', 'resources/OTH_Website_Knowledge.jsonl'));
const TODAY = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Never collected, whatever robots.txt says. */
const SKIP_PATHS = [/^\/(?:en\/)?sitemap\//, /^\/myoth\//, /^\/hochschule\/ueber-uns\/personen\//, /^\/en\/university\/about-our-university\/people\//];

async function get(url, { text = true } = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 3000 * 2 ** attempt;
        await sleep(Math.min(wait, 60_000));
        continue;
      }
      if (!res.ok) return { status: res.status, body: '' };
      const type = res.headers.get('content-type') || '';
      return { status: 200, type, url: res.url, body: text ? await res.text() : Buffer.from(await res.arrayBuffer()) };
    } catch {
      await sleep(2000 * (attempt + 1));
    }
  }
  return { status: 0, body: '' };
}

// ---------------------------------------------------------------- robots.txt

function parseRobots(content) {
  const rules = [];
  let applies = false;
  let seenRule = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (seenRule) {
        applies = false;
        seenRule = false;
      }
      if (m[2].trim() === '*') applies = true;
    } else if ((key === 'disallow' || key === 'allow') && applies) {
      seenRule = true;
      if (m[2]) rules.push({ allow: key === 'allow', pattern: m[2] });
    } else if (key === 'disallow' || key === 'allow') seenRule = true;
  }
  return rules.map((r) => {
    const source = r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
    return { allow: r.allow, re: new RegExp(`^${source.replace(/\\\?/g, '\\?')}`), length: r.pattern.length };
  });
}

function allowed(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) if (r.re.test(pathAndQuery) && (!best || r.length > best.length || (r.length === best.length && r.allow))) best = r;
  return !best || best.allow;
}

// ---------------------------------------------------------------- HTML to text

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', euro: '€', shy: '', copy: '©', middot: '·', bull: '•' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-zA-Z]+);/g, (m, n) => ENTITIES[n] ?? m);

/** Typo3 hides e-mail addresses behind a small script: javascript:linkTo_UnCryptMailto('encoded'). Decoded here. */
function unCrypt(encoded) {
  try {
    return decodeURIComponent(encoded).split('').map((c) => {
      const n = c.charCodeAt(0);
      const shift = (code, start, end, offset) => (code >= start && code <= end ? ((code - start + offset + (end - start + 1)) % (end - start + 1)) + start : null);
      return String.fromCharCode(shift(n, 43, 58, -1) ?? shift(n, 64, 90, -1) ?? shift(n, 97, 122, -1) ?? n);
    }).join('').replace(/^mailto:/, '');
  } catch {
    return '';
  }
}

function between(html, tag) {
  const start = html.search(new RegExp(`<${tag}[\\s>]`, 'i'));
  if (start < 0) return '';
  const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
  return html.slice(start, end > start ? end : undefined);
}

function strip(html, tag) {
  return html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
}

function breadcrumb(html) {
  const m = /<nav[^>]*class="[^"]*breadcrumb[^"]*"[\s\S]*?<\/nav>/i.exec(html);
  if (!m) return '';
  const text = decode(m[0].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.replace(/^(?:Sie sind hier|You are here)\s*:?\s*/i, '').trim();
}

function alternateEnglish(html) {
  const m = /<link[^>]+rel="alternate"[^>]+hreflang="en[^"]*"[^>]+href="([^"]+)"/i.exec(html) || /<link[^>]+hreflang="en[^"]*"[^>]+href="([^"]+)"/i.exec(html);
  return m ? decode(m[1]) : null;
}

function mainText(html) {
  let main = between(html, 'main') || html;
  for (const tag of ['script', 'style', 'noscript', 'svg', 'form', 'nav', 'aside', 'button', 'select', 'iframe', 'template']) main = strip(main, tag);
  main = main.replace(/<!--[\s\S]*?-->/g, ' ');
  // Hidden accessibility helpers and cookie / share widgets.
  main = main.replace(/<(div|span|p)\b[^>]*class="[^"]*(?:sr-only|visually-hidden|cookie|share|socialmedia|skip)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  main = main.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
    const label = decode(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const href = /href="([^"]*)"/i.exec(attrs)?.[1] || '';
    const crypt = /UnCryptMailto\('([^']+)'/.exec(href)?.[1];
    if (crypt) {
      const address = unCrypt(crypt);
      return ` ${label && !label.includes('@') ? `${label} ` : ''}(E-mail: ${address || label}) `;
    }
    if (/^mailto:/i.test(href)) return ` ${label && !label.includes('@') ? `${label} ` : ''}(E-mail: ${decode(href.slice(7)).split('?')[0]}) `;
    if (/^tel:/i.test(href)) return ` ${label || decode(href.slice(4))} `;
    const abs = href.startsWith('/') ? `${HOST}${href}` : href;
    if (/^https?:/i.test(abs) && label && (/\.(pdf|docx?|xlsx?|pptx?|zip)(\?|$)/i.test(abs) || !abs.startsWith(HOST))) return ` ${label} (${abs}) `;
    return ` ${label} `;
  });

  main = main
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => `\n\n${'#'.repeat(Math.min(4, Number(n)))} ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|ul|ol|table|tr|dl|dt|dd|figure|figcaption|address|blockquote)>/gi, '\n')
    .replace(/<(?:p|div|section|article|tr|dt|dd|address|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<img\b[^>]*alt="([^"]{12,})"[^>]*>/gi, (_, alt) => ` [Image: ${alt}] `)
    .replace(/<[^>]+>/g, ' ');

  return decode(main)
    // The site writes addresses as "name @ oth-aw . de" to hide them from simple harvesters; put them back together.
    .replace(/([\w.+-]+)\s+@\s+([\w-]+(?:\s*\.\s*[\w-]+)+)/g, (_, user, domain) => `${user}@${domain.replace(/\s+/g, '')}`)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- records

const TOP = {
  studium: 'Studies', hochschule: 'University', forschung: 'Research', international: 'International', weiterbildung: 'Continuing education',
  datenschutzerklaerungen: 'Legal', en: null,
};
const TOP_EN = { studies: 'Studies', university: 'University', research: 'Research', international: 'International', 'continuing-education': 'Continuing education', 'further-education': 'Continuing education', myoth: 'MyOTH' };

function describe(url) {
  const p = new URL(url).pathname;
  const parts = p.split('/').filter(Boolean);
  const english = parts[0] === 'en';
  const segments = english ? parts.slice(1) : parts;
  const top = english ? TOP_EN[segments[0]] || 'Website' : TOP[segments[0]] || 'Professors and groups';
  const second = (segments[1] || '').replace(/-/g, ' ');
  const category = `Website | ${top}${second ? ` | ${second}` : ''}`.slice(0, 80);
  let volatility = 'stable';
  if (/veranstaltung|events?|aktuelles|news|stellenangebot|jobs|termine|pruefungs|vorlesungs|semester|stundenplan|timetable|schedule|dates|bewerbung|application/.test(p)) volatility = 'term-specific';
  if (/veranstaltungen|events\/|news|aktuelles\/(?:news|karriere)|stellenangebote/.test(p)) volatility = 'dynamic';
  return { category, volatility, language: english ? 'en' : 'de', segments };
}

function pieces(text, limit = 6200) {
  if (text.length <= limit) return [text];
  const out = [];
  let current = '';
  for (const block of text.split(/\n(?=#{1,4} )|\n\n/)) {
    if (current && current.length + block.length + 2 > limit) {
      out.push(current.trim());
      current = '';
    }
    if (block.length > limit) {
      for (let i = 0; i < block.length; i += limit) out.push(block.slice(i, i + limit).trim());
    } else current += `${block}\n\n`;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function repeats(pathname) {
  // Content-management glitches produce paths where a whole run of segments is repeated.
  const parts = pathname.split('/').filter(Boolean);
  for (let n = 2; n <= Math.floor(parts.length / 2); n += 1) {
    for (let i = 0; i + 2 * n <= parts.length; i += 1) {
      if (parts.slice(i, i + n).join('/') === parts.slice(i + n, i + 2 * n).join('/')) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- main

async function sitemapUrls() {
  const index = await get(`${HOST}/sitemap.xml`);
  const maps = [...index.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1])).filter((u) => /sitemap=pages/.test(u));
  const urls = new Set();
  for (const map of maps) {
    const res = await get(map);
    for (const m of res.body.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(decode(m[1]));
    await sleep(DELAY);
  }
  return [...urls];
}

async function main() {
  fs.mkdirSync(path.join(CACHE, 'html'), { recursive: true });
  const robots = parseRobots((await get(`${HOST}/robots.txt`)).body);
  const ok = (u) => {
    const url = new URL(u);
    if (url.host !== new URL(HOST).host) return false;
    if (SKIP_PATHS.some((re) => re.test(url.pathname))) return false;
    if (repeats(url.pathname)) return false;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|docx?|xlsx?|pptx?|mp4|mp3)$/i.test(url.pathname)) return false;
    return allowed(robots, url.pathname + url.search);
  };

  const queue = (await sitemapUrls()).filter(ok);
  const seen = new Set(queue.map((u) => u.replace(/#.*$/, '')));
  console.log(`${queue.length} pages from the sitemap`);

  const records = [];
  const lines = new Set();
  let done = 0;
  const started = Date.now();
  while (queue.length && (!LIMIT || done < LIMIT)) {
    const url = queue.shift();
    const file = path.join(CACHE, 'html', `${hash(url)}.html`);
    let html;
    if (fs.existsSync(file)) html = fs.readFileSync(file, 'utf8');
    else {
      const res = await get(url);
      await sleep(DELAY);
      if (res.status !== 200 || !/html/i.test(res.type || 'html')) continue;
      html = res.body;
      fs.writeFileSync(file, html);
    }
    done += 1;
    if (done % 50 === 0) console.log(`${done} done, ${queue.length} left, ${Math.round((Date.now() - started) / 60000)} min`);

    const english = alternateEnglish(html);
    if (english && !seen.has(english) && ok(english)) {
      seen.add(english);
      queue.push(english);
    }

    const title = decode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(between(html, 'main') || html)?.[1] || /<title>([^<]*)/i.exec(html)?.[1] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/\s*[|–-]\s*OTH Amberg-Weiden.*$/i, '').trim();
    const body = mainText(html);
    if (!title || body.length < 80) continue;
    const info = describe(url);
    const trail = breadcrumb(html);
    records.push({ url, title, trail, body, ...info });
    for (const line of new Set(body.split('\n'))) if (line.length > 20) lines.add(line);
  }

  // Lines that appear on many pages are page furniture (cookie notes, footers), not content.
  const counts = new Map();
  for (const r of records) for (const line of new Set(r.body.split('\n'))) if (line.length > 20) counts.set(line, (counts.get(line) || 0) + 1);
  const furniture = new Set([...counts].filter(([, n]) => n > Math.max(25, records.length * 0.04)).map(([line]) => line));

  const seenContent = new Set();
  const out = [];
  for (const r of records) {
    const body = r.body.split('\n').filter((l) => !furniture.has(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body.length < 80) continue;
    const key = hash(body);
    if (seenContent.has(key)) continue;
    seenContent.add(key);
    const head = `${r.title}${r.trail ? `\nSection: ${r.trail}` : ''}`;
    const parts = pieces(body);
    parts.forEach((part, i) => {
      out.push({
        id: `OTH-WEB-${hash(r.url)}${parts.length > 1 ? `-${i + 1}` : ''}`,
        institution: 'OTH Amberg-Weiden',
        category: r.category,
        title: `${r.title}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ''}`.slice(0, 118),
        content: `${head}\n\n${part}`.slice(0, 6900),
        sources: [{ id: 'web', url: r.url }],
        tags: [r.language, 'website', ...r.segments.slice(0, 3).map((s) => s.replace(/-/g, ' '))],
        observed_on: TODAY,
        volatility: r.volatility,
        access: 'public',
        notes: '',
      });
    });
  }

  fs.writeFileSync(OUT, `${out.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const size = fs.statSync(OUT).size;
  console.log(`Wrote ${out.length} records from ${records.length} pages to ${path.relative(ROOT, OUT)} (${(size / 1e6).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
