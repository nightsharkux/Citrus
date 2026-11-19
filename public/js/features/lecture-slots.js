/**
 * Ready-made lecture times, so a lecturer picks a slot instead of typing a time.
 *
 * The university's teaching day is a few fixed periods (the edition's `teachingPeriods`, taken from the printed
 * timetable) and three sessions made of them (`teachingSessions`): morning, afternoon, evening. A row of buttons
 * under "Date and time" sets the start and the length in one tap; the date stays as it is (today or tomorrow when
 * none is chosen yet). An edition without periods shows nothing and the form works as before.
 *
 *   slotPicker()           the buttons, as markup for a form that has a `starts` and a `duration_minutes` field
 *   mountSlots(form)       makes the buttons work
 *   slotsOf(site)          { sessions, periods } of the edition, each with its length in minutes (slot-times.js)
 */
import { html } from '../core/dom.js';
import { session } from '../core/store.js';
import { slotsOf, dayFor, lengthLabel } from './slot-times.js';

export { slotsOf, slotLength, dayFor, lengthLabel } from './slot-times.js';

/** The edition's sessions and periods (see slot-times.js). */
const slots = () => slotsOf(session.site);

const clock = (slot) => `${slot.from}–${slot.to}`;

export function slotPicker() {
  const { sessions, periods } = slots();
  if (!sessions.length && !periods.length) return '';
  const button = (slot, label) => html`<button type="button" class="chip-button" data-slot-from="${slot.from}" data-slot-minutes="${slot.minutes}" title="${clock(slot)}">${label}</button>`;
  return html`<div class="field slot-picker" data-slots>
    <span>Time slot</span>
    ${sessions.length ? html`<div class="slot-chips" role="group" aria-label="Sessions of the day">${sessions.map((s) => button(s, `${s.name} ${clock(s)}`))}</div>` : ''}
    ${periods.length ? html`<div class="slot-chips" role="group" aria-label="Single periods">${periods.map((p) => button(p, `Period ${p.n} · ${p.from}`))}</div>` : ''}
    <span class="hint">Sets the start and the length. Change either one afterwards if this lecture is different.</span>
  </div>`;
}

export function mountSlots(form) {
  const box = form?.querySelector('[data-slots]');
  if (!box) return () => {};
  const starts = form.elements.starts;
  const length = form.elements.duration_minutes;

  const mark = () => {
    const at = String(starts.value || '').slice(11, 16);
    for (const b of box.querySelectorAll('[data-slot-from]')) b.classList.toggle('is-on', b.dataset.slotFrom === at && Number(b.dataset.slotMinutes) === Number(length.value));
  };
  const onClick = (e) => {
    const b = e.target.closest('[data-slot-from]');
    if (!b) return;
    const from = b.dataset.slotFrom;
    const minutes = Number(b.dataset.slotMinutes);
    const day = String(starts.value || '').slice(0, 10) || dayFor({ from });
    starts.value = `${day}T${from}`; // the date field shows it at once
    starts.dispatchEvent(new Event('input', { bubbles: true }));
    starts.dispatchEvent(new Event('change', { bubbles: true }));
    // The lengths in the list are round ones; a slot like 8:15–11:30 adds its own.
    if (![...length.options].some((o) => Number(o.value) === minutes)) {
      const option = Object.assign(document.createElement('option'), { value: String(minutes), textContent: lengthLabel(minutes) });
      const after = [...length.options].find((o) => Number(o.value) > minutes);
      length.insertBefore(option, after || null);
    }
    length.value = String(minutes);
    mark();
  };
  box.addEventListener('click', onClick);
  starts.addEventListener('change', mark);
  length.addEventListener('change', mark);
  return () => {
    box.removeEventListener('click', onClick);
    starts.removeEventListener('change', mark);
    length.removeEventListener('change', mark);
  };
}
