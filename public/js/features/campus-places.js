/**
 * Pure helpers for the campus map (no DOM, so they are tested directly): finding the building a room belongs to,
 * distances, and links that open turn-by-turn directions in a maps app.
 *
 * A room is written many ways in timetables: "HSG 001", "WTC 1.25", "EMI104", "EH 4.4", "Hörsaalgebäude (H001)".
 * The building code is the letters in front; each place in the map data lists the codes it answers to.
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` name this place through one of its codes? Single letters only count when a number follows ("H 001"). */
function mentions(text, place) {
  const upper = String(text).toUpperCase();
  return (place.codes || []).some((code) => {
    const c = escapeRe(code.toUpperCase());
    const re = code.length === 1 ? new RegExp(`(?<![A-ZÄÖÜ])${c}\\s?\\d`) : new RegExp(`(?<![A-ZÄÖÜ])${c}(?![A-ZÄÖÜ])`);
    return re.test(upper);
  });
}

/**
 * The place a room or building name points to.
 * Returns { campus, place } for a mapped building, { campus, unmapped } for a building that exists but has no
 * position in the data (the E-House), or null. `prefer` is the campus id to favour when a code exists in both
 * (the library does).
 */
export function resolvePlace(map, text, prefer = null) {
  if (!map?.campuses?.length || !String(text || '').trim()) return null;
  const said = String(text).toLowerCase();
  const named = map.campuses.find((c) => said.includes(c.name.toLowerCase()));
  const order = [...map.campuses].sort((a, b) => (b.id === (named?.id || prefer)) - (a.id === (named?.id || prefer)));
  for (const campus of order) {
    const place = campus.places.find((p) => mentions(text, p));
    if (place) return { campus, place };
  }
  for (const campus of order) {
    const unmapped = (campus.unmapped || []).find((u) => mentions(text, u));
    if (unmapped) return { campus, unmapped };
  }
  return null;
}

/** Straight-line distance in metres. */
export function distanceMetres(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** An estimate: streets are longer than the straight line (about a quarter), and people walk about 4.7 km/h. */
export const walkMinutes = (metres) => Math.max(1, Math.round((metres * 1.25) / 78));

export function distanceLabel(metres) {
  if (metres < 950) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Links that open directions in OpenStreetMap or Google Maps (with the start when it is known). */
export function directionsLinks(from, to) {
  const dest = `${to.lat},${to.lon}`;
  const osm = from
    ? `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${from.lat}%2C${from.lon}%3B${to.lat}%2C${to.lon}`
    : `https://www.openstreetmap.org/?mlat=${to.lat}&mlon=${to.lon}#map=18/${to.lat}/${to.lon}`;
  const google = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=walking${from ? `&origin=${from.lat},${from.lon}` : ''}`;
  return { osm, google };
}

/** The campus a position is closest to, with its distance. */
export function nearestCampus(map, position) {
  let best = null;
  for (const campus of map?.campuses || []) {
    const metres = distanceMetres(position, { lat: campus.center[0], lon: campus.center[1] });
    if (!best || metres < best.metres) best = { campus, metres };
  }
  return best;
}

/** Everything a person might type in the search box: building codes and names, listed once. */
export function searchTerms(map) {
  const out = [];
  for (const c of map?.campuses || []) {
    for (const p of c.places) out.push({ label: `${p.name} · ${c.name}`, query: p.codes[0] && p.codes[0].length > 1 ? `${p.codes[0]} ${c.name}` : `${p.name} ${c.name}` });
    for (const u of c.unmapped || []) out.push({ label: `${u.name} · ${c.name}`, query: `${u.codes[0]} ${c.name}` });
  }
  return out;
}
