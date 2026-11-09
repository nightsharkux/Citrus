/**
 * Campus's face: the ring from the logo, used as a robot eye.
 *
 * There is no pupil. The ring itself is the eye: it squashes flat to blink,
 * slides and turns to look around, and changes shape to show how it feels
 * (an arc when happy, a heavy lid when sad or sleepy, wide when surprised,
 * a gap that circles the ring while it thinks).
 *
 *   const face = createFace({ size: 44 });
 *   container.append(face.el);
 *   face.setMood('thinking');            // idle · listening · thinking · speaking · asleep
 *   face.react('happy', 1600);           // brief: happy · excited · laugh · curious · wink · surprised · confused · sad
 *   face.pulse();                        // a quick widening: "I hear you"
 *   face.typingAt(x, y);                 // follow the text cursor (screen point)
 *   face.showVisual({ kind: 'formula', content: 'a^2 + b^2 = c^2' });
 *   face.hideVisual();
 *   face.destroy();
 *
 * Idle behaviour: blinks, glances around, follows the pointer, makes a small
 * gesture now and then, gets drowsy after a minute without activity.
 * Honours prefers-reduced-motion (expressions stay, movement stops).
 */
import { buildVisual } from './face-visuals.js';
import { escape, raw } from '../core/dom.js';
import { speechLevel, isSpeaking } from './speaker.js';

let seq = 0;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const K = 0.5523; // Bézier constant for a quarter circle

/**
 * The eye's shape, in a 100×100 box centred on 0,0:
 *   w        half width
 *   top/bot  height of the upper/lower half (negative bends that half the other way)
 *   x, y     offset (where it looks)      tilt  rotation in degrees
 *   brow     slant of the upper edge      gap   opening in the ring, % of its length
 *   sw       stroke width
 */
const KEYS = ['w', 'top', 'bot', 'x', 'y', 'tilt', 'brow', 'gap', 'sw'];
const REST = { w: 35.5, top: 35.5, bot: 35.5, x: 0, y: 0, tilt: 0, brow: 0, gap: 0, sw: 12 };
const STAGE = { ...REST, w: 40.5, top: 40.5, bot: 40.5, sw: 10 }; // wide open around an illustration

/**
 * Mood → shape changes, plus behaviour: spin (gradient, deg/s), talk, pulse, wobble, bounce (little hops),
 * laugh (quick shake), noBlink.
 */
const MOODS = {
  idle: {},
  drowsy: { w: 37, top: 15, bot: 32, y: 4 },
  listening: { w: 38, top: 38, bot: 38, spin: 70, pulse: 0.035 },
  thinking: { w: 35, top: 32, bot: 28, gap: 22, spin: 130 },
  speaking: { talk: true, spin: 36 },
  happy: { w: 36, top: 26, bot: -21, y: 6, noBlink: true },
  excited: { w: 39, top: 30, bot: -25, y: 4, noBlink: true, bounce: true, spin: 220 },
  laugh: { w: 37, top: 22, bot: -23, y: 6, noBlink: true, laugh: true, spin: 120 },
  curious: { w: 37.5, top: 40, bot: 33, tilt: 12, brow: 7 },
  wink: { w: 37, top: 3, bot: 22, y: 3, tilt: -7, noBlink: true },
  surprised: { w: 41.5, top: 41.5, bot: 41.5, sw: 9.5 },
  confused: { w: 33, top: 26, bot: 34, brow: 10, tilt: -9, wobble: true },
  sad: { w: 32, top: 13, bot: 30, y: 8, brow: -11, tilt: 5 },
  asleep: { w: 33, top: -8, bot: 12, y: 2, noBlink: true },
};
const TYPING = { w: 36.5, top: 31, bot: 35 };      // concentrating on what you write
const ATTENTIVE = { w: 36.5, top: 38, bot: 35.5 };  // looking back up at you

/** Small idle gestures, played now and then. */
const GESTURES = [
  { shape: { tilt: 9, w: 37.5, top: 38.5 }, ms: 1300 },   // curious
  { shape: { tilt: -9, w: 37.5, top: 38.5 }, ms: 1300 },
  { shape: { top: 24, bot: 29, w: 37 }, ms: 750 },         // squint
  { shape: { y: -4 }, ms: 260 },                           // little hop
  { blink: 2 },                                            // double blink
  { shape: { w: 37, top: 3, bot: 22, y: 3, tilt: -7 }, ms: 360 }, // wink
  { shape: { w: 36.5, top: 30, bot: -12, y: 4 }, ms: 900 },       // a quick smile
];

