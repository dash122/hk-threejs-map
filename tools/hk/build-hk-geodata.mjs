// tools/hk/build-hk-geodata.mjs
// Builds js/hk-geodata.js: the Eastern District pilot's real geography in the simulation's 1:1 world frame
// (tools/hk/hk-frame.mjs: 1 unit = 1 m, x = east, z = south, y = metres above Principal Datum, origin North Point).
//
// Inputs, the committed pilot extracts in tools/hk/data/ (tools/hk/fetch-hk-data.sh rewrites them):
//   td_centreline.json     TD Road Network (2nd Generation) centreline: roads, levels, one-way direction, road graph
//   landsd_buildings.json  LandsD Building polygons with base and top levels: real footprints and heights
//   dtm_*.bin / .json      LandsD 5 m Digital Terrain Model: ground height
//   osm_hk_coast.json      OpenStreetMap coastline: land and sea
//   osm_hk_pilot.json      OpenStreetMap streets (lanes, widths), parks, piers, rail, named buildings
//   osm_hk_points.json     OpenStreetMap stations, stops, signals, crossings, trees
//
// usage: node tools/hk/build-hk-geodata.mjs [outFile]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT, BACKDROP, LAT0, LON0, toWorld, worldToHk1980 } from './hk-frame.mjs';
import { ringArea, bbox, rdp, rdpRing, pointInRing, segDist, polylineLength } from './hk-geom.mjs';

