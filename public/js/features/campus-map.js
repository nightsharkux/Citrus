/**
 * The campus map tab: both OTH campuses drawn from OpenStreetMap data, your position, and the way to your next lesson.
 *
 *   - A room or building (from your lessons or the search box) is found on the map by its code (HSG, WTC, EMI...).
 *   - "Where am I" uses the browser's location. It stays in the browser: nothing is sent to the server.
 *   - Distance and walking time are estimates; "Directions" opens turn-by-turn in OpenStreetMap or Google Maps.
 *
 * Drawn as SVG with plain JavaScript: drag to move, wheel / pinch / buttons to zoom.
 */
import { html, render, raw, escape, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { toast, toastError } from '../core/ui.js';
import { weekday, time as clock, shortDate } from '../core/format.js';
import { t } from '../core/i18n.js';
import { resolvePlace, distanceMetres, walkMinutes, distanceLabel, directionsLinks, nearestCampus, searchTerms } from './campus-places.js';

const MAJOR = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);
const PATHS = new Set(['footway', 'path', 'pedestrian', 'cycleway', 'track']);
const KIND_ICON = { building: 'door', food: 'bag', library: 'library', sport: 'activity', housing: 'home' };

const projector = (campus) => {
  const [lat0, lon0] = campus.center;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return (lat, lon) => [(lon - lon0) * kx, -(lat - lat0) * 110_540];
};
const pts = (project, list) => list.map(([lat, lon]) => project(lat, lon).map((n) => n.toFixed(1)).join(',')).join(' ');
const centerOf = (list) => {
  const lat = list.map((p) => p[0]);
  const lon = list.map((p) => p[1]);
  return [(Math.min(...lat) + Math.max(...lat)) / 2, (Math.min(...lon) + Math.max(...lon)) / 2];
};

// ---------------------------------------------------------------- the static picture of a campus

function scene(campus) {
  const p = projector(campus);
  const roads = campus.roads.filter((r) => r.pts.length > 1);
  const labelled = roads.filter((r) => r.name && MAJOR.has(r.kind)).sort((a, b) => b.pts.length - a.pts.length);
  const seen = new Set();
  const labels = labelled.filter((r) => (seen.has(r.name) ? false : seen.add(r.name))).slice(0, 14).map((r) => {
    const mid = r.pts[Math.floor(r.pts.length / 2)];
    const [x, y] = p(mid[0], mid[1]);
    return `<text class="map-road-name" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${escape(r.name)}</text>`;
  });
  return raw([
    campus.parking.map((a) => `<polygon class="map-parking" points="${pts(p, a)}"/>`).join(''),
    roads.filter((r) => PATHS.has(r.kind)).map((r) => `<polyline class="map-path" points="${pts(p, r.pts)}"/>`).join(''),
    roads.filter((r) => !PATHS.has(r.kind)).map((r) => `<polyline class="map-road ${MAJOR.has(r.kind) ? 'is-major' : ''}" points="${pts(p, r.pts)}"/>`).join(''),
    campus.buildings.map((b) => `<polygon class="map-building" points="${pts(p, b)}"/>`).join(''),
    campus.places.filter((pl) => pl.shape).map((pl) => `<polygon class="map-place kind-${pl.kind}" data-place="${escape(pl.id)}" points="${pts(p, pl.shape)}"/>`).join(''),
    campus.places.map((pl) => {
      const [x, y] = p(pl.lat, pl.lon);
      return `<g class="map-pin kind-${pl.kind}" data-place="${escape(pl.id)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle class="map-pin-dot" r="1"/><text class="map-label" y="-1.8">${escape(pl.name)}</text></g>`;
    }).join(''),
    campus.stops.map((s) => {
      const [x, y] = p(s.lat, s.lon);
      return `<g class="map-stop" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><rect class="map-stop-dot" x="-0.7" y="-0.7" width="1.4" height="1.4" rx="0.3"/><text class="map-stop-name" y="2.4">${escape(s.name)}</text></g>`;
    }).join(''),
    labels.join(''),
  ].join(''));
}