/** Reactions get a small physical kick when they start. */
const KICKS = {
  happy: { y: -90 },
  excited: { y: -150, w: 70 },
  laugh: { y: -80 },
  curious: { tilt: 110 },
  wink: { top: -120 },
  surprised: { w: 110, top: 110, bot: 110 },
  confused: { tilt: -80 },
  sad: { y: 40 },
};

// One shared listener for pointer position and global activity.
const world = { px: 0, py: 0, pointerAt: 0, activeAt: performance.now(), listeners: 0 };
function onPointer(e) {
  world.px = e.clientX;
  world.py = e.clientY;
  world.pointerAt = performance.now();
  world.activeAt = world.pointerAt;
}
function onActivity() {
  world.activeAt = performance.now();
}
function retainWorld() {
  if (world.listeners++ === 0) {
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('keydown', onActivity, { passive: true });
    window.addEventListener('scroll', onActivity, { passive: true });
    window.addEventListener('touchstart', onActivity, { passive: true });
  }
}
function releaseWorld() {
  if (--world.listeners === 0) {
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('keydown', onActivity);
    window.removeEventListener('scroll', onActivity);
    window.removeEventListener('touchstart', onActivity);
  }
}

/** The ring outline: an upper and a lower half-ellipse joined at the corners. */
function eyePath(w, top, bot, brow) {
  const f = (n) => n.toFixed(2);
  const slant = (x) => (brow * x) / w;
  return `M${f(-w)} 0`
    + `C${f(-w)} ${f(-K * top + slant(-w) * 0.5)} ${f(-K * w)} ${f(-top + slant(-K * w))} 0 ${f(-top)}`
    + `C${f(K * w)} ${f(-top + slant(K * w))} ${f(w)} ${f(-K * top + slant(w) * 0.5)} ${f(w)} 0`
    + `C${f(w)} ${f(K * bot)} ${f(K * w)} ${f(bot)} 0 ${f(bot)}`
    + `C${f(-K * w)} ${f(bot)} ${f(-w)} ${f(K * bot)} ${f(-w)} 0Z`;
}

function markup(id) {
  // userSpaceOnUse keeps the gradient and glow visible when the ring squashes to a line.
  return `<svg class="face-svg" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="face-g-${id}" gradientUnits="userSpaceOnUse" x1="-44" y1="-44" x2="44" y2="44">
        <stop offset="0" class="s1"/><stop offset=".55" class="s2"/><stop offset="1" class="s3"/>
      </linearGradient>
      <filter id="face-f-${id}" filterUnits="userSpaceOnUse" x="-50" y="-50" width="100" height="100">
        <feDropShadow class="face-glow" dx="0" dy="0" stdDeviation="2.6"/>
      </filter>
      <clipPath id="face-c-${id}"><circle r="35.2"/></clipPath>
    </defs>
    <circle class="face-inner" r="35.6"/>
    <g class="face-visual" clip-path="url(#face-c-${id})"></g>
    <g class="face-eye" filter="url(#face-f-${id})"><path class="face-ring" pathLength="100" stroke="url(#face-g-${id})"/></g>
  </svg>`;
}

