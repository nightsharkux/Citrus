/**
 * A date picker in the Citrus look, in place of the browser's own calendar (which cannot be styled), for every
 * <input type="date"> and <input type="datetime-local">. The input stays in its form with the same value
 * (YYYY-MM-DD, YYYY-MM-DDTHH:MM), so pages read it exactly as before; a button shows the date in words and opens
 * a calendar: month by month, today ringed, quick picks (Today, Tomorrow, Next Monday), a time with common times
 * for datetime-local, min and max respected, and all of it by keyboard (arrows, Page Up/Down, Home/End, Esc).
 * On a phone it opens from the bottom like the other sheets. Add data-native to an input to keep the browser's.
 *
 *   watchDates(document.body)   picks up date inputs as pages and sheets draw them (main.js)
 *   monthGrid(year, month)      the 42 days a month shows, weeks from Monday
 */
import { html, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { getLanguage } from '../core/i18n.js';
import { session } from '../core/store.js';
import { periodStarts, nextPeriodStart } from './slot-times.js';

const SELECTOR = 'input[type="date"]:not([data-native]), input[type="datetime-local"]:not([data-native])';
const TIMES = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'];

/** Quick times: the start of each teaching period when the university has them (the edition's timetable), else round hours. */
export function quickTimes(site = session.site) {
  const periods = periodStarts(site);
  return periods.length ? periods : TIMES;
}

const pad = (n) => String(n).padStart(2, '0');
export const dayIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (iso, n) => {
  const d = fromIso(iso);
  d.setDate(d.getDate() + n);
  return dayIso(d);
};

/** The 42 days shown for a month (0–11): six weeks from the Monday on or before the 1st. */
export function monthGrid(year, month) {
  const back = (new Date(year, month, 1).getDay() + 6) % 7; // days since Monday
  return Array.from({ length: 42 }, (_, i) => dayIso(new Date(year, month, 1 - back + i)));
}

/** "2026-11-19T10:00" → { day: '2026-11-19', time: '10:00' }; anything else → empty. */
export function splitValue(value) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(value || ''));
  return m ? { day: m[1], time: m[2] || '' } : { day: '', time: '' };
}

/** The Monday after this day (a week on when it is a Monday). */
export const nextMonday = (iso) => addDays(iso, (8 - fromIso(iso).getDay()) % 7 || 7);

const locale = () => (getLanguage() === 'de' ? 'de-DE' : navigator.language?.startsWith('en') ? navigator.language : 'en-GB');
const format = (iso, options) => new Intl.DateTimeFormat(locale(), options).format(fromIso(iso));
const monthName = (y, m) => new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(new Date(y, m, 1));
const weekdays = () => monthGrid(2026, 10).slice(0, 7).map((iso) => format(iso, { weekday: 'short' }).replace(/\.$/, '').slice(0, 2));

