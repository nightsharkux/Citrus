import { html, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { session } from '../core/store.js';
import { createFace } from '../features/face.js';

export default {
  public: true,
  title: '',
  layout: 'full',
  render() {
    return html`
      <section class="landing">
        <div class="stagger">
          <span class="chip accent"><span class="dot"></span>${session.site.tagline || 'Your university'}</span>
          <h1 style="margin-top:18px">Your whole campus.<br><em>One calm place.</em></h1>
          <p class="lede">Lectures, schedule, study groups and campus life — with Campus, an assistant that actually knows your courses. Just say “Hey Campus”.</p>
          <div class="cta">
            <a class="btn btn-primary btn-lg" href="/login">Sign in ${icon('arrow-right', 18)}</a>
            ${session.registration ? html`<a class="btn btn-lg" href="/register">Create an account</a>` : ''}
          </div>
          <div class="feature-strip">
            <span class="chip outline">${icon('calendar', 14)} Schedule</span>
            <span class="chip outline">${icon('graduation', 14)} Spaced review</span>
            <span class="chip outline">${icon('grid', 14)} Study spaces</span>
            <span class="chip outline">${icon('compass', 14)} Campus life</span>
          </div>
          ${session.site.conceptNotice ? html`<p class="fineprint">${session.site.conceptNotice}</p>` : ''}
        </div>
        <div class="preview" aria-hidden="true">
          <div class="phone">
            <div class="phone-screen">
              <div><div class="p-greet">Good morning</div><div class="p-big">2 lectures</div><div class="p-greet">Next: 10:15 · Room MF2</div></div>
              <div class="p-actions"><div><i>${icon('campus', 16)}</i>Ask</div><div><i>${icon('clipboard', 16)}</i>Check in</div><div><i>${icon('graduation', 16)}</i>Review</div><div><i>${icon('grid', 16)}</i>Spaces</div></div>
              <div class="phone-card">
                <small>Up next</small>
                <div class="phone-row"><i></i><div><b>Algorithms & Data Structures</b><span>10:15 – 11:45 · MF2</span></div></div>
                <div class="phone-row"><i></i><div><b>Project team sync</b><span>13:00 · Study space</span></div></div>
                <div class="phone-row"><i></i><div><b>Statistics review</b><span>4 cards due</span></div></div>
              </div>
            </div>
          </div>
          <div class="float-card card a"><span class="tile sm success">${icon('check', 16)}</span>Checked in · MF2</div>
          <div class="float-card card b"><span data-landing-face></span><span>“Hey Campus, explain Big-O”</span></div>
        </div>
      </section>`;
  },
  mount(root) {
    const slot = $('[data-landing-face]', root);
    if (!slot) return undefined;
    const face = createFace({ size: 40 });
    slot.replaceWith(face.el);
    const greet = setTimeout(() => face.react('happy', 1500), 1200);
    return () => {
      clearTimeout(greet);
      face.destroy();
    };
  },
};
