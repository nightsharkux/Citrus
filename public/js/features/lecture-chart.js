/**
 * The lecture at a glance (review page): one bar per minute, stacked green (following), amber (unsure) and red
 * (lost), as tall as the number of students who answered; the parts of the lecture (P1, P2, …) as coloured bands
 * on top, coloured by how the class followed them; flags and struggles as markers at their exact second.
 *
 * A student's chart is only theirs: one bar per minute for how they said they were following (short green, medium
 * amber, tall red), the parts they should work on in red, their own flags. It is drawn from their own answers only;
 * a student's record carries no class numbers at all.
 *
 * Every minute and every part is a button (data-minute, data-section), so the page can open the exact moments.
 */
import { escape } from '../core/dom.js';

export const COLORS = { following: '#1f9d55', unsure: '#e0a100', lost: '#d93b3b', quiet: '#9aa3ad', flag: '#7a4fd8' };
const BAND = { good: COLORS.following, watch: COLORS.unsure, trouble: COLORS.lost, quiet: COLORS.quiet };
const LEVEL = { 1: COLORS.following, 2: COLORS.unsure, 3: COLORS.lost };
const WORD = { 1: 'following', 2: 'unsure', 3: 'lost' };

export const mmss = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

const FLAG_WORDS = { confused: 'didn’t get this', fast: 'too fast', example: 'needs an example', question: 'a question', long: 'explanation too long', boring: 'boring' };

export function lectureChart(record, { student = false } = {}) {
  const minutes = record.minutes || [];
  const n = Math.max(1, minutes.length);
  const W = 720;
  const left = 30;
  const right = 8;
  const top = 42;
  const plotH = 140;
  const youTop = top + plotH + 10;
  const youH = 0;
  const markTop = top + plotH + 10;
  const H = markTop + 34;
  const plotW = W - left - right;
  const bw = plotW / n;
  const gap = Math.min(1.5, bw * 0.12);
  const max = student ? 3 : Math.max(1, ...minutes.map((m) => m.answered || 0));
  const y = (v) => top + plotH - (v / max) * plotH;
  const dur = Math.max(60, record.meta.durationSec || n * 60);
  const xt = (t) => left + (Math.min(dur, Math.max(0, t)) / dur) * plotW;
  const out = [];
  out.push(`<svg class="lecture-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${student ? 'How you followed, minute by minute' : 'How the class followed, minute by minute'}" xmlns="http://www.w3.org/2000/svg">`);

  // Parts of the lecture: bands on top, coloured by how the class followed them.
  for (const sec of record.sections || []) {
    const x1 = xt(sec.from);
    const w = Math.max(4, xt(sec.to) - x1 - 2);
    const color = student ? (sec.target ? COLORS.lost : COLORS.quiet) : BAND[sec.status] || COLORS.quiet;
    const summary = student ? (sec.target ? 'work on this part' : 'followed') : sec.understood === null ? 'too few answers' : `${sec.understood}% understood`;
    const room = Math.floor((w - 10) / 6.4);
    const label = room >= 3 ? `${sec.id}${room > 8 ? ` · ${sec.title}` : ''}` : '';
    const text = label.length > room ? `${label.slice(0, Math.max(2, room - 1))}…` : label;
    out.push(`<g class="lc-band" data-section="${sec.id}" tabindex="0" role="button" aria-label="${escape(`${sec.id}: ${sec.title}, ${summary}`)}">`
      + `<title>${escape(`${sec.id} · ${sec.clock} · ${sec.title}\n${summary}${sec.flags ? ` · ${sec.flags} flags` : ''}`)}</title>`
      + `<rect x="${x1.toFixed(1)}" y="4" width="${w.toFixed(1)}" height="26" rx="7" fill="${color}" fill-opacity="0.16"/>`
      + `<rect x="${x1.toFixed(1)}" y="27" width="${w.toFixed(1)}" height="3" rx="1.5" fill="${color}"/>`
      + (text ? `<text x="${(x1 + 7).toFixed(1)}" y="21" class="lc-band-text">${escape(text)}</text>` : '')
      + '</g>');
  }

  // Grid and counts.
  for (const v of (student ? [] : [...new Set([0, Math.round(max / 2), max])])) {
    out.push(`<line x1="${left}" x2="${W - right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="lc-grid"/><text x="${left - 6}" y="${(y(v) + 4).toFixed(1)}" class="lc-axis" text-anchor="end">${v}</text>`);
  }

  // One bar per minute.
  minutes.forEach((m, i) => {
    const x = left + i * bw;
    const parts = [];
    let base = 0;
    if (student) {
      const level = m.you || 0;
      const width = Math.max(0.8, bw - gap * 2).toFixed(1);
      if (level) parts.push(`<rect x="${(x + gap).toFixed(1)}" y="${y(level).toFixed(1)}" width="${width}" height="${(y(0) - y(level)).toFixed(1)}" fill="${LEVEL[level]}" rx="1.5"/>`);
      else parts.push(`<rect x="${(x + gap).toFixed(1)}" y="${(top + plotH - 2).toFixed(1)}" width="${width}" height="2" fill="${COLORS.quiet}" fill-opacity="0.5"/>`);
    }
    for (const k of (student ? [] : ['following', 'unsure', 'lost'])) {
      const v = m[k] || 0;
      if (!v) continue;
      const y1 = y(base + v);
      parts.push(`<rect x="${(x + gap).toFixed(1)}" y="${y1.toFixed(1)}" width="${Math.max(0.8, bw - gap * 2).toFixed(1)}" height="${(y(base) - y1).toFixed(1)}" fill="${COLORS[k]}" rx="1.5"/>`);
      base += v;
    }
    if (!student && !m.answered) parts.push(`<rect x="${(x + gap).toFixed(1)}" y="${(top + plotH - 2).toFixed(1)}" width="${Math.max(0.8, bw - gap * 2).toFixed(1)}" height="2" fill="${COLORS.quiet}" fill-opacity="0.5"/>`);
    const tip = student ? `Minute ${m.minute} · ${m.section}\n${m.you ? `You said ${WORD[m.you]}` : 'No answer from you'}` : m.answered
      ? `Minute ${m.minute} · ${m.section}\n${m.following || 0} following · ${m.unsure || 0} unsure · ${m.lost || 0} lost\n${m.understood}% understood`
      : `Minute ${m.minute} · ${m.section}\nNo answers`;
    out.push(`<g class="lc-min" data-minute="${m.minute}" role="button" tabindex="-1" aria-label="${escape(tip.replace(/\n/g, ', '))}"><title>${escape(tip)}</title>`
      + `<rect class="lc-hit" x="${x.toFixed(1)}" y="${top}" width="${bw.toFixed(1)}" height="${plotH + youH + 12}" fill="transparent"/>${parts.join('')}</g>`);
  });

  // Flags and struggles at their exact second.
  for (const e of record.events || []) {
    if (e.kind === 'flag') {
      const x = xt(e.t);
      out.push(`<path d="M${x.toFixed(1)} ${markTop} l5 9 h-10 z" fill="${COLORS.flag}" class="lc-mark"><title>${escape(`${mmss(e.t)} · ${e.section} · flag: ${FLAG_WORDS[e.flag] || e.flag}${e.note ? ` “${e.note}”` : ''}${e.who ? ` (${e.who})` : ''}`)}</title></path>`);
    } else if (e.kind === 'struggle') {
      const x = xt(e.t);
      out.push(`<circle cx="${x.toFixed(1)}" cy="${markTop + 5}" r="4.5" fill="${COLORS.lost}" class="lc-mark"><title>${escape(`${mmss(e.t)} · ${e.section} · ${student ? 'a hard moment' : 'the class got lost'}${e.note ? `: ${e.note}` : ''}`)}</title></circle>`);
    }
  }

  // Time along the bottom.
  const step = dur > 5400 ? 15 : dur > 2700 ? 10 : 5;
  for (let t = 0; t <= dur; t += step * 60) out.push(`<text x="${xt(t).toFixed(1)}" y="${H - 6}" class="lc-axis" text-anchor="${t === 0 ? 'start' : dur - t < step * 30 ? 'end' : 'middle'}">${Math.round(t / 60)} min</text>`);
  out.push('</svg>');
  return out.join('');
}

