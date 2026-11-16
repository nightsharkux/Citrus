/**
 * My tools (/apps): tools Campus made for you from a description, and shared tools you added from More tools.
 * Making one takes a sentence; you then pick how it looks (pages/app.js).
 */
import { html, on, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { pageHead, empty } from '../core/components.js';
import { toastError } from '../core/ui.js';
import { dictate } from '../features/voice.js';

const IDEAS = ['A big clock for the projector', 'A countdown to my exam', 'A random group picker for a class list', 'A timer for 25-minute study blocks', 'A unit converter for physics'];
const SHARE_LABEL = { private: 'Only you', pending: 'Waiting for review', public: 'Shared', rejected: 'Not approved' };

export const toolCard = (t) => html`<a class="card tight tool-card" href="/apps/${t.id}">
  <span class="tile accent">${icon(t.icon || 'layers', 20)}</span>
  <strong>${t.name}</strong>
  <span class="small muted">${t.description}</span>
  <span class="small faint">${t.mine ? SHARE_LABEL[t.visibility] : `By ${t.maker || 'someone at your university'}`}</span>
</a>`;

export default {
  title: 'My tools',
  async load() {
    return api.get('/apps');
  },
  render(d) {
    const all = [...d.mine, ...d.added];
    return html`${pageHead({ title: 'My tools', subtitle: 'Describe a small tool and Campus makes it in the Citrus look. It stays yours unless you share it.', actions: html`<a class="btn" href="/apps/gallery">${icon('layers', 17)} More tools</a>` })}
      <div class="stack stagger" style="max-width:980px">
        <section class="card stack make-tool">
          <div><h2>Make a tool</h2><p class="small muted">Say what it should do. Campus writes it, then you choose how it looks. Tools run on their own: they can’t see your account or reach the internet.</p></div>
          ${d.aiEnabled ? html`<form class="stack" data-make style="--gap:10px">
            <div class="composer"><textarea name="idea" rows="2" maxlength="800" placeholder="A big clock for the projector that also shows the date" aria-label="What should the tool do?"></textarea>
              <div class="composer-actions"><button type="button" class="btn btn-ghost btn-icon" data-say aria-label="Say it">${icon('mic', 18)}</button><button class="btn btn-primary" data-go>${icon('sparkle', 16)} Make it</button></div></div>
            <div class="flag-kinds">${IDEAS.map((idea) => html`<button type="button" class="chip outline" data-idea="${idea}">${idea}</button>`)}</div>
            <p class="small muted" data-making hidden><span class="typing"><i></i><i></i><i></i></span> Campus is making your tool. This can take up to a minute.</p>
          </form>` : html`<div class="notice warning">${icon('info', 18)}<span>Tools are made by the AI, which is not connected yet.</span></div>`}
        </section>
        ${all.length ? html`<div class="grid-auto" style="--min:220px">${all.map(toolCard)}</div>`
          : html`<div class="card">${empty({ icon: 'layers', title: 'No tools yet', body: 'Make one above, or add one someone shared under More tools.', action: html`<a class="btn btn-sm" href="/apps/gallery">More tools</a>` })}</div>`}
      </div>`;
  },
  mount(root, d, ctx) {
    const form = $('[data-make]', root);
    if (!form) return undefined;
    const offs = [
      on(root, 'click', '[data-idea]', (e, b) => {
        form.idea.value = b.dataset.idea;
        form.idea.focus();
      }),
      on(root, 'click', '[data-say]', (e, b) => {
        b.classList.add('is-active');
        dictate({ onInterim: (t) => (form.idea.value = t), onFinal: (t) => (form.idea.value = t), onEnd: () => b.classList.remove('is-active') });
      }),
      on(root, 'submit', '[data-make]', async (e) => {
        e.preventDefault();
        const idea = form.idea.value.trim();
        if (idea.length < 5) return;
        const go = $('[data-go]', root);
        go.disabled = true;
        $('[data-making]', root).hidden = false;
        try {
          const r = await api.post('/apps', { idea });
          ctx.navigate(`/apps/${r.tool.id}?new=1`);
        } catch (error) {
          go.disabled = false;
          $('[data-making]', root).hidden = true;
          toastError(error);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  },
};