/** "Wed, 19 Nov · 10:00", with the year when it is not this one. */
function label(day, time) {
  const sameYear = day.slice(0, 4) === String(new Date().getFullYear());
  const date = format(day, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  return time ? `${date} · ${time}` : date;
}

/** For a new date and time: the next teaching period that has not started (else the first), or without periods the next full hour in the working day, else 9:00. */
function defaultTime(now = new Date()) {
  const period = nextPeriodStart(session.site, now);
  if (period) return period;
  const next = now.getHours() + 1;
  return next >= 7 && next <= 20 ? `${pad(next)}:00` : '09:00';
}

// ---- the calendar ----------------------------------------------------------------------------------------------

let current = null; // one open at a time

function openPicker({ trigger, withTime, required, min, max, value, onPick }) {
  current?.close();
  const today = dayIso(new Date());
  const allowed = (iso) => (!min || iso >= min) && (!max || iso <= max);
  let { day: selected, time } = splitValue(value);
  time = time || defaultTime();
  let focus = selected || (allowed(today) ? today : min || max || today);
  let view = fromIso(focus);

  const backdrop = document.createElement('div');
  backdrop.className = 'date-pop-backdrop';
  const pop = document.createElement('div');
  pop.className = 'date-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', withTime ? 'Choose a date and time' : 'Choose a date');
  document.body.append(backdrop, pop);
  trigger.setAttribute('aria-expanded', 'true');

  const quick = [['Today', today], ['Tomorrow', addDays(today, 1)], ['Next Monday', nextMonday(today)]];
  function draw(focusDay = false) {
    const y = view.getFullYear();
    const m = view.getMonth();
    const days = monthGrid(y, m);
    render(pop, html`
      <div class="date-pop-head">
        <button type="button" class="btn btn-icon btn-ghost btn-sm" data-step="-1" aria-label="Previous month">${icon('chevron-left', 18)}</button>
        <strong class="date-pop-month" aria-live="polite">${monthName(y, m)}</strong>
        <button type="button" class="btn btn-icon btn-ghost btn-sm" data-step="1" aria-label="Next month">${icon('chevron-right', 18)}</button>
      </div>
      <div class="date-pop-quick">${quick.map(([name, iso]) => html`<button type="button" class="chip-button ${iso === selected ? 'is-on' : ''}" data-pick="${iso}" ${allowed(iso) ? '' : 'disabled'}>${name}</button>`)}</div>
      <div class="date-grid" role="grid">
        ${weekdays().map((w) => html`<span class="date-dow" aria-hidden="true">${w}</span>`)}
        ${days.map((iso) => html`<button type="button" class="date-day ${Number(iso.slice(5, 7)) - 1 !== m ? 'is-other' : ''} ${iso === today ? 'is-today' : ''}" data-pick="${iso}" data-day tabindex="${iso === focus ? 0 : -1}" aria-label="${format(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}" aria-pressed="${String(iso === selected)}" ${allowed(iso) ? '' : 'disabled'}>${Number(iso.slice(8))}</button>`)}
      </div>
      ${withTime ? html`<div class="date-pop-time">
        <label class="date-time-field"><span>${icon('clock', 15)} Time</span><input class="input" type="time" step="300" value="${time}" data-time data-native></label>
        <div class="date-time-chips">${quickTimes().map((t) => html`<button type="button" class="chip-button ${t === time ? 'is-on' : ''}" data-time-pick="${t}">${t}</button>`)}</div>
      </div>` : ''}
      <div class="date-pop-foot">
        ${required ? html`<span></span>` : html`<button type="button" class="btn btn-sm btn-ghost" data-clear>Clear</button>`}
        <button type="button" class="btn btn-sm ${withTime ? 'btn-primary' : 'btn-ghost'}" data-done>${withTime ? 'Done' : 'Close'}</button>
      </div>`);
    if (focusDay) pop.querySelector('[data-day][tabindex="0"]')?.focus();
    place();
  }

  const commit = () => onPick(selected ? (withTime ? `${selected}T${time}` : selected) : '');
  const show = (iso, focusDay) => {
    focus = iso;
    if (fromIso(iso).getMonth() !== view.getMonth() || fromIso(iso).getFullYear() !== view.getFullYear()) view = fromIso(iso);
    draw(focusDay);
  };

  function place() {
    if (innerWidth < 560) {
      pop.classList.add('is-sheet');
      pop.style.left = pop.style.top = '';
      return;
    }
    pop.classList.remove('is-sheet');
    const r = trigger.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = pop;
    const below = innerHeight - r.bottom - 12 >= h || r.top < h + 12;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    pop.style.top = `${Math.max(8, below ? Math.min(r.bottom + 6, innerHeight - h - 8) : r.top - h - 6)}px`;
    pop.style.transformOrigin = below ? 'top left' : 'bottom left';
  }

  pop.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    const pick = e.target.closest('[data-pick]');
    const timePick = e.target.closest('[data-time-pick]');
    if (step) {
      view = new Date(view.getFullYear(), view.getMonth() + Number(step.dataset.step), 1);
      const day = Math.min(fromIso(focus).getDate(), new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate());
      focus = dayIso(new Date(view.getFullYear(), view.getMonth(), day));
      draw();
    } else if (pick && !pick.disabled) {
      selected = pick.dataset.pick;
      commit();
      if (withTime) show(selected, !!pick.dataset.day);
      else close(true);
    } else if (timePick) {
      time = timePick.dataset.timePick;
      selected = selected || (allowed(focus) ? focus : '');
      commit();
      draw();
    } else if (e.target.closest('[data-clear]')) {
      selected = '';
      commit();
      close(true);
    } else if (e.target.closest('[data-done]')) {
      close(true);
    }
  });
  pop.addEventListener('input', (e) => {
    if (!e.target.matches('[data-time]') || !/^\d{2}:\d{2}/.test(e.target.value)) return;
    time = e.target.value.slice(0, 5);
    selected = selected || (allowed(focus) ? focus : '');
    commit();
    pop.querySelectorAll('[data-time-pick]').forEach((b) => b.classList.toggle('is-on', b.dataset.timePick === time));
    pop.querySelectorAll('[data-day]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pick === selected)));
  });
  const MOVES = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // not the sheet underneath
      close(true);
      return;
    }
    if (!e.target.matches('[data-day]')) return;
    const d = fromIso(focus);
    let next = null;
    if (MOVES[e.key]) next = addDays(focus, MOVES[e.key]);
    else if (e.key === 'Home') next = addDays(focus, -((d.getDay() + 6) % 7));
    else if (e.key === 'End') next = addDays(focus, 6 - ((d.getDay() + 6) % 7));
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const t = new Date(d.getFullYear(), d.getMonth() + (e.key === 'PageUp' ? -1 : 1), 1);
      next = dayIso(new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate())));
    }
    if (!next) return;
    e.preventDefault();
    show(next, true);
  });

  const outside = (e) => {
    if (!pop.contains(e.target) && !trigger.contains(e.target)) close(false);
  };
  const reflow = () => (trigger.isConnected ? place() : close(false));
  document.addEventListener('pointerdown', outside, true);
  addEventListener('resize', reflow);
  addEventListener('scroll', reflow, true);

  function close(refocus) {
    if (current?.pop !== pop) return;
    current = null;
    pop.remove();
    backdrop.remove();
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    removeEventListener('resize', reflow);
    removeEventListener('scroll', reflow, true);
    if (refocus && trigger.isConnected) trigger.focus();
  }

  current = { pop, trigger, close };
  draw(true);
}