function bounds(campus) {
  const p = projector(campus);
  const points = [...campus.places.map((pl) => p(pl.lat, pl.lon)), ...campus.stops.slice(0, 2).map((s) => p(s.lat, s.lon))];
  const xs = points.map((q) => q[0]);
  const ys = points.map((q) => q[1]);
  const pad = 70;
  let w = Math.max(240, Math.max(...xs) - Math.min(...xs) + pad * 2);
  let h = Math.max(180, Math.max(...ys) - Math.min(...ys) + pad * 2);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  if (w / h < 1.5) w = h * 1.5;
  else h = w / 1.5;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// ---------------------------------------------------------------- the page

const when = (iso) => `${weekday(iso)} ${shortDate(iso)}, ${clock(iso)}`;

export function mapTab(d) {
  const map = d.map?.map;
  if (!map?.campuses?.length) {
    return html`<section class="card"><h2>Campus map</h2><p class="muted small mt-8">This edition has no campus map yet.</p></section>`;
  }
  return html`
    <section class="card campus-map" data-campus-map>
      <div class="map-bar">
        <nav class="segmented" aria-label="Campus">${map.campuses.map((c) => html`<button type="button" data-campus="${c.id}">${c.name}</button>`)}</nav>
        <label class="map-find">${icon('search', 16)}<input class="input" data-find list="map-places" placeholder="Find a building or room: HSG 001, WTC, Mensa, EMI" autocomplete="off" aria-label="Find a building or room"><datalist id="map-places">${searchTerms(map).map((t) => html`<option value="${t.query}">${t.label}</option>`)}</datalist></label>
        <button type="button" class="btn" data-locate>${icon('map-pin', 16)} <span>Where am I</span></button>
      </div>
      <div class="map-stage">
        <svg class="map-svg" data-map-svg role="img" aria-label="Campus map" preserveAspectRatio="xMidYMid meet"><g data-scene></g><g data-overlay></g></svg>
        <div class="map-zoom"><button type="button" class="btn btn-icon" data-zoom="in" aria-label="Zoom in">${icon('plus', 18)}</button><button type="button" class="btn btn-icon" data-zoom="out" aria-label="Zoom out"><svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h14"/></svg></button><button type="button" class="btn btn-icon" data-zoom="fit" aria-label="Show the whole campus">${icon('maximize', 17)}</button></div>
        <p class="map-credit small faint">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a></p>
      </div>
      <div class="map-dest" data-dest hidden aria-live="polite"></div>
    </section>

    <section class="card mt-16" data-lessons></section>
    <section class="card mt-16" data-arrival></section>`;
}

function lessonsView(info, map, ref) {
  const classes = info.classes || [];
  return html`
    <div class="spread"><div><h2>Your next lessons</h2><p class="small muted mt-8">From your saved schedule. Ask the assistant about programme timetables.</p></div></div>
    ${classes.length ? html`<div class="list mt-16">${classes.map((c, i) => {
      const found = c.location ? resolvePlace(map, c.location, ref) : null;
      return html`<div class="list-row no-icon">
        <span class="body"><span class="title">${c.title}</span><span class="sub">${when(c.starts)} ${t('to')} ${clock(c.ends)} · ${c.location || t('No room listed')}${found?.unmapped ? ` · ${found.unmapped.name} (${t('not on the map data')})` : ''}${c.source === 'official' ? ` · ${t('official timetable')}` : ''}</span></span>
        <span class="trail">${found ? html`<button type="button" class="btn btn-sm" data-go="${i}">${icon('map-pin', 14)} Show</button>` : c.location ? html`<button type="button" class="btn btn-sm btn-ghost" data-go="${i}">${icon('info', 14)} Where</button>` : ''}</span>
      </div>`;
    })}</div>` : html`<p class="muted small mt-16">No lessons with a room found for the next week.</p>`}
    <a class="btn btn-sm mt-16" href="/assistant">Ask about a programme timetable</a>`;
}

function arrivalView(campus) {
  const station = campus.station;
  const to = { lat: campus.center[0], lon: campus.center[1] };
  const links = station ? directionsLinks(station, to) : directionsLinks(null, to);
  return html`
    <h2>Getting to ${campus.name}</h2>
    <p class="small muted mt-8">${campus.address}</p>
    <div class="cluster mt-16">
      ${station ? html`<a class="btn" href="${links.osm}" target="_blank" rel="noopener">${icon('external', 15)} From ${station.name}</a>` : ''}
      <a class="btn" href="${directionsLinks(null, to).google}" target="_blank" rel="noopener">${icon('external', 15)} Directions to campus</a>
      <a class="btn btn-ghost" href="${campus.plan}" target="_blank" rel="noopener">${icon('file', 15)} Official campus plan (PDF)</a>
    </div>
    ${campus.stops.length ? html`<p class="small muted mt-16">Nearest bus stops: ${campus.stops.slice(0, 5).map((s) => s.name).join(', ')}.</p>` : ''}`;
}

export async function loadMapTab() {
  const [map, classes] = await Promise.all([api.get('/campus/map'), api.get('/campus/map/classes').catch(() => ({ classes: [], programmes: [] }))]);
  return { map, classes };
}

// ---------------------------------------------------------------- behaviour

export function mountMapTab(root, d, ctx) {
  const map = d.map?.map;
  const holder = $('[data-campus-map]', root);
  if (!map?.campuses?.length || !holder) return undefined;

  const svg = $('[data-map-svg]', holder);
  const sceneLayer = $('[data-scene]', svg);
  const overlay = $('[data-overlay]', svg);
  const dest = $('[data-dest]', holder);
  const lessons = $('[data-lessons]', root);
  const arrival = $('[data-arrival]', root);

  const state = { campus: map.campuses[0], view: null, fit: null, user: null, target: null, classes: d.classes, watch: null };
  const query = new URLSearchParams(location.search);

  // ---- drawing
  const setView = (view) => {
    state.view = view;
    svg.setAttribute('viewBox', `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
    svg.style.setProperty('--u', (view.w / 100).toFixed(3));
  };
  const drawOverlay = () => {
    const p = projector(state.campus);
    const parts = [];
    if (state.user) {
      const [x, y] = p(state.user.lat, state.user.lon);
      parts.push(`<circle class="map-user-acc" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.min(120, state.user.acc || 20).toFixed(0)}"/><circle class="map-user" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.1"/>`);
    }
    if (state.target) {
      const [tx, ty] = p(state.target.place.lat, state.target.place.lon);
      if (state.user) {
        const [ux, uy] = p(state.user.lat, state.user.lon);
        parts.push(`<line class="map-route" x1="${ux.toFixed(1)}" y1="${uy.toFixed(1)}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}"/>`);
      }
      parts.push(`<g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)})"><circle class="map-target-ring" r="2.6"/><circle class="map-target" r="1.3"/></g>`);
    }
    overlay.innerHTML = parts.join('');
  };
  const drawCampus = (campus, { keepView = false } = {}) => {
    state.campus = campus;
    sceneLayer.innerHTML = scene(campus).value;
    state.fit = bounds(campus);
    if (!keepView) setView({ ...state.fit });
    drawOverlay();
    $$campus().forEach((b) => b.classList.toggle('is-active', b.dataset.campus === campus.id));
    render(arrival, arrivalView(campus));
    lessons.innerHTML = lessonsView(state.classes, map, campus.id).value;
  };
  const $$campus = () => [...holder.querySelectorAll('[data-campus]')];

  // ---- the destination card
  function showTarget(found, label = '') {
    if (!found) {
      state.target = null;
      dest.hidden = true;
      drawOverlay();
      return;
    }
    if (found.campus.id !== state.campus.id) drawCampus(found.campus);
    if (found.unmapped) {
      state.target = null;
      drawOverlay();
      dest.hidden = false;
      render(dest, html`<div class="map-dest-body"><span class="tile warning">${icon('info', 18)}</span><div class="grow"><strong>${found.unmapped.name}, ${found.campus.name}</strong><p class="small muted">${found.unmapped.note}</p></div>
        <a class="btn btn-sm" href="${found.campus.plan}" target="_blank" rel="noopener">${icon('file', 14)} Campus plan</a><button type="button" class="btn btn-sm btn-ghost" data-clear>Close</button></div>`);
      return;
    }
    state.target = found;
    const place = found.place;
    const here = state.user;
    const metres = here ? distanceMetres(here, place) : null;
    const links = directionsLinks(here, place);
    drawOverlay();
    // Bring the destination (and you) into view.
    const p = projector(state.campus);
    const xy = [p(place.lat, place.lon)];
    if (here) xy.push(p(here.lat, here.lon));
    const minX = Math.min(...xy.map((q) => q[0])) - 60;
    const maxX = Math.max(...xy.map((q) => q[0])) + 60;
    const minY = Math.min(...xy.map((q) => q[1])) - 40;
    const maxY = Math.max(...xy.map((q) => q[1])) + 40;
    let w = Math.max(260, maxX - minX);
    let h = Math.max(173, maxY - minY);
    if (w / h < 1.5) w = h * 1.5;
    else h = w / 1.5;
    setView({ x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h });
    dest.hidden = false;
    render(dest, html`<div class="map-dest-body"><span class="tile">${icon(KIND_ICON[place.kind] || 'map-pin', 18)}</span>
      <div class="grow"><strong>${place.name}</strong>${label ? html` <span class="chip">${label}</span>` : ''}
        <p class="small muted">${found.campus.name} · ${place.address}${place.note ? ` · ${place.note}` : ''}</p>
        <p class="small">${metres === null
    ? 'Tap “Where am I” to see the distance from where you are.'
    : metres > 6000 ? html`You are about ${distanceLabel(metres)} away. That is a trip to ${found.campus.name}, not a walk across campus.` : html`About <strong>${distanceLabel(metres)}</strong> from you, roughly <strong>${walkMinutes(metres)} min</strong> on foot (estimate).`}</p></div>
      <div class="map-dest-actions"><a class="btn btn-sm btn-primary" href="${links.osm}" target="_blank" rel="noopener">${icon('external', 14)} Directions</a><a class="btn btn-sm" href="${links.google}" target="_blank" rel="noopener">Google Maps</a><button type="button" class="btn btn-sm btn-ghost" data-clear>Close</button></div></div>`);
  }

  function goTo(text, label = '') {
    const found = resolvePlace(map, text, state.campus.id);
    if (!found) {
      toast('I could not find that building on the map. Try its code, like HSG, WTC or EMI.', 'info');
      return;
    }
    showTarget(found, label);
  }

  // ---- your position
  const fix = (pos) => {
    state.user = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
    const near = nearestCampus(map, state.user);
    if (near && near.metres < 6000 && near.campus.id !== state.campus.id && !state.target && !state.pickedCampus) drawCampus(near.campus);
    drawOverlay();
    if (state.target) showTarget(state.target);
    else if (near && near.metres > 6000) toast(`You are about ${distanceLabel(near.metres)} from the nearest campus (${near.campus.name}).`, 'info');
  };
  const locate = () => {
    if (!('geolocation' in navigator)) {
      toast('This browser cannot share your location.', 'error');
      return;
    }
    if (state.watch !== null) {
      navigator.geolocation.clearWatch(state.watch);
      state.watch = null;
      state.user = null;
      drawOverlay();
      $('[data-locate] span', holder).textContent = 'Where am I';
      if (state.target) showTarget(state.target);
      return;
    }
    $('[data-locate] span', holder).textContent = 'Finding you…';
    state.watch = navigator.geolocation.watchPosition(
      (pos) => {
        $('[data-locate] span', holder).textContent = 'Stop sharing';
        fix(pos);
      },
      (error) => {
        state.watch = null;
        $('[data-locate] span', holder).textContent = 'Where am I';
        toast(error.code === 1 ? 'Location is blocked for this site. Allow it in your browser to see where you are. It never leaves your device.' : 'I could not find your position. Try again outside or with location turned on.', 'error', { duration: 6000 });
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
  };

  // ---- pan and zoom
  const toMap = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    const scale = Math.max(state.view.w / r.width, state.view.h / r.height);
    const offX = (r.width - state.view.w / scale) / 2;
    const offY = (r.height - state.view.h / scale) / 2;
    return [state.view.x + (clientX - r.left - offX) * scale, state.view.y + (clientY - r.top - offY) * scale];
  };
  const zoomAt = (factor, cx, cy) => {
    const v = state.view;
    const w = Math.min(state.fit.w * 2.2, Math.max(60, v.w * factor));
    const h = w / (v.w / v.h);
    const [mx, my] = cx === undefined ? [v.x + v.w / 2, v.y + v.h / 2] : [cx, cy];
    setView({ x: mx - ((mx - v.x) / v.w) * w, y: my - ((my - v.y) / v.h) * h, w, h });
  };
  const pointers = new Map();
  let pinch = 0;
  const offs = [];
  const listen = (el, type, fn, options) => {
    el.addEventListener(type, fn, options);
    offs.push(() => el.removeEventListener(type, fn, options));
  };
  listen(svg, 'pointerdown', (e) => {
    svg.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: 0 });
    pinch = pointers.size === 2 ? Math.hypot(...[...pointers.values()].reduce((a, p, i) => (i ? [a[0] - p.x, a[1] - p.y] : [p.x, p.y]), [])) : 0;
  });
  listen(svg, 'pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      p.x = e.clientX;
      p.y = e.clientY;
      const now = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) {
        const [mx, my] = toMap((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAt(pinch / now, mx, my);
      }
      pinch = now;
      return;
    }
    const r = svg.getBoundingClientRect();
    const scale = Math.max(state.view.w / r.width, state.view.h / r.height);
    const dx = (e.clientX - p.x) * scale;
    const dy = (e.clientY - p.y) * scale;
    p.moved += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y);
    p.x = e.clientX;
    p.y = e.clientY;
    setView({ ...state.view, x: state.view.x - dx, y: state.view.y - dy });
  });
  const lift = (e) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    pinch = 0;
    if (p && p.moved < 6 && e.type === 'pointerup') {
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-place]');
      const place = hit && state.campus.places.find((pl) => pl.id === hit.dataset.place);
      if (place) showTarget({ campus: state.campus, place });
    }
  };
  listen(svg, 'pointerup', lift);
  listen(svg, 'pointercancel', lift);
  listen(svg, 'wheel', (e) => {
    e.preventDefault();
    const [mx, my] = toMap(e.clientX, e.clientY);
    zoomAt(e.deltaY > 0 ? 1.18 : 1 / 1.18, mx, my);
  }, { passive: false });

  // ---- events
  offs.push(
    on(holder, 'click', '[data-campus]', (e, b) => {
      state.pickedCampus = true;
      drawCampus(map.campuses.find((c) => c.id === b.dataset.campus));
      showTarget(null);
    }),
    on(holder, 'click', '[data-zoom]', (e, b) => (b.dataset.zoom === 'fit' ? setView({ ...state.fit }) : zoomAt(b.dataset.zoom === 'in' ? 1 / 1.4 : 1.4))),
    on(holder, 'click', '[data-locate]', locate),
    on(holder, 'click', '[data-clear]', () => showTarget(null)),
    on(root, 'click', '[data-go]', (e, b) => {
      const c = state.classes.classes[Number(b.dataset.go)];
      if (!c) return;
      const found = resolvePlace(map, c.location, state.campus.id);
      if (found) {
        showTarget(found, c.title.length > 28 ? `${c.title.slice(0, 27)}…` : c.title);
        holder.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else toast(`Room ${c.location} does not say which building it is in. Look for it on the campus plan.`, 'info', { duration: 5000 });
    }),
  );
  listen(holder, 'change', (e) => {
    if (e.target.matches('[data-find]') && e.target.value.trim()) {
      goTo(e.target.value);
      e.target.value = '';
    }
  });
  // First picture: the campus asked for in the link (?to=HSG), or the first campus.
  const wanted = query.get('to');
  const first = wanted ? resolvePlace(map, wanted) : null;
  drawCampus(first?.campus || map.campuses[0]);
  if (first) showTarget(first);

  return () => {
    offs.forEach((off) => off());
    if (state.watch !== null) navigator.geolocation.clearWatch(state.watch);
  };
}
