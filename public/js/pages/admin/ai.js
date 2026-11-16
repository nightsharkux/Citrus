/** Admin · AI & knowledge: configure the gateway and curate citable sources. */
import { html, render, $, $$, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import { setSession, session } from '../../core/store.js';
import { pageHead, empty } from '../../core/components.js';
import { ago, plural, humanize } from '../../core/format.js';
import { sheet, onSubmit, confirm, toast, toastError, busy } from '../../core/ui.js';

const PROVIDER_INFO = {
  off: ['x', 'Off', 'No AI. Minutes use a simple text extractor.'],
  gateway: ['globe', 'Cloud · Vercel AI Gateway', 'Needs AI_GATEWAY_API_KEY in the server’s .env.'],
};

export default {
  title: 'AI & knowledge',
  roles: ['admin'],
  async load() {
    const [settings, knowledge] = await Promise.all([api.get('/ai/settings'), api.get('/knowledge')]);
    return { settings, ...knowledge };
  },
  render(d) {
    const s = d.settings;
    const categories = [...new Set(d.knowledge.map((k) => k.category || 'General'))];
    return html`
      ${pageHead({ title: 'AI & knowledge', subtitle: 'Pick where AI runs, and decide which sources the assistant is allowed to cite.' })}
      <div class="stack stagger">
        <section class="card">
          <div class="spread"><h2>AI provider</h2><span class="chip ${s.aiEnabled ? 'info' : 'warning'}"><span class="dot"></span>${s.aiEnabled ? `Configured · ${s.model}` : 'Not active'}</span></div>
          ${s.summaryModel ? html`<p class="small muted mt-16">Default model: ${s.model}. Summary model: ${s.summaryModel}.${s.searchModel ? ` Lookups (web, files, university documents): ${s.searchModel}.` : ''}</p>` : ''}
          <form id="provider-form" class="mt-16">
            <div class="choice-grid two">${s.providers.map((p) => {
              const [glyph, label, desc] = PROVIDER_INFO[p.id] || ['cpu', p.label, ''];
              return html`<label class="choice provider-choice"><input type="radio" name="provider" value="${p.id}" ${s.provider === p.id ? 'checked' : ''}>
                <span class="tile sm ${p.ready ? '' : 'neutral'}">${icon(glyph, 16)}</span>
                <span class="grow"><strong style="display:block">${label}</strong><span class="small muted">${p.missing || (p.model ? `Model: ${p.model}` : desc)}</span></span>
                ${p.id !== 'off' && !p.ready ? html`<span class="chip warning">Needs key</span>` : ''}
              </label>`;
            })}</div>
            <label class="field mt-16"><span>Assistant model</span><select class="select" name="model">
              <option value="" ${!s.modelOverride ? 'selected' : ''}>Use deployment default</option>
              ${(s.modelChoices || []).map((m) => html`<option value="${m.id}" ${s.modelOverride === m.id ? 'selected' : ''}>${m.label}</option>`)}
            </select><span class="hint">Sol handles complex questions. Astra offers deeper reasoning with higher cost and latency. Summaries keep their separate model; voice conversations use shorter reasoning.</span></label>
            <div class="form-actions mt-16"><span class="small muted grow" id="test-result">Uploaded audio transcription is in development.</span><button type="button" class="btn" data-test ${s.aiEnabled ? '' : 'disabled'}>${icon('bolt', 16)} Test connection</button><button class="btn btn-primary">Save</button></div>
          </form>
        </section>

        <section class="card">
          <h2>Tools</h2>
          <div class="stack mt-16" style="--gap:18px">
            <label class="spread"><span><strong>Web search</strong><br><span class="small muted">The assistant can look things up on the web when your knowledge library and its own knowledge are not enough, and links the pages it used. Students can also ask it to search. Searches go to Perplexity through the AI Gateway (about $5 per 1,000 searches).${s.webSearchAllowed && s.aiEnabled && !s.webSearch ? html` <span style="color:var(--warning)">The gateway refused the last search, so it is paused for a few minutes.</span>` : ''}</span></span>
              <span class="switch"><input type="checkbox" data-tool="web_search" ${s.webSearchAllowed ? 'checked' : ''} ${s.aiEnabled ? '' : 'disabled'} aria-label="Web search"><span></span></span></label>
            <label class="spread"><span><strong>Natural voices</strong><br><span class="small muted">Answers are read aloud by the AI Gateway’s speech model${s.speechModel ? html` (${s.speechModel})` : ''} instead of the browser’s voices. Set the model with CAMPUS_AI_SPEECH_MODEL. Text to speech is in beta on the gateway; until it is enabled for your team, browsers use their own voices.${s.speechAllowed && s.aiEnabled && !s.speech ? html` <span style="color:var(--warning)">Not available right now, so browsers use their own voices.</span>` : ''}</span></span>
              <span class="switch"><input type="checkbox" data-tool="speech" ${s.speechAllowed ? 'checked' : ''} ${s.aiEnabled ? '' : 'disabled'} aria-label="Natural voices"><span></span></span></label>
          </div>
        </section>

        <section class="card flush">
          <div class="card-head" style="flex-wrap:wrap">
            <div><h2>Knowledge library</h2><p class="small muted">${plural(d.knowledge.length, 'entry', 'entries')} · the assistant cites these as numbered sources</p></div>
            <div class="cluster">
              ${d.pack ? html`<button class="btn btn-sm" data-pack>${icon('download', 15)} Import ${session.site.id === 'oth' ? 'OTH public pack' : 'bundled pack'}</button>` : ''}
              <a class="btn btn-sm btn-primary" href="/library">${icon('upload', 15)} Upload documents</a>
              <button class="btn btn-sm" data-import>${icon('file', 15)} Import library file</button>
              <button class="btn btn-sm btn-primary" data-add>${icon('plus', 15)} Add entry</button>
            </div>
          </div>
          ${d.knowledge.length ? html`
            <div style="padding:0 20px 8px"><div class="search-input">${icon('search', 16)}<input class="input" data-q placeholder="Filter entries" style="height:38px;min-height:38px"></div></div>
            ${categories.map((cat) => html`<div data-cat-group><h4 class="section-title" style="padding:12px 20px 0">${cat}</h4><div class="list">${d.knowledge.filter((k) => (k.category || 'General') === cat).map((k) => html`
              <button class="list-row no-icon" data-entry="${k.id}" data-text="${`${k.title} ${k.content}`.toLowerCase()}">
                <span class="body"><span class="title">${k.title}</span><span class="sub">${k.content}</span></span>
                <span class="trail">${k.volatility !== 'stable' ? html`<span class="chip warning">${humanize(k.volatility)}</span>` : ''}${k.source_url ? icon('link', 15) : ''}<span class="small hide-sm">${ago(k.updated)}</span></span>
              </button>`)}</div></div>`)}
            <div style="height:10px"></div>`
            : empty({ icon: 'library', title: 'The library is empty', body: 'Add official information — opening hours, exam rules, contacts — and the assistant will cite it.', action: d.pack ? html`<button class="btn btn-primary" data-pack>Import the bundled public pack</button>` : '' })}
        </section>
        <p class="small faint">Only add information your university has approved. Entries marked “dynamic” or “term-specific” tell users to confirm on the live source.</p>
      </div>`;
  },
  mount(root, d, ctx) {
    onSubmit($('#provider-form', root), async (v) => {
      const s = await api.patch('/ai/settings', { provider: v.provider, model: v.model });
      setSession({ ai: s });
      ctx.refresh();
      return s.aiEnabled ? `Using ${s.label}` : s.description;
    });
    const offs = [
      on(root, 'change', '[data-tool]', async (e) => {
        const input = e.target;
        try {
          const s = await api.patch('/ai/settings', { [input.dataset.tool]: input.checked });
          setSession({ ai: s });
          toast(input.dataset.tool === 'speech' ? (input.checked ? 'Natural voices on' : 'Natural voices off') : input.checked ? 'Web search on' : 'Web search off', 'success');
        } catch (error) {
          input.checked = !input.checked;
          toastError(error);
        }
      }),
      on(root, 'click', '[data-test]', (e, b) => busy(b, async () => {
        try {
          const r = await api.post('/ai/test');
          render($('#test-result', root), html`<span style="color:var(--success)">${icon('check-circle', 14)} Connected to ${r.label} (${r.model}) in ${r.latencyMs} ms</span>`);
        } catch (error) {
          render($('#test-result', root), html`<span style="color:var(--danger)">${error.message}</span>`);
        }
      })),
      on(root, 'input', '[data-q]', (e) => {
        const q = e.target.value.trim().toLowerCase();
        $$('[data-entry]', root).forEach((el) => el.classList.toggle('hidden', !el.dataset.text.includes(q)));
        $$('[data-cat-group]', root).forEach((g) => g.classList.toggle('hidden', !g.querySelector('[data-entry]:not(.hidden)')));
      }),
      on(root, 'click', '[data-pack]', (e, b) => busy(b, async () => {
        try {
          const r = await api.post('/knowledge/import-pack');
          toast(`${r.added} added, ${r.updated} updated`, 'success');
          ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      })),
      on(root, 'click', '[data-add]', () => entrySheet(null, ctx)),
      on(root, 'click', '[data-entry]', (e, b) => entrySheet(d.knowledge.find((k) => k.id === Number(b.dataset.entry)), ctx)),
      on(root, 'click', '[data-import]', () => importSheet(ctx)),
    ];
    return () => offs.forEach((off) => off());
  },
};

function entrySheet(k, ctx) {
  sheet({
    title: k ? 'Edit entry' : 'New entry',
    wide: true,
    content: html`<form class="form" id="entry-form">
      <label class="field"><span>Title</span><input class="input" name="title" value="${k?.title || ''}" required minlength="3" maxlength="120" placeholder="Library opening hours" autofocus></label>
      <div class="input-row">
        <label class="field"><span>Category</span><input class="input" name="category" value="${k?.category || ''}" placeholder="Services"></label>
        <label class="field"><span>Freshness</span><select class="select" name="volatility">${['stable', 'term-specific', 'dynamic'].map((v) => html`<option value="${v}" ${(k?.volatility || 'stable') === v ? 'selected' : ''}>${humanize(v)}</option>`)}</select></label>
      </div>
      <label class="field"><span>Official source link</span><input class="input" name="source_url" type="url" value="${k?.source_url || ''}" placeholder="https://"></label>
      <label class="field"><span>Content</span><textarea class="textarea" name="content" required minlength="5" maxlength="7000" style="min-height:180px">${k?.content || ''}</textarea></label>
      <div class="form-actions">${k ? html`<button type="button" class="btn btn-danger" data-delete style="margin-right:auto">Delete</button>` : ''}<button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Save</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#entry-form', el), async (v) => {
        if (k) await api.patch(`/knowledge/${k.id}`, v);
        else await api.post('/knowledge', v);
        close();
        ctx.refresh();
        return 'Saved';
      });
      el.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await confirm({ title: 'Delete this entry?', message: 'The assistant will no longer cite it.', confirmLabel: 'Delete', danger: true }))) return;
        await api.del(`/knowledge/${k.id}`).catch(toastError);
        close();
        ctx.refresh();
      });
    },
  });
}

function importSheet(ctx) {
  sheet({
    title: 'Import knowledge',
    content: html`<form class="form" id="import-form">
      <p class="small muted">Upload <b>.jsonl</b> (one record per line with title, content, category, sources, volatility) or a <b>.txt / .md</b> file — Markdown headings become separate entries. Re-importing JSONL updates matching IDs.</p>
      <p class="small muted">Have PDFs, scans, photos or slides instead? Use <a href="/library">Documents</a>: Citrus reads them for you, pictures too.</p>
      <label class="field"><span>File</span><input class="input" type="file" name="file" accept=".jsonl,.json,.txt,.md,text/plain,text/markdown" required></label>
      <label class="field"><span>Title (for text files)</span><input class="input" name="title" placeholder="Examination regulations summary"></label>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary">Import</button></div>
    </form>`,
    onMount(el, close) {
      onSubmit($('#import-form', el), async (v, form) => {
        const file = form.file.files[0];
        if (!file) throw new Error('Choose a file');
        const content = await file.text();
        const jsonl = /\.jsonl?$/i.test(file.name);
        const r = await api.post('/knowledge/import', { format: jsonl ? 'jsonl' : 'text', content, title: v.title || file.name.replace(/\.[^.]+$/, '') });
        close();
        ctx.refresh();
        return `${r.added} added, ${r.updated} updated`;
      });
    },
  });
}