const DATA = process.env.HK_DATA || fileURLToPath(new URL('data/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../../js/hk-geodata.js', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const log = (...a) => console.log('[hk-geodata]', ...a);
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
const pairs = (a) => { const o = []; for (let i = 0; i + 1 < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; };
const lonlat = (a) => pairs(a).map(([lon, lat]) => toWorld(lon, lat));
const rect = (b) => {
  const [x0, z1] = toWorld(b.west, b.south);
  const [x1, z0] = toWorld(b.east, b.north);
  return { x0, x1, z0, z1 };
};
const PR = rect(PILOT);
const BR = rect(BACKDROP);
const inRect = (r, [x, z], m = 0) => x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m;
const roundRect = (r) => ({ minX: q(r.x0), maxX: q(r.x1), minZ: q(r.z0), maxZ: q(r.z1) });
log(`pilot ${q(PR.x1 - PR.x0)} x ${q(PR.z1 - PR.z0)} m, backdrop ${q(BR.x1 - BR.x0)} x ${q(BR.z1 - BR.z0)} m`);

// =====================================================================================================================
// Land: OSM coastline ways (land on their left) chained, clipped to the backdrop and closed along its edge
// =====================================================================================================================
function chainWays(ways) {
  const byStart = new Map();
  for (const w of ways) byStart.set(w.nodes[0], w);
  const hasPrev = new Set(ways.map((w) => w.nodes[w.nodes.length - 1]));
  const used = new Set();
  const chains = [];
  const walk = (first) => {
    const pts = [];
    let cur = first;
    while (cur && !used.has(cur.id)) {
      used.add(cur.id);
      const g = cur.geometry.map((p) => toWorld(p.lon, p.lat));
      pts.push(...(pts.length ? g.slice(1) : g));
      cur = byStart.get(cur.nodes[cur.nodes.length - 1]);
    }
    return pts;
  };
  for (const w of ways) if (!hasPrev.has(w.nodes[0])) chains.push(walk(w)); // open chains from their real start
  for (const w of ways) if (!used.has(w.id)) chains.push(walk(w)); // closed loops (islands)
  return chains;
}
// Clip a polyline to a rectangle: the pieces inside, with exact entry/exit points on the edge
function clipLine(pts, r) {
  const pieces = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dz = bz - az;
    let ok = true;
    for (const [p, qq] of [[-dx, ax - r.x0], [dx, r.x1 - ax], [-dz, az - r.z0], [dz, r.z1 - az]]) {
      if (p === 0) { if (qq < 0) { ok = false; break; } continue; }
      const t = qq / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { if (cur) { pieces.push(cur); cur = null; } continue; }
    const A = [ax + t0 * dx, az + t0 * dz], B = [ax + t1 * dx, az + t1 * dz];
    if (!cur) cur = [A];
    else if (t0 > 0) { pieces.push(cur); cur = [A]; }
    cur.push(B);
    if (t1 < 1) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length > 1);
}
// Position of an edge point along the rectangle's perimeter, clockwise on screen (x east, z south): top edge
// west to east, right edge north to south, bottom east to west, left south to north.
function perim([x, z], r) {
  const W = r.x1 - r.x0, H = r.z1 - r.z0, e = 1e-6;
  if (Math.abs(z - r.z0) < e) return x - r.x0;
  if (Math.abs(x - r.x1) < e) return W + (z - r.z0);
  if (Math.abs(z - r.z1) < e) return W + H + (r.x1 - x);
  return 2 * W + H + (r.z1 - z);
}
function cornerAt(s, r) {
  const W = r.x1 - r.x0, H = r.z1 - r.z0;
  const P = 2 * (W + H);
  s = ((s % P) + P) % P;
  if (s < W) return [r.x0 + s, r.z0];
  if (s < W + H) return [r.x1, r.z0 + s - W];
  if (s < 2 * W + H) return [r.x1 - (s - W - H), r.z1];
  return [r.x0, r.z1 - (s - 2 * W - H)];
}
function landPolygons(osm, r) {
  const chains = chainWays(osm.elements.filter((e) => e.type === 'way' && e.geometry));
  const rings = [];
  const open = [];
  for (const c of chains) {
    const closed = Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]) < 0.5;
    if (closed && c.every((p) => inRect(r, p))) { rings.push(c.slice(0, -1)); continue; }
    open.push(...clipLine(c, r));
  }
  // Join the open pieces along the edge. With land on the left of the coastline and z pointing south, land lies to
  // the right on screen, so from a piece's exit the land boundary turns counter-clockwise (decreasing perimeter).
  const W = r.x1 - r.x0, H = r.z1 - r.z0, P = 2 * (W + H);
  const CORNERS = [0, W, W + H, 2 * W + H];
  const pieces = open.map((p) => ({ pts: p, sIn: perim(p[0], r), sOut: perim(p[p.length - 1], r), used: false }));
  for (const start of pieces) {
    if (start.used) continue;
    const ring = [];
    let cur = start;
    for (let guard = 0; guard < 10000 && cur && !cur.used; guard++) {
      cur.used = true;
      ring.push(...cur.pts);
      // next entry going backwards along the perimeter from the exit
      const back = (s) => ((cur.sOut - s) % P + P) % P;
      let next = null, best = Infinity;
      for (const p of pieces) {
        const d = back(p.sIn);
        if ((!p.used || p === start) && d < best) { best = d; next = p; }
      }
      if (!next) break;
      // corners passed on the way
      for (const c of [...CORNERS].sort((a, b) => back(a) - back(b))) if (back(c) > 0 && back(c) < best) ring.push(cornerAt(c, r));
      if (next === start) break;
      cur = next;
    }
    if (ring.length > 2) rings.push(ring);
  }
  // land rings run clockwise on screen (x east, z south): positive area in this frame's formula
  return rings.filter((g) => Math.abs(ringArea(g)) > 2000).map((g) => (ringArea(g) < 0 ? g.reverse() : g));
}
const land = landPolygons(load('osm_hk_coast.json'), BR);
const landArea = land.reduce((t, g) => t + Math.abs(ringArea(g)), 0);
log(`land: ${land.length} polygons, ${(landArea / 1e6).toFixed(1)} km² of ${((BR.x1 - BR.x0) * (BR.z1 - BR.z0) / 1e6).toFixed(1)} km² backdrop`);

// =====================================================================================================================
// OSM features
// =====================================================================================================================
const osm = load('osm_hk_pilot.json').elements;
const osmPts = load('osm_hk_points.json').elements;
const en = (t) => t['name:en'] || (t.name && /[A-Za-z]/.test(t.name) ? t.name.replace(/^[^A-Za-z]*/, '') : '') || '';
const zh = (t) => t['name:zh'] || (t.name && /[一-鿿]/.test(t.name) ? t.name.split(/\s+[A-Za-z]/)[0] : '') || '';
const wayPts = (e) => (e.geometry || []).map((g) => toWorld(g.lon, g.lat));
function elemRings(e) {
  if (e.type === 'way') return [wayPts(e)];
  const parts = (e.members || []).filter((m) => m.role === 'outer' && m.geometry && m.geometry.length).map((m) => m.geometry.map((g) => toWorld(g.lon, g.lat)));
  const rings = [];
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 500 && !close(ring[0], ring[ring.length - 1]); guard++) {
      const i = parts.findIndex((p) => close(p[0], ring[ring.length - 1]) || close(p[p.length - 1], ring[ring.length - 1]));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(close(p[0], ring[ring.length - 1]) ? p.slice(1) : p.reverse().slice(1));
    }
    rings.push(ring);
  }
  return rings;
}
const closedRing = (r) => r.length > 3 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.5;
const ringOut = (r, eps = 0.5) => flat(rdpRing(r.slice(0, -1), eps));

