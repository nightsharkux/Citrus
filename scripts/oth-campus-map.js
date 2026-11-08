'use strict';
/**
 * Builds resources/oth-campus-map.json: the two OTH Amberg-Weiden campuses as simple geometry (building outlines,
 * roads, bus stops, parking) plus the places a student looks for (lecture hall building, WTC, Mensa, library...).
 *
 *   node scripts/oth-campus-map.js
 *
 * Map data is from OpenStreetMap contributors, licensed under the ODbL (https://www.openstreetmap.org/copyright);
 * the app shows that credit on the map. One request per campus to the public Overpass API.
 *
 * A place is only listed when OpenStreetMap names it or gives it the address the university prints for it (for
 * example the WTC is Campusallee 1 on the university's own pages). Buildings OpenStreetMap does not show, such as
 * the E-House in Weiden, are left off the map and the app says so instead of guessing a position.
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'resources', 'oth-campus-map.json');
const UA = 'CampusOS-OTH-pack/1.0 (student project; https://github.com/nightsharkux/CampusOS_One)';

const CAMPUSES = [
  {
    id: 'weiden', name: 'Weiden', address: 'Hetzenrichter Weg 15, 92637 Weiden', center: [49.6703, 12.1769], radius: 420,
    station: { name: 'Bahnhof Weiden', ref: 'node/13924098' },
    places: [
      { id: 'hsg', ref: 'way/282859831', name: 'Hörsaalgebäude (HSG)', kind: 'building', codes: ['HSG', 'HS', 'H'], address: 'Hetzenrichter Weg 15', note: 'Lecture halls, e.g. HSG 001.' },
      { id: 'wtc', ref: 'way/291810833', name: 'Weidener Technologie-Campus (WTC)', kind: 'building', codes: ['WTC'], address: 'Campusallee 1', note: 'Laboratories and seminar rooms.' },
      { id: 'fos', ref: 'relation/3925517', name: 'FOS/BOS', kind: 'building', codes: ['FOS', 'BOS'], address: 'Campusallee 2', note: 'Rooms used by OTH next to the school.' },
      { id: 'mensa', ref: 'way/291810837', name: 'Mensa', kind: 'food', codes: ['MENSA'], address: 'Hetzenrichter Weg', note: 'Canteen and Coffee Lounge.' },
      { id: 'library', ref: 'node/634254537', name: 'Library Weiden', kind: 'library', codes: ['BIB', 'LIBRARY', 'BIBLIOTHEK'], address: 'Hetzenrichter Weg', note: 'Hochschulbibliothek, Weiden branch.' },
    ],
    unmapped: [{ codes: ['EH'], name: 'E-House', note: 'The E-House is not in the map data yet. See the official campus plan.' }],
    plan: 'https://www.oth-aw.de/files/oth-aw/Standorte/Lageplan_OTH-AW_Weiden.pdf',
  },
  {
    id: 'amberg', name: 'Amberg', address: 'Kaiser-Wilhelm-Ring 23, 92224 Amberg', center: [49.4446, 11.8474], radius: 430,
    station: { name: 'Bahnhof Amberg', ref: 'node/256128750' },
    places: [
      { id: 'emi', ref: 'way/217752008', name: 'Faculty EMI', kind: 'building', codes: ['EMI'], address: 'Kaiser-Wilhelm-Ring 23', note: 'Electrical Engineering, Media and Computer Science. Rooms such as EMI 104 are on floor 1.' },
      { id: 'gebaeude-a', ref: 'way/52155802', name: 'Building A', kind: 'building', codes: ['A'], address: 'Kaiser-Wilhelm-Ring 23b', note: '' },
      { id: 'verwaltung', ref: 'way/52155803', name: 'Administration', kind: 'building', codes: ['VERWALTUNG', 'ADMIN'], address: 'Kaiser-Wilhelm-Ring 23', note: 'OTH Amberg-Weiden administration.' },
      { id: 'library', ref: 'node/2315779377', name: 'Library Amberg', kind: 'library', codes: ['BIB', 'LIBRARY', 'BIBLIOTHEK'], address: 'Kaiser-Wilhelm-Ring 23', note: 'Hochschulbibliothek, Amberg.' },
      { id: 'sports', ref: 'way/52562633', name: 'OTH sports hall', kind: 'sport', codes: ['SPORTHALLE', 'GYM'], address: 'Kaiser-Wilhelm-Ring', note: '' },
      { id: 'eisberg', ref: 'way/52500819', name: 'Student residence Eisberg', kind: 'housing', codes: ['EISBERG'], address: 'Heiner-Fleischmann-Straße 1', note: 'Studentenwohnheim.' },
    ],
    unmapped: [],
    plan: 'https://www.oth-aw.de/files/oth-aw/Standorte/Lageplan_OTH-AW_Amberg.pdf',
  },
];

const round = (n) => Math.round(n * 1e5) / 1e5;

async function overpass(campus) {
  const [lat, lon] = campus.center;
  const r = campus.radius;
  const query = `[out:json][timeout:90];(
    way["building"](around:${r},${lat},${lon});
    relation["building"](around:${r},${lat},${lon});
    way["highway"~"^(primary|secondary|tertiary|residential|unclassified|service|pedestrian|footway|path|living_street|cycleway|track)$"](around:${r + 60},${lat},${lon});
    way["amenity"="parking"](around:${r},${lat},${lon});
    node["highway"="bus_stop"](around:${r + 250},${lat},${lon});
    node["amenity"~"library|canteen|cafe"](around:${r},${lat},${lon});
    node["railway"~"station"](around:3500,${lat},${lon});
  );out geom tags;`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(100_000) }).catch(() => null);
    if (res?.ok) return (await res.json()).elements;
    await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
  }
  throw new Error(`Overpass did not answer for ${campus.name}`);
}

const ring = (geometry) => geometry.map((p) => [round(p.lat), round(p.lon)]);
function simplify(points, minMetres = 2.5) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot((p[0] - last[0]) * 111_000, (p[1] - last[1]) * 71_000) >= minMetres) out.push(p);
  }
  return out.length >= 2 ? out : points;
}
const centre = (points) => {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  return [round((Math.min(...lats) + Math.max(...lats)) / 2), round((Math.min(...lons) + Math.max(...lons)) / 2)];
};

function outline(element) {
  if (element.type === 'way' && element.geometry) return ring(element.geometry);
  if (element.type === 'relation') {
    const outer = (element.members || []).find((m) => m.role === 'outer' && m.geometry);
    if (outer) return ring(outer.geometry);
  }
  return null;
}

async function main() {
  const campuses = [];
  for (const campus of CAMPUSES) {
    console.log(`Reading ${campus.name}...`);
    const elements = await overpass(campus);
    const byRef = new Map(elements.map((e) => [`${e.type}/${e.id}`, e]));

    const buildings = [];
    const roads = [];
    const stops = [];
    const parking = [];
    for (const e of elements) {
      const t = e.tags || {};
      if (t.building) {
        const o = outline(e);
        if (o && o.length >= 3) buildings.push(simplify(o, 1.2));
      } else if (t.highway === 'bus_stop' && e.type === 'node') {
        stops.push({ name: t.name || 'Bus stop', lat: round(e.lat), lon: round(e.lon) });
      } else if (t.highway && e.geometry) {
        roads.push({ name: t.name || '', kind: t.highway, pts: simplify(ring(e.geometry)) });
      } else if (t.amenity === 'parking' && e.geometry) {
        parking.push(simplify(ring(e.geometry), 2));
      }
    }

    const places = [];
    for (const p of campus.places) {
      const e = byRef.get(p.ref);
      if (!e) {
        console.warn(`  ${p.name}: ${p.ref} is not in the result, left out`);
        continue;
      }
      const shape = outline(e);
      const [lat, lon] = e.type === 'node' ? [round(e.lat), round(e.lon)] : shape ? centre(shape) : [round((e.bounds.minlat + e.bounds.maxlat) / 2), round((e.bounds.minlon + e.bounds.maxlon) / 2)];
      places.push({ id: p.id, name: p.name, kind: p.kind, codes: p.codes, address: p.address, note: p.note, lat, lon, ...(shape ? { shape: simplify(shape, 1.2) } : {}) });
    }

    const station = byRef.get(campus.station.ref);
    // Bus stops nearest the campus first, then dedupe the two sides of a street.
    const seenStop = new Set();
    const nearStops = stops
      .map((s) => ({ ...s, distance: Math.hypot((s.lat - campus.center[0]) * 111_000, (s.lon - campus.center[1]) * 71_000) }))
      .sort((a, b) => a.distance - b.distance)
      .filter((s) => (seenStop.has(s.name) ? false : seenStop.add(s.name)))
      .slice(0, 8)
      .map(({ distance, ...s }) => s);

    campuses.push({
      id: campus.id, name: campus.name, address: campus.address, center: campus.center, plan: campus.plan,
      station: station ? { name: campus.station.name, lat: round(station.lat), lon: round(station.lon) } : null,
      places, unmapped: campus.unmapped, stops: nearStops, buildings, roads, parking,
    });
    console.log(`  ${buildings.length} buildings, ${roads.length} roads, ${places.length}/${campus.places.length} places, ${nearStops.length} stops`);
    await new Promise((resolve) => setTimeout(resolve, 6000));
  }

  const file = { generatedOn: new Date().toISOString().slice(0, 10), attribution: '© OpenStreetMap contributors (ODbL)', campuses };
  fs.writeFileSync(OUT, JSON.stringify(file));
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
