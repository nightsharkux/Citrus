'use strict';
/**
 * The minutes read like a message from a good team lead: warm, organised by topic, with a schedule table and a
 * to-do list of checkboxes. The voice is free, the facts are not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../src/ai/prompts');

test('the minutes prompt asks for the team-lead style and keeps the accuracy rules', () => {
  const p = prompts.meetingPrompt('OTH Cares Team Meeting', { date: '2026-11-27', author: 'Mduduzi' });
  assert.match(p, /meeting secretary/, 'still the same role (the tests of the meeting flow recognise it)');
  assert.match(p, /OTH Cares Team Meeting — Minutes/, 'a title line');
  assert.match(p, /2026-11-27/, 'dated');
  assert.match(p, /Mduduzi/, 'and signed with who ran it');
  assert.match(p, /table with the columns what \| when \| who/, 'dates and owners in a table');
  assert.match(p, /- \[ \] Name: what, by when/, 'a checkbox to-do list');
  assert.match(p, /Ideas we are still exploring/, 'open ideas are kept apart from decisions');
  assert.match(p, /Never invent decisions/, 'creative with the voice, never with the facts');
  assert.match(p, /unconfirmed/);
  assert.match(p, /language of the meeting/);
  // The date and author are optional.
  assert.doesNotMatch(prompts.meetingPrompt('Standup'), /undefined/);
});

test('"- [ ] task" renders as a to-do box, "- [x]" as a ticked one, and ordinary bullets are unchanged', async () => {
  const { markdown } = await import('../public/js/core/markdown.js');
  const html = String(markdown('- [ ] Alvis: send the flyers\n- [x] Adi: book the room\n- a plain bullet').value ?? markdown('- [ ] x'));
  assert.match(html, /<li class="task"><span class="task-box" aria-hidden="true"><\/span>Alvis: send the flyers<\/li>/);
  assert.match(html, /<li class="task is-done"><span class="task-box" aria-hidden="true"><\/span>Adi: book the room<\/li>/);
  assert.match(html, /<li>a plain bullet<\/li>/);
  assert.doesNotMatch(html, /\[ \]|\[x\]/, 'the markers are not shown as text');
});