// Car roads in OSM, for lanes and widths (the TD centreline has neither)
const CAR = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/;
const osmRoads = osm.filter((e) => e.type === 'way' && CAR.test(e.tags.highway || '')).map((e) => ({ t: e.tags, pts: wayPts(e), name: en(e.tags).toUpperCase() }));
const cellOf = (x, z) => `${Math.floor(x / 50)},${Math.floor(z / 50)}`;
const roadCells = new Map();
osmRoads.forEach((r, i) => {
  for (const [x, z] of r.pts) {
    const k = cellOf(x, z);
    if (!roadCells.has(k)) roadCells.set(k, new Set());
    roadCells.get(k).add(i);
  }
});
function nearestOsmRoad(x, z, name) {
  let best = null, bd = 25;
  const cx = Math.floor(x / 50), cz = Math.floor(z / 50);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const i of roadCells.get(`${cx + dx},${cz + dz}`) || []) {
      const r = osmRoads[i];
      let d = Infinity;
      for (let k = 1; k < r.pts.length; k++) d = Math.min(d, segDist(x, z, ...r.pts[k - 1], ...r.pts[k]));
      if (name && r.name === name) d -= 8; // prefer the same street within a few metres
      if (d < bd) { bd = d; best = r; }
    }
  }
  return best;
}

// =====================================================================================================================
// Roads and the road graph from the TD centreline
// =====================================================================================================================
const td = load('td_centreline.json').features;
const LANE_W = 3.3;
const roads = [];
const offsets = [];
const defaults = { motorway: 3, trunk: 3, primary: 2, secondary: 2, tertiary: 2, residential: 1, service: 1, unclassified: 1 };
for (const f of td) {
  const pts = lonlat(f.pts);
  if (pts.length < 2 || !pts.some((p) => inRect(PR, p, 150))) continue;
  const mid = pts[Math.floor(pts.length / 2)];
  const m = nearestOsmRoad(...mid, f.name);
  const cls = m ? m.t.highway.replace('_link', '') : '';
  let lanes = m && m.t.lanes ? parseInt(m.t.lanes, 10) : 0;
  // OSM counts both directions of a single two-way carriageway; the TD line carries both in that case too
  if (!lanes) lanes = (defaults[cls] || 1) * (f.dir ? 1 : 2);
  lanes = Math.max(1, Math.min(lanes, 6));
  const width = m && m.t.width ? parseFloat(m.t.width) : lanes * LANE_W + (f.dir ? 0.6 : 1);
  if (m && m.name && m.name === f.name) {
    let d = Infinity;
    for (let k = 1; k < m.pts.length; k++) d = Math.min(d, segDist(...mid, ...m.pts[k - 1], ...m.pts[k]));
    offsets.push(d);
  }
  roads.push({ id: f.id, name: f.name, cname: f.cname, level: f.elev, dir: f.dir, lanes, width: q(width), cls, maxspeed: m && m.t.maxspeed ? parseInt(m.t.maxspeed, 10) : 0, pts: rdp(pts, 0.3) });
}
offsets.sort((a, b) => a - b);
log(`roads: ${roads.length} TD pieces; ${offsets.length} matched to the same OSM street, median offset ${offsets[offsets.length >> 1]?.toFixed(2)} m, 90th percentile ${offsets[Math.floor(offsets.length * 0.9)]?.toFixed(2)} m`);