export function createFace({ size, label = 'Campus', mood = 'idle', followPointer = true } = {}) {
  const id = ++seq;
  const el = document.createElement('span');
  el.className = 'face';
  if (size) el.style.setProperty('--face-size', `${size}px`);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.innerHTML = markup(id);

  const ring = el.querySelector('.face-ring');
  const eye = el.querySelector('.face-eye');
  const gradient = el.querySelector('linearGradient');
  const visualLayer = el.querySelector('.face-visual');

  const v = { ...REST };                                    // current shape
  const vel = Object.fromEntries(KEYS.map((k) => [k, 0])); // spring velocities
  const s = {
    base: mood, overlay: null, overlayUntil: 0, kick: null,
    tx: 0, ty: 0, nextGlance: 0,
    blinkStart: -1, blinksLeft: 0, nextBlink: performance.now() + rand(1500, 4000),
    gesture: null, gestureUntil: 0, nextGesture: performance.now() + rand(7000, 12000),
    typingUntil: 0, attentiveUntil: 0, caret: null,
    angle: 0, spin: 0, phase: 0, visual: false, voice: 0, heard: 0,
    rect: null, rectAt: 0, visualStop: null, visualTimer: null, alive: true, last: performance.now(),
  };
  retainWorld();
  // Nothing to animate while the face is scrolled out of view.
  const watcher = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => { s.offscreen = !entry.isIntersecting; }) : null;
  watcher?.observe(el);

  const current = () => (s.overlay && performance.now() < s.overlayUntil ? s.overlay : s.base);

  function rect() {
    const now = performance.now();
    if (!s.rect || now - s.rectAt > 400) {
      s.rect = el.getBoundingClientRect();
      s.rectAt = now;
    }
    return s.rect;
  }

  /** Direction (-1..1) from the face centre towards a screen point. */
  function towards(px, py, reach = 260) {
    const r = rect();
    const dx = px - (r.left + r.width / 2);
    const dy = py - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const k = clamp(dist / reach, 0.35, 1);
    return [clamp((dx / dist) * k, -1, 1), clamp((dy / dist) * k, -1, 1)];
  }

  /** Where to look (-1..1 on each axis). */
  function chooseTarget(now, name) {
    const t = now / 1000;
    if (s.visual) return void ([s.tx, s.ty] = [0, 0]);
    switch (name) {
      case 'thinking': s.tx = 0.55 + Math.sin(t * 1.3) * 0.18; s.ty = -0.65 + Math.cos(t * 1.1) * 0.1; return;
      case 'speaking': s.tx = Math.sin(t * 1.7) * 0.45; s.ty = 0.05 + Math.sin(t * 0.9) * 0.1; return;
      case 'listening': s.tx = Math.sin(t * 0.8) * 0.08; s.ty = -0.3; return;
      case 'asleep': s.tx = 0; s.ty = 0.15; return;
      case 'happy': case 'surprised': case 'confused': case 'sad': case 'excited': case 'laugh': case 'wink': s.tx = 0; s.ty = -0.1; return;
      case 'curious': s.tx = 0.25; s.ty = -0.35; return;
      default: break;
    }
    if (now < s.typingUntil && s.caret) return void ([s.tx, s.ty] = towards(s.caret[0], s.caret[1], 180));
    if (now < s.attentiveUntil) return void ([s.tx, s.ty] = [0, -0.4]);
    if (reduced()) return void ([s.tx, s.ty] = [0, 0]);
    if (followPointer && now - world.pointerAt < 2200) return void ([s.tx, s.ty] = towards(world.px, world.py));
    if (now > s.nextGlance) {
      if (Math.random() < 0.45) [s.tx, s.ty] = [rand(-0.15, 0.15), rand(-0.12, 0.12)];
      else [s.tx, s.ty] = [rand(-0.95, 0.95), rand(-0.55, 0.5)];
      s.nextGlance = now + rand(1400, 4200);
    }
  }

  /** 0 (open) → 1 (closed) → 0 over 140 ms (a quick, lively blink); handles double blinks. */
  function blinkAmount(now, name, m) {
    if (reduced() || m.noBlink || s.visual) return 0;
    if (s.blinkStart < 0 && now > s.nextBlink) {
      s.blinkStart = now;
      if (!s.blinksLeft) s.blinksLeft = Math.random() < 0.18 ? 2 : 1;
    }
    if (s.blinkStart < 0 || now < s.blinkStart) return 0;
    const p = (now - s.blinkStart) / 140;
    if (p >= 1) {
      s.blinksLeft = Math.max(0, s.blinksLeft - 1);
      s.blinkStart = s.blinksLeft ? now + 70 : -1;
      if (!s.blinksLeft) s.nextBlink = now + (name === 'drowsy' ? rand(1800, 3200) : rand(2200, 5400));
      return 0;
    }
    return p < 0.45 ? p / 0.45 : 1 - (p - 0.45) / 0.55;
  }

  function frame(now) {
    if (!s.alive) return;
    if (document.hidden || s.offscreen) return void requestAnimationFrame(frame);
    // A calm face (idle or asleep) moves slowly: 30 frames a second is plenty and leaves the main thread free for typing.
    const calm = !s.visual && now >= s.typingUntil && (current() === 'idle' || current() === 'asleep');
    if (calm && now - s.last < 30) return void requestAnimationFrame(frame);
    const dt = Math.min(0.04, (now - s.last) / 1000);
    s.last = now;

    let name = current();
    if (name === 'idle' && now - world.activeAt > 60_000 && !reduced()) name = 'drowsy';
    const m = MOODS[name] || MOODS.idle;
    const still = reduced();
    const t = now / 1000;
    chooseTarget(now, name);

    // Target shape: mood, then typing/attention, then gaze and gestures.
    const target = { ...REST };
    if (s.visual) {
      Object.assign(target, STAGE);
    } else {
      for (const k of KEYS) if (m[k] !== undefined) target[k] = m[k];
      if (name === 'idle') {
        if (now < s.typingUntil) Object.assign(target, TYPING);
        else if (now < s.attentiveUntil) Object.assign(target, ATTENTIVE);
        else if (!still) {
          if (now > s.nextGesture) {
            const g = pick(GESTURES);
            if (g.blink) { s.blinksLeft = g.blink; s.blinkStart = now; }
            else { s.gesture = g.shape; s.gestureUntil = now + g.ms; }
            s.nextGesture = now + rand(5000, 10000);
          }
          if (s.gesture && now < s.gestureUntil) Object.assign(target, s.gesture);
        }
      }
      // Looking around: slide towards the target and turn a little (narrower from the side).
      target.x += s.tx * 8.5;
      target.y += s.ty * 7.5;
      target.w *= 1 - 0.1 * Math.abs(s.tx);
      if (target.top > 0) target.top *= 1 - 0.07 * Math.abs(s.ty);
      if (target.bot > 0) target.bot *= 1 - 0.07 * Math.abs(s.ty);
    }

    // Springs give the movement a little weight and overshoot; reduced motion snaps. They are stiff enough that a
    // change of mood lands in about a fifth of a second, with the same bounce as before (same damping ratio).
    if (s.kick && !still) {
      for (const [k, dv] of Object.entries(s.kick)) vel[k] += dv;
    }
    s.kick = null;
    const typing = now < s.typingUntil;
    for (const k of KEYS) {
      if (still) { v[k] = target[k]; vel[k] = 0; continue; }
      const look = k === 'x' || k === 'y';
      const stiff = look ? (typing ? 420 : 340) : 300;
      const damp = look ? (typing ? 38 : 31) : 21;
      vel[k] += (stiff * (target[k] - v[k]) - damp * vel[k]) * dt;
      v[k] += vel[k] * dt;
    }

    // Fast effects on top of the springs: blink, talking, hops, laughter, breathing.
    let { w, top, bot } = v;
    let lift = 0;
    const blink = blinkAmount(now, name, m);
    if (blink) {
      top += (2 - top) * blink;
      bot += (2.5 - bot) * blink;
      w *= 1 + 0.05 * blink;
    }
    if (m.talk && !still && !s.visual) {
      // With Campus's voice playing, the eye opens and closes with its loudness; otherwise a speech-like rhythm.
      s.voice += ((isSpeaking() ? speechLevel() : (0.5 + 0.5 * Math.sin(t * 10.5)) * (0.6 + 0.4 * Math.sin(t * 2.3))) - s.voice) * Math.min(1, dt * 18);
      top -= s.voice * 9;
      bot -= s.voice * 4;
      w += s.voice * 2.4;
      lift = -s.voice * 1.5;
    }
    if (m.bounce && !still) lift -= Math.abs(Math.sin(t * 8.5)) * 5;
    if (m.laugh && !still) lift += Math.sin(t * 24) * 1.8;
    // A little widening each time the person's words come in (pulse()).
    if (s.heard > 0.01 && !still) {
      w += s.heard * 3;
      top += s.heard * 3;
      s.heard *= Math.max(0, 1 - dt * 7);
    }
    const breathe = still ? 1 : 1 + (m.pulse ? m.pulse * Math.sin(t * 4.2) : 0.01 * Math.sin(t * 1.6));
    w *= breathe; top *= breathe; bot *= breathe;

    ring.setAttribute('d', eyePath(Math.max(4, w), top, bot, v.brow));
    ring.setAttribute('stroke-width', clamp(v.sw, 6, 14).toFixed(2));
    const tilt = v.tilt + (m.wobble && !still ? Math.sin(t * 2.4) * 3.5 : 0) + (m.laugh && !still ? Math.sin(t * 12) * 2.5 : 0);
    eye.setAttribute('transform', `translate(${v.x.toFixed(2)} ${(v.y + lift).toFixed(2)}) rotate(${tilt.toFixed(2)})`);

    // The gap that circles the ring while thinking.
    if (v.gap > 0.5) {
      if (!still) s.phase = (s.phase + 62 * dt) % 100;
      ring.setAttribute('stroke-dasharray', `${(100 - v.gap).toFixed(2)} ${v.gap.toFixed(2)}`);
      ring.setAttribute('stroke-dashoffset', (-s.phase).toFixed(2));
    } else if (ring.hasAttribute('stroke-dasharray')) {
      ring.removeAttribute('stroke-dasharray');
      ring.removeAttribute('stroke-dashoffset');
    }

    // The colours drift slowly round the ring when Campus is busy.
    s.spin += ((still ? 0 : m.spin || 0) - s.spin) * Math.min(1, dt * 3);
    if (Math.abs(s.spin) > 0.5) {
      s.angle = (s.angle + s.spin * dt) % 360;
      gradient.setAttribute('gradientTransform', `rotate(${s.angle.toFixed(1)})`);
    }

    el.classList.toggle('is-thinking', name === 'thinking');
    el.classList.toggle('is-listening', name === 'listening');
    el.classList.toggle('is-asleep', name === 'asleep');
    el.classList.toggle('is-sad', name === 'sad');
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  const api = {
    el,
    get mood() {
      return current();
    },
    setMood(name) {
      if (!MOODS[name]) return api;
      if (name !== 'asleep' && s.base === 'asleep') s.blinkStart = performance.now();
      s.base = name;
      if (name !== 'idle') s.typingUntil = 0;
      return api;
    },
    /** A short expression on top of the current mood. */
    react(name, ms = 1400) {
      if (!MOODS[name]) return api;
      if (s.overlay !== name || performance.now() >= s.overlayUntil) s.kick = KICKS[name] || null;
      s.overlay = name;
      s.overlayUntil = performance.now() + ms;
      return api;
    },
    /** Follow the text cursor at a screen point; looks back up shortly after typing stops. */
    typingAt(x, y) {
      const now = performance.now();
      s.caret = [x, y];
      s.typingUntil = now + 1100;
      s.attentiveUntil = now + 1100 + 2300;
      world.activeAt = now;
      return api;
    },
    stopTyping() {
      s.typingUntil = 0;
      return api;
    },
    look(x, y) {
      s.tx = clamp(x, -1, 1);
      s.ty = clamp(y, -1, 1);
      s.nextGlance = performance.now() + 2500;
      return api;
    },
    blink() {
      s.blinksLeft = 1;
      s.blinkStart = performance.now();
      return api;
    },
    /** A small, quick widening: "I hear you" (each time new words of the person come in). */
    pulse(strength = 1) {
      s.heard = Math.min(1.4, s.heard + 0.6 * strength);
      return api;
    },
    /** Open the ring wide and show an illustration inside it. Returns false for unknown kinds. */
    showVisual(spec, { duration = 0 } = {}) {
      const built = buildVisual(spec);
      if (!built) return false;
      api.hideVisual({ immediate: true });
      visualLayer.innerHTML = `<title>${escape(built.label)}</title>${built.markup}`;
      el.setAttribute('aria-label', `${label}: ${built.label}`);
      s.visual = true;
      requestAnimationFrame(() => el.classList.add('is-visual'));
      s.visualStop = built.start(visualLayer);
      if (duration) s.visualTimer = setTimeout(() => api.hideVisual(), duration);
      return true;
    },
    hideVisual({ immediate = false } = {}) {
      clearTimeout(s.visualTimer);
      if (!s.visual && !visualLayer.firstChild) return api;
      s.visual = false;
      el.classList.remove('is-visual');
      el.setAttribute('aria-label', label);
      const stop = s.visualStop;
      s.visualStop = null;
      const clear = () => {
        stop?.();
        if (!s.visual) visualLayer.innerHTML = '';
      };
      if (immediate) clear();
      else setTimeout(clear, 450);
      return api;
    },
    get showingVisual() {
      return s.visual;
    },
    destroy() {
      if (!s.alive) return;
      s.alive = false;
      watcher?.disconnect();
      clearTimeout(s.visualTimer);
      s.visualStop?.();
      releaseWorld();
      el.remove();
    },
  };
  return api;
}

