'use strict';
/** The island's place: where it starts, that it never leaves the screen, and what a device remembers about it. */
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../public/js/features/island.js');
const store = (initial) => {
  const data = new Map(initial ? [['citrus.island', initial]] : []);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), data };
};

test('it starts at the bottom centre of a wide screen and at the right edge of a phone', async () => {
  const { anchorFor } = await load();
  const wide = anchorFor({}, { w: 1280, h: 800 }, false);
  assert.equal(wide.x, 640);
  assert.ok(wide.y > 800 - 90 && wide.y < 800 - 30, `bottom: ${wide.y}`);
  const phone = anchorFor({}, { w: 390, h: 844 }, true);
  assert.ok(phone.x > 390 - 60, `right edge: ${phone.x}`);
  assert.equal(Math.round(phone.y / 844 * 100), 62);
});

test('a saved place is used, and kept on the screen when the screen got smaller', async () => {
  const { anchorFor } = await load();
  assert.deepEqual(anchorFor({ fx: 0.25, fy: 0.5 }, { w: 1000, h: 600 }, false), { x: 250, y: 300 });
  const small = anchorFor({ fx: 0.99, fy: 0.99 }, { w: 400, h: 300 }, false);
  assert.ok(small.x <= 400 - 32 && small.y <= 300 - 32, 'inside, with a margin');
  const corner = anchorFor({ fx: 0, fy: 0 }, { w: 400, h: 300 }, false);
  assert.ok(corner.x >= 32 && corner.y >= 32, 'not under the edge either');
  assert.ok(Number.isFinite(anchorFor({ fx: 0.5, fy: 0.5 }, { w: 10, h: 10 }, false).x), 'even in a tiny box');
});

test('place, direction and fade are remembered; broken or blocked storage is not a problem', async () => {
  const { loadPlace, savePlace } = await load();
  const s = store();
  savePlace({ fx: 0.2, fy: 0.7, vertical: true, fade: true }, s);
  assert.deepEqual(loadPlace(s), { fx: 0.2, fy: 0.7, vertical: true, fade: true });

  assert.deepEqual(loadPlace(store('{"fx": 7, "fy": -3, "vertical": "yes", "fade": "no"}')), { fx: 1, fy: 0, vertical: undefined, fade: false }, 'values are clamped and checked');
  assert.deepEqual(loadPlace(store('not json')), { fade: false });
  assert.deepEqual(loadPlace(store()), { fx: undefined, fy: undefined, vertical: undefined, fade: false }, 'nothing saved yet');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadPlace(blocked), { fade: false });
  assert.doesNotThrow(() => savePlace({ fx: 0.5 }, blocked));
});
