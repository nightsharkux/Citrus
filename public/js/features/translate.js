/** Explicit translations keep the original page/answer intact. No actions are parsed or executed. */
import { html, render } from '../core/dom.js';
import { api } from '../core/api.js';
import { sheet } from '../core/ui.js';
import { markdown } from '../core/markdown.js';

export function showTranslation({ text, messageId, target = 'de' }) {
  sheet({
    title: target === 'de' ? 'Deutsche Übersetzung' : 'English translation',
    content: html`<div data-translation role="status">Translating…</div>`,
    async onMount(root) {
      const output = root.querySelector('[data-translation]');
      try {
        // Chunks stay below the API's bound; never silently discard the rest of a page.
        const parts = messageId ? [null] : String(text || '').match(/[\s\S]{1,12000}/g) || [];
        if (!parts.length) throw new Error('No text to translate');
        const translated = [];
        for (const part of parts) {
          if (!root.isConnected) return;
          const result = await api.post('/assistant/translate', messageId ? { message_id: messageId, target } : { text: part, target });
          translated.push(result.text);
          if (root.isConnected) render(output, html`<div class="prose" lang="${target}" data-no-translate>${markdown(translated.join('\n\n'))}</div>`);
        }
      } catch (error) {
        if (root.isConnected) render(output, html`<p>${error.message}</p>`);
      }
    },
  });
}