/** Drive several faces as one (e.g. the header face and the welcome hero). */
export function faceGroup(...faces) {
  const members = new Set(faces);
  const each = (fn) => members.forEach((f) => fn(f));
  return {
    add(f) { members.add(f); return f; },
    remove(f) { members.delete(f); f.destroy(); },
    setMood: (n) => each((f) => f.setMood(n)),
    react: (n, ms) => each((f) => f.react(n, ms)),
    typingAt: (x, y) => each((f) => f.typingAt(x, y)),
    stopTyping: () => each((f) => f.stopTyping()),
    look: (x, y) => each((f) => f.look(x, y)),
    pulse: (n) => each((f) => f.pulse(n)),
    showVisual: (spec, opts) => [...members].map((f) => f.showVisual(spec, opts)).some(Boolean),
    hideVisual: (opts) => each((f) => f.hideVisual(opts)),
    get showingVisual() { return [...members].some((f) => f.showingVisual); },
    destroy: () => each((f) => f.destroy()),
  };
}

/**
 * Keep a face looking at the text cursor of an input or textarea.
 * Returns a cleanup function.
 */
export function watchTyping(field, face) {
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', overflow: 'hidden', overflowWrap: 'break-word' });
  const marker = document.createElement('span');
  marker.textContent = '​';
  document.body.append(mirror);
  const props = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'tabSize'];
  const isInput = field.tagName === 'INPUT';
  mirror.style.whiteSpace = isInput ? 'pre' : 'pre-wrap';

  // The look of the field changes rarely (resize, focus), so copy its styles then, not on every key.
  let styled = false;
  const copyStyles = () => {
    const cs = getComputedStyle(field);
    for (const p of props) mirror.style[p] = cs[p];
    if (isInput) mirror.style.width = 'auto';
    styled = true;
  };
  const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { styled = false; }) : null;
  resizes?.observe(field);

  function caretPoint() {
    if (!styled) copyStyles();
    mirror.textContent = field.value.slice(0, field.selectionEnd ?? field.value.length);
    mirror.append(marker);
    const r = field.getBoundingClientRect();
    const x = r.left + marker.offsetLeft - (isInput ? field.scrollLeft : 0);
    const y = r.top + marker.offsetTop - field.scrollTop + marker.offsetHeight / 2;
    return [clamp(x, r.left, r.right), clamp(y, r.top, r.bottom)];
  }

  // At most one measurement per frame, however fast you type.
  let frame = 0;
  const update = () => {
    frame = 0;
    if (document.activeElement !== field) return;
    const [x, y] = caretPoint();
    face.typingAt(x, y);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const keys = (e) => {
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') schedule();
  };
  const focus = () => { styled = false; };
  field.addEventListener('input', schedule);
  field.addEventListener('keyup', keys);
  field.addEventListener('click', schedule);
  field.addEventListener('focus', focus);
  const blur = () => face.stopTyping();
  field.addEventListener('blur', blur);
  return () => {
    cancelAnimationFrame(frame);
    resizes?.disconnect();
    field.removeEventListener('blur', blur);
    field.removeEventListener('focus', focus);
    field.removeEventListener('input', schedule);
    field.removeEventListener('keyup', keys);
    field.removeEventListener('click', schedule);
    mirror.remove();
  };
}

/** Static ring for message avatars and small UI (pure CSS, no animation). */
export const faceMark = (size = '') => raw(`<span class="face-mark ${size}" aria-hidden="true"></span>`);