function buildRoadGraph() {
  const MERGE = 1.0;
  const nodes = [];
  const cells = new Map();
  function nodeAt(x, z) {
    const ix = Math.floor(x / MERGE), iz = Math.floor(z / MERGE);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const id of cells.get(`${ix + dx},${iz + dz}`) || []) if (Math.hypot(nodes[id][0] - x, nodes[id][1] - z) <= MERGE) return id;
    }
    nodes.push([x, z]);
    const k = `${ix},${iz}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(nodes.length - 1);
    return nodes.length - 1;
  }
  const names = [];
  const nameIds = new Map();
  const nameId = (n) => {
    if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); }
    return nameIds.get(n);
  };
  const links = [];
  for (const r of roads) {
    if (r.level < 0 && /TUNNEL/.test(r.name)) continue; // the harbour tunnels leave the area underground
    const a = nodeAt(...r.pts[0]);
    const b = nodeAt(...r.pts[r.pts.length - 1]);
    if (a === b) continue;
    links.push([a, b, nameId(r.name), r.width, r.lanes, r.dir, r.pts.slice(1, -1), r.level]);
  }
  const used = new Map();
  const outNodes = [];
  const idOf = (i) => {
    if (!used.has(i)) { used.set(i, outNodes.length / 2); outNodes.push(q(nodes[i][0]), q(nodes[i][1])); }
    return used.get(i);
  };
  const outLinks = links.map(([a, b, n, w, lanes, dir, inner, level]) => [idOf(a), idOf(b), n, w, lanes, dir, flat(inner), level]);
  // connected components, to report islands of road the traffic can't leave
  const adj = new Map();
  for (const [a, b] of outLinks) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const seen = new Set();
  const sizes = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    let n = 0;
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const v = stack.pop();
      n++;
      for (const w of adj.get(v)) if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
    sizes.push(n);
  }
  sizes.sort((a, b) => b - a);
  log(`road graph: ${outNodes.length / 2} nodes, ${outLinks.length} links, ${names.length} names; largest component ${sizes[0]} nodes of ${sizes.reduce((t, v) => t + v, 0)}`);
  return { nodes: outNodes, links: outLinks, names };
}
const roadGraph = buildRoadGraph();

// =====================================================================================================================
// Buildings: LandsD footprints and levels
// =====================================================================================================================
const BLOCK_TYPES = ['Tower', 'Podium', 'Open-sided Structure', 'Temporary Structure'];
const osmNamed = osm.filter((e) => e.tags.building && e.tags.name).flatMap((e) => elemRings(e).filter(closedRing).map((r) => ({ t: e.tags, r })));
const buildingNames = [];
const bNameIds = new Map();
const bNameId = (n) => {
  if (!n) return -1;
  if (!bNameIds.has(n)) { bNameIds.set(n, buildingNames.length); buildingNames.push(n); }
  return bNameIds.get(n);
};
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
const buildings = [];
let estimated = 0;
for (const f of load('landsd_buildings.json').features) {
  for (const poly of f.polys) {
    const outer = lonlat(poly[0]);
    if (outer.length < 4) continue;
    const c = outer.reduce((s, p) => [s[0] + p[0] / outer.length, s[1] + p[1] / outer.length], [0, 0]);
    if (!inRect(PR, c)) continue;
    const area = Math.abs(ringArea(outer));
    if (area < 4) continue;
    let base = f.base, top = f.top;
    // LandsD names are upper case ("AIA TOWER"): take OSM's spelling where it names the same building, and OSM's name
    // where LandsD has none
    const o = osmNamed.find(({ r }) => pointInRing(c[0], c[1], r));
    const osmName = o ? en(o.t) : '';
    const name = f.name ? (osmName.toUpperCase() === f.name.toUpperCase() ? osmName : titleCase(f.name)) : osmName;
    if (top == null || base == null || top <= base) {
      // no surveyed top: storeys if known, else a low structure
      base = base ?? null;
      const h = f.storeys ? f.storeys * 3.1 : f.type === 'Open-sided Structure' ? 4 : 6;
      top = base == null ? null : base + h;
      estimated++;
    }
    const ring = rdpRing(outer.slice(0, -1), 0.25);
    if (ringArea(ring) < 0) ring.reverse();
    const holes = poly.slice(1).map((h) => lonlat(h)).filter((h) => h.length > 3 && Math.abs(ringArea(h)) > 4).map((h) => flat(rdpRing(h.slice(0, -1), 0.25)));
    buildings.push([flat(ring), base == null ? null : q(base), top == null ? null : q(top), Math.max(0, BLOCK_TYPES.indexOf(f.type)), bNameId(name), holes.length ? holes : 0]);
  }
}
log(`buildings: ${buildings.length} footprints, ${estimated} with estimated tops, ${buildingNames.length} names; tallest ${Math.max(...buildings.map((b) => (b[2] ?? 0) - (b[1] ?? 0))).toFixed(0)} m`);

// =====================================================================================================================
// Parks, water, piers, rail
// =====================================================================================================================
const PARK_CAT = { park: 'park', garden: 'garden', pitch: 'pitch', swimming_pool: 'pool', playground: 'playground', sports_centre: 'sports', stadium: 'sports', track: 'track' };
const parks = [];
for (const e of osm) {
  const t = e.tags;
  const cat = PARK_CAT[t.leisure] || (t.landuse && /^(grass|recreation_ground|meadow)$/.test(t.landuse) ? 'grass' : '') ||
    (t.landuse === 'forest' || t.natural === 'wood' ? 'wood' : '') || (/^(scrub|grassland)$/.test(t.natural || '') ? 'scrub' : '') ||
    (t.natural === 'water' ? 'water' : '') || (t.natural === 'bare_rock' ? 'rock' : '');
  if (!cat || t.highway || t.building) continue;
  const rings = elemRings(e).filter(closedRing).filter((r) => r.some((p) => inRect(PR, p)) && Math.abs(ringArea(r)) > 25);
  if (!rings.length) continue;
  parks.push({ name: en(t), cat, rings: rings.map((r) => ringOut(r)) });
}
parks.sort((a, b) => (a.cat < b.cat ? -1 : a.cat > b.cat ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
log(`parks and green: ${parks.length} (${parks.filter((p) => p.cat === 'park').map((p) => p.name).filter(Boolean).slice(0, 8).join(', ')}, ...)`);

const piers = osm.filter((e) => /^(pier|breakwater)$/.test(e.tags.man_made || '')).flatMap((e) => {
  const r = wayPts(e);
  if (!r.some((p) => inRect(PR, p, 100))) return [];
  return [closedRing(r) ? { name: en(e.tags), kind: e.tags.man_made, ring: ringOut(r, 0.3) } : { name: en(e.tags), kind: e.tags.man_made, line: flat(rdp(r, 0.3)) }];
});
log(`piers: ${piers.length} (${piers.map((p) => p.name).filter(Boolean).join(', ')})`);

const rail = osm.filter((e) => e.type === 'way' && /^(tram|subway|light_rail|rail)$/.test(e.tags.railway || '')).map((e) => ({
  kind: e.tags.railway, name: en(e.tags), layer: parseInt(e.tags.layer || '0', 10), tunnel: e.tags.tunnel ? 1 : 0, pts: flat(rdp(wayPts(e), 0.3))
}));
log(`rail: ${rail.filter((r) => r.kind === 'tram').length} tram ways, ${rail.filter((r) => r.kind === 'subway').length} MTR ways`);

// Footpaths and steps (pedestrian routes; the TD centreline only has roads)
const FOOT = /^(footway|pedestrian|steps|path|cycleway|living_street)$/;
const footways = osm.filter((e) => e.type === 'way' && FOOT.test(e.tags.highway || '') && e.tags.area !== 'yes').map((e) => ({ kind: e.tags.highway, level: parseInt(e.tags.layer || e.tags.level || '0', 10) || 0, covered: e.tags.covered === 'yes' ? 1 : 0, bridge: e.tags.bridge ? 1 : 0, pts: rdp(wayPts(e), 0.3) }))
  .filter((f) => f.pts.length > 1 && f.pts.some((p) => inRect(PR, p)) && polylineLength(f.pts) > 2)
  .map((f) => [f.kind, f.level, f.bridge, f.covered, flat(f.pts)]);
log(`footways: ${footways.length}`);

// =====================================================================================================================
// Points: stations, stops, ferry piers, signals, crossings, trees
// =====================================================================================================================
const points = { stations: [], tramStops: [], busStops: [], ferry: [], signals: [], crossings: [], trees: [] };
for (const n of osmPts) {
  const t = n.tags;
  const [x, z] = toWorld(n.lon, n.lat).map(q);
  if (t.railway === 'station' || (t.public_transport === 'station' && !t.railway)) points.stations.push({ name: en(t), zh: zh(t), x, z });
  else if (t.railway === 'tram_stop') points.tramStops.push({ name: en(t), x, z });
  else if (t.highway === 'bus_stop') points.busStops.push({ name: en(t), x, z });
  else if (t.amenity === 'ferry_terminal') points.ferry.push({ name: en(t), x, z });
  else if (t.highway === 'traffic_signals') points.signals.push(x, z);
  else if (t.highway === 'crossing') points.crossings.push(x, z);
  else if (t.natural === 'tree') points.trees.push(x, z);
}
log(`points: ${points.stations.length} stations, ${points.tramStops.length} tram stops, ${points.busStops.length} bus stops, ${points.signals.length / 2} signals, ${points.trees.length / 2} trees`);

// =====================================================================================================================
// Terrain: resample the HK1980 Grid DTM onto world-aligned grids (bilinear), heights in decimetres
// =====================================================================================================================
function loadDtm(name) {
  const meta = load(`dtm_${name}.json`);
  const buf = fs.readFileSync(path.join(DATA, `dtm_${name}.bin`));
  const v = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  // cell centres: column i at west + (i + 0.5) * cell, row j at north - (j + 0.5) * cell
  return (e, n) => {
    const fx = (e - meta.west) / meta.cell - 0.5, fy = (meta.north - n) / meta.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i + 1 >= meta.cols || j + 1 >= meta.rows) return null;
    const tx = fx - i, ty = fy - j;
    const s = [v[j * meta.cols + i], v[j * meta.cols + i + 1], v[(j + 1) * meta.cols + i], v[(j + 1) * meta.cols + i + 1]];
    if (s.some((h) => h === -32768)) { const ok = s.filter((h) => h !== -32768); return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null; }
    return (s[0] * (1 - tx) + s[1] * tx) * (1 - ty) + (s[2] * (1 - tx) + s[3] * tx) * ty;
  };
}
function heightGrid(sample, r, cell) {
  const x0 = Math.floor(r.x0 / cell) * cell, z0 = Math.floor(r.z0 / cell) * cell;
  const cols = Math.ceil((r.x1 - x0) / cell) + 1, rows = Math.ceil((r.z1 - z0) / cell) + 1;
  const h = new Int16Array(cols * rows);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const v = sample(...worldToHk1980(x0 + i * cell, z0 + j * cell));
    const d = v == null ? 0 : Math.round(v);
    h[j * cols + i] = d;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { x0, z0, cell, cols, rows, min: lo / 10, max: hi / 10, units: 'dm', data: Buffer.from(h.buffer).toString('base64') };
}
const terrain = {
  // grid vertex (i, j) is at x = x0 + i * cell, z = z0 + j * cell; data = base64 Int16 little-endian decimetres, row-major
  pilot: heightGrid(loadDtm('pilot'), { x0: PR.x0 - 40, x1: PR.x1 + 40, z0: PR.z0 - 40, z1: PR.z1 + 40 }, 10),
  backdrop: heightGrid(loadDtm('backdrop'), BR, 50)
};
log(`terrain: pilot ${terrain.pilot.cols} x ${terrain.pilot.rows} at 10 m (${terrain.pilot.min} to ${terrain.pilot.max} mPD), backdrop ${terrain.backdrop.cols} x ${terrain.backdrop.rows} at 50 m (up to ${terrain.backdrop.max} mPD)`);

// =====================================================================================================================
// Assemble
// =====================================================================================================================
const GEO = {
  version: 1,
  frame: { origin: { lat: LAT0, lon: LON0, label: "King's Road by Java Road, North Point" }, units: 'm', axes: 'x east, z south (north = -z), y metres above Principal Datum' },
  pilot: roundRect(PR),
  backdrop: roundRect(BR),
  land: land.map((g) => flat(rdpRing(g, 0.8))),
  // [English name, Chinese name, level (0 ground, >0 flyover, <0 underground), one-way along pts (1) or two-way (0),
  //  travel lanes, carriageway width (m), OSM class, speed limit (km/h, 0 unknown), [x, z, ...]]
  roads: roads.map((r) => [r.name, r.cname, r.level, r.dir, r.lanes, r.width, r.cls, r.maxspeed, flat(r.pts)]),
  // Same layout as GEO.roadGraph in js/nyc-geodata.js, plus each link's level: links [node a, node b, name index,
  // width, lanes, direction (1: a -> b, 0: both), inner shape points [x, z, ...], level]
  roadGraph,
  // [outline [x, z, ...] (clockwise on screen), base level (mPD), top level (mPD), type (index into buildingTypes),
  //  name (index into buildingNames, -1 none), holes [[x, z, ...], ...] | 0]
  buildingTypes: BLOCK_TYPES,
  buildingNames,
  buildings,
  parks,
  piers,
  rail,
  // [kind, level, on a bridge, covered, [x, z, ...]]
  footways,
  points,
  terrain
};
const json = JSON.stringify(GEO);
const header = `// js/hk-geodata.js — GENERATED by tools/hk/build-hk-geodata.mjs, do not edit by hand.
// Real Hong Kong geography (Eastern District pilot) in the simulation's world frame: 1 unit = 1 m, x = east,
// z = south, y = metres above Principal Datum, origin on King's Road by Java Road, North Point (${LAT0}° N, ${LON0}° E).
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Sources: Transport Department Road Network (2nd Generation) and Lands Department Building and 5 m Digital Terrain
// Model (DATA.GOV.HK / CSDI Portal); coastline, parks, piers, rail, footways, lanes & points © OpenStreetMap
// contributors (ODbL).
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