// ---- the field -------------------------------------------------------------------------------------------------

function enhance(input) {
  if (input.dataset.picker) return;
  input.dataset.picker = '1';
  const withTime = input.type === 'datetime-local';
  const required = input.required;
  const min = splitValue(input.min).day;
  const max = splitValue(input.max).day;
  input.type = 'hidden'; // keeps its value and name: the form reads it as before

  const wrap = document.createElement('span');
  wrap.className = 'date-field-wrap';
  input.after(wrap);
  render(wrap, html`<button type="button" class="input date-field" aria-haspopup="dialog" aria-expanded="false">${icon('calendar', 17)}<span class="date-field-text"></span></button>${required ? '' : html`<button type="button" class="date-field-clear" aria-label="Clear the date" hidden>${icon('x', 14)}</button>`}`);
  const trigger = wrap.querySelector('.date-field');
  const text = wrap.querySelector('.date-field-text');
  const clear = wrap.querySelector('.date-field-clear');

  const refresh = () => {
    const { day, time } = splitValue(input.value);
    text.textContent = day ? label(day, withTime ? time : '') : withTime ? 'Pick a date and time' : 'Pick a date';
    text.classList.toggle('is-empty', !day);
    if (clear) clear.hidden = !day;
    trigger.classList.remove('is-invalid');
  };
  // Pages that set the value themselves still see it on the button.
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => native.get.call(input),
    set: (v) => {
      native.set.call(input, v);
      refresh();
    },
  });
  const set = (v) => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  trigger.addEventListener('click', () => {
    if (current?.trigger === trigger) current.close(true); // a second tap closes it
    else openPicker({ trigger, withTime, required, min, max, value: input.value, onPick: set });
  });
  clear?.addEventListener('click', () => {
    set('');
    trigger.focus();
  });
  // A hidden input is not checked by the browser: a required date is checked here, before the page's own handler.
  input.form?.addEventListener('submit', (e) => {
    if (!required || input.value) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    trigger.classList.add('is-invalid');
    trigger.click();
  }, true);
  input.form?.addEventListener('reset', () => setTimeout(refresh));
  refresh();
}

/** Enhance the date inputs inside `root` now and whenever new ones appear. */
export function watchDates(root = document.body) {
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches(SELECTOR)) enhance(node);
    node.querySelectorAll(SELECTOR).forEach(enhance);
  };
  scan(root);
  new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(scan);
    if (current && !current.trigger.isConnected) current.close(false); // its page went away
  }).observe(root, { childList: true, subtree: true });
}
