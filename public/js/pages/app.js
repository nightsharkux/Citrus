/**
 * One tool (/apps/:id), filling the screen, with the island at the bottom: back, full screen, look, and for its
 * maker: change it (typed or spoken), share it, delete it. A new tool opens with the look picker: four previews of
 * the same tool in the four looks, side by side.
 *
 * The tool runs in a sandboxed frame from /api/apps/:id/frame (its own origin, no network, no storage).
 */
import { html, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { sheet, confirm, toast, toastError, busy } from '../core/ui.js';
import { createIsland } from '../features/island.js';
import { dictate } from '../features/voice.js';

const LOOK_NAMES = { glass: 'Glass', bold: 'Bold', minimal: 'Minimal', night: 'Night (projector)' };
const frameUrl = (t, look) => `/api/apps/${t.id}/frame?look=${look || t.look}&v=${encodeURIComponent(t.updated)}`;

export default {
  title: (d) => d.tool.name,
  layout: 'full',
  async load(ctx) {
    return api.get(`/apps/${ctx.params.id}`);
  },
  render(d) {
    return html`<div class="app-run" data-run>
      <iframe class="app-frame" data-frame sandbox="allow-scripts" title="${d.tool.name}" src="${frameUrl(d.tool)}"></iframe>
    </div>`;
  },
  mount(root, d, ctx) {
    let tool = d.tool;
    const run = $('[data-run]', root);
    const frame = $('[data-frame]', root);
    const reload = (look) => {
      frame.src = frameUrl(tool, look);
    };

    function lookPicker() {
      sheet({
        title: 'Choose a look',
        wide: true,
        content: html`<p class="small muted">The same tool in each look. Pick the one you like; you can change it any time.</p>
          <div class="look-grid">${d.looks.map((look) => html`<button class="look-option ${look === tool.look ? 'is-current' : ''}" data-look="${look}">
            <span class="look-preview"><iframe sandbox="allow-scripts" tabindex="-1" title="${LOOK_NAMES[look]}" src="${frameUrl(tool, look)}"></iframe></span>
            <strong>${LOOK_NAMES[look]}</strong></button>`)}</div>
          ${tool.mine ? html`<label class="field mt-16"><span>Name</span><input class="input" data-name maxlength="32" value="${tool.name}"></label>` : ''}`,
        onMount(el, close) {
          el.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-look]');
            if (!b) return;
            if (!tool.mine) {
              reload(b.dataset.look);
              close();
              return;
            }
            try {
              const name = $('[data-name]', el)?.value.trim();
              tool = (await api.patch(`/apps/${tool.id}`, { look: b.dataset.look, ...(name ? { name } : {}) })).tool;
              reload();
              ctx.setTitle(tool.name);
              close();
            } catch (error) {
              toastError(error);
            }
          });
        },
      });
    }

    function changeSheet() {
      sheet({
        title: `Change ${tool.name}`,
        content: html`<form class="form" id="change-form">
          <p class="small muted">Say or type what should be different. Citrus rewrites the tool and keeps the rest.</p>
          <div class="composer"><textarea name="change" rows="3" maxlength="800" placeholder="Make the numbers bigger and add a start button" required minlength="3"></textarea>
            <div class="composer-actions"><button type="button" class="btn btn-ghost btn-icon" data-say aria-label="Say it">${icon('mic', 18)}</button></div></div>
          <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">${icon('sparkle', 16)} Change it</button></div>
        </form>`,
        onMount(el, close) {
          const form = $('#change-form', el);
          el.querySelector('[data-say]').addEventListener('click', (e) => {
            const b = e.currentTarget;
            b.classList.add('is-active');
            dictate({ onInterim: (t) => (form.change.value = t), onFinal: (t) => (form.change.value = t), onEnd: () => b.classList.remove('is-active') });
          });
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            busy(form.querySelector('.btn-primary'), async () => {
              try {
                tool = (await api.post(`/apps/${tool.id}/change`, { change: form.change.value.trim() })).tool;
                reload();
                close();
                toast(tool.visibility === 'pending' ? 'Changed. It goes back to review before others see the new version.' : 'Changed', 'success');
              } catch (error) {
                toastError(error);
              }
            });
          });
        },
      });
    }

    async function share() {
      if (tool.visibility === 'public' || tool.visibility === 'pending') {
        if (!(await confirm({ title: 'Stop sharing?', message: 'It disappears from More tools. People who added it lose it.', confirmLabel: 'Stop sharing' }))) return;
        tool = (await api.post(`/apps/${tool.id}/private`)).tool;
        toast('Only you can see it now', 'info');
        return;
      }
      if (!(await confirm({ title: 'Share this tool?', message: 'An administrator checks it first. Then everyone at your university can add it from More tools, with your name on it.', confirmLabel: 'Share' }))) return;
      tool = (await api.post(`/apps/${tool.id}/share`)).tool;
      toast(tool.visibility === 'public' ? 'Shared in More tools' : 'Sent for review. You’ll see it in More tools once it is approved.', 'success', { duration: 4200 });
    }

    const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : run.requestFullscreen?.()).catch?.(() => {});
    const items = [
      { id: 'back', icon: 'arrow-left', label: 'Back to My tools', onSelect: () => ctx.navigate('/apps') },
      { id: 'full', icon: 'maximize', label: 'Full screen', onSelect: toggleFull },
      { id: 'look', icon: 'eye', label: 'Look', onSelect: lookPicker },
      ...(tool.mine ? [
        'divider',
        { id: 'change', icon: 'sparkle', label: 'Change it', onSelect: changeSheet },
        { id: 'share', icon: 'users', label: 'Share or stop sharing', onSelect: () => share().catch(toastError) },
        { id: 'delete', icon: 'trash', label: 'Delete', onSelect: async () => {
          if (!(await confirm({ title: `Delete ${tool.name}?`, message: 'This can’t be undone.', confirmLabel: 'Delete', danger: true }))) return;
          await api.del(`/apps/${tool.id}`).then(() => ctx.navigate('/apps'), toastError);
        } },
      ] : [
        'divider',
        { id: 'add', icon: tool.added ? 'check-circle' : 'plus', label: tool.added ? 'In My tools' : 'Add to My tools', onSelect: async () => {
          if (tool.added) return;
          tool = (await api.post(`/apps/${tool.id}/add`).catch(toastError))?.tool || tool;
          island.setItem('add', { icon: 'check-circle', label: 'In My tools' });
        } },
      ]),
    ];
    const island = createIsland({ items, label: 'Tool controls', status: html`<span>${tool.name}</span>` });
    run.append(island.el);
    const onFull = () => island.setItem('full', { icon: document.fullscreenElement ? 'minimize' : 'maximize', label: document.fullscreenElement ? 'Leave full screen' : 'Full screen' });
    document.addEventListener('fullscreenchange', onFull);

    if (ctx.query.get('new')) {
      history.replaceState({}, '', `/apps/${tool.id}`);
      setTimeout(lookPicker, 300);
    }
    return () => {
      document.removeEventListener('fullscreenchange', onFull);
      if (document.fullscreenElement === run) document.exitFullscreen?.().catch(() => {});
      island.destroy();
    };
  },
};