/** What happened in one stretch of the lecture, for the moment list. */
export const eventsBetween = (record, from, to) => (record.events || []).filter((e) => e.t >= from && e.t < to);

export function eventText(e) {
  switch (e.kind) {
    case 'say': return { icon: 'mic', text: e.text, tone: '' };
    case 'class': return { icon: 'users', text: `${e.following} following · ${e.unsure} unsure · ${e.lost} lost (${e.understood ?? '–'}% understood)`, tone: e.status === 'trouble' ? 'danger' : e.status === 'watch' ? 'warning' : '' };
    case 'answer': return { icon: 'user', text: `${e.who}: ${WORD[e.level]}`, tone: e.level === 3 ? 'danger' : e.level === 2 ? 'warning' : '' };
    case 'you': return { icon: 'user', text: `You said ${WORD[e.level]}`, tone: e.level === 3 ? 'danger' : e.level === 2 ? 'warning' : '' };
    case 'flag': return { icon: 'flag', text: `${e.who ? `${e.who} · ` : ''}${FLAG_WORDS[e.flag] || e.flag}${e.note ? `: “${e.note}”` : ''}`, tone: 'flag' };
    case 'struggle': return { icon: 'alert', text: e.answered === undefined || e.answered === null ? `A hard moment${e.note ? `: ${e.note}` : ''}` : `The class got lost (${e.lost} of ${e.answered})${e.note ? `: ${e.note}` : ''}`, tone: 'danger' };
    case 'point': return { icon: 'bulb', text: `Key point: ${e.text}`, tone: 'accent' };
    case 'gap': return { icon: 'mic-off', text: `Nothing captured until ${mmss(e.to)}`, tone: 'muted' };
    default: return { icon: 'info', text: '', tone: '' };
  }
}
