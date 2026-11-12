/**
 * Join a live lecture with the six-digit code on the lecturer's screen (/join, or /join/123456 from the projector).
 * Joining also joins the course, so a student needs nothing else.
 */
import { html } from '../core/dom.js';
import { pageHead } from '../core/components.js';
import { api } from '../core/api.js';
import { joinForm, mountJoinForm } from './live.js';

export default {
  title: 'Join a lecture',
  async load(ctx) {
    const code = String(ctx.params.code || '').replace(/\D/g, '').slice(0, 6);
    // A code in the link: join straight away. A wrong or old code falls back to the form.
    if (code.length === 6) {
      try {
        const r = await api.post('/live/join', { code });
        return { go: `/live/${r.course_id}` };
      } catch (error) {
        return { code, error: error.message };
      }
    }
    return { code: '' };
  },
  render(d) {
    if (d.go) return html``;
    return html`${pageHead({ title: 'Join a lecture', subtitle: 'Type the six-digit code your lecturer shows on the screen.' })}
      <section class="card stack" style="max-width:520px">
        ${d.error ? html`<div class="notice warning">${d.error}</div>` : ''}
        ${joinForm({ code: d.code, autofocus: true })}
        <p class="small muted">You join the course as well, so the lecture and its recap appear in Lectures from now on.</p>
      </section>`;
  },
  mount(root, d, ctx) {
    if (d.go) {
      ctx.navigate(d.go, { replace: true });
      return undefined;
    }
    return mountJoinForm(root, ctx.navigate);
  },
};
