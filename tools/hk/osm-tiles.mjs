// tools/hk/osm-tiles.mjs
// Downloads the pilot area from the OpenStreetMap API in small tiles and writes the features the Hong Kong
// pipeline uses in Overpass's `out geom tags` shape, so the rest of the tools read it like any Overpass result.
// (The public Overpass servers time out on a dense Hong Kong box; the API's map call does not.)
//
// usage: node tools/hk/osm-tiles.mjs <raw dir> <out dir>
//   writes <out dir>/osm_hk_pilot.json (ways and park relations) and <out dir>/osm_hk_points.json (nodes)
//   tiles are cached in <raw dir>/osm-tiles/ so a rerun only fetches what is missing
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PILOT } from './hk-frame.mjs';

const [RAW, OUT] = process.argv.slice(2);
if (!RAW || !OUT) {
  console.error('usage: node tools/hk/osm-tiles.mjs <raw dir> <out dir>');
  process.exit(1);
}
const STEP = 0.01; // degrees per tile side: about 1 km, well under the API's 50,000-node limit here
const tileDir = path.join(RAW, 'osm-tiles');
fs.mkdirSync(tileDir, { recursive: true });

function fetchTile(w, s, e, n) {
  const file = path.join(tileDir, `${w.toFixed(3)}_${s.toFixed(3)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${w},${s},${e},${n}`;
  for (let i = 1; i <= 4; i++) {
    try {
      const body = execFileSync('curl', ['-sS', '-f', '-m', '300', '-A', 'hk-threejs-map/1.0 (three.js city sim)', url], { maxBuffer: 1 << 30 });
      const data = JSON.parse(body);
      if (!Array.isArray(data.elements)) throw new Error('no elements');
      fs.writeFileSync(file, body);
      console.log(`[osm] tile ${w.toFixed(3)},${s.toFixed(3)}: ${data.elements.length} elements`);
      return data;
    } catch (err) {
      console.log(`[osm] tile ${w},${s} try ${i}: ${err.message.split('\n')[0]}`);
      execFileSync('sleep', [String(i * 5)]);
    }
  }
  throw new Error(`tile ${w},${s} failed`);
}

const nodes = new Map();
const ways = new Map();
const rels = new Map();
const r3 = (v) => Math.round(v * 1000) / 1000;
for (let w = PILOT.west; w < PILOT.east - 1e-9; w = r3(w + STEP)) {
  for (let s = PILOT.south; s < PILOT.north - 1e-9; s = r3(s + STEP)) {
    const data = fetchTile(w, s, Math.min(r3(w + STEP), PILOT.east), Math.min(r3(s + STEP), PILOT.north));
    for (const el of data.elements) {
      const map = el.type === 'node' ? nodes : el.type === 'way' ? ways : rels;
      map.set(el.id, el);
    }
  }
}

// The same selection an Overpass query for the pilot would make
const WAY_TESTS = [
  (t) => t.highway,
  (t) => /^(tram|subway|light_rail|rail)$/.test(t.railway || ''),
  (t) => /^(park|garden|pitch|swimming_pool|playground|sports_centre|stadium|track)$/.test(t.leisure || ''),
  (t) => /^(grass|recreation_ground|forest|meadow)$/.test(t.landuse || ''),
  (t) => /^(water|wood|scrub|grassland|bare_rock)$/.test(t.natural || ''),
  (t) => /^(pier|breakwater)$/.test(t.man_made || ''),
  (t) => t.building && t.name
];
const REL_TESTS = [(t) => /^(park|garden)$/.test(t.leisure || ''), (t) => t.building && t.name];
const NODE_TESTS = [
  (t) => /^(station|tram_stop)$/.test(t.railway || ''),
  (t) => t.public_transport === 'station',
  (t) => t.amenity === 'ferry_terminal',
  (t) => /^(traffic_signals|crossing|bus_stop)$/.test(t.highway || ''),
  (t) => t.natural === 'tree'
];
// Tags the pipeline reads; the rest (addresses, network ids, translations) only bloat the committed extract
const KEEP = new Set(['name', 'name:en', 'name:zh', 'highway', 'service', 'junction', 'oneway', 'lanes', 'width', 'layer', 'level', 'bridge', 'tunnel',
  'covered', 'area', 'access', 'maxspeed', 'incline', 'railway', 'leisure', 'landuse', 'natural', 'man_made', 'sport', 'building', 'height',
  'building:levels', 'public_transport', 'amenity', 'crossing', 'ref', 'operator', 'species', 'leaf_type']);
const keepTags = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => KEEP.has(k)));
const inPilot = (lon, lat) => lon >= PILOT.west && lon <= PILOT.east && lat >= PILOT.south && lat <= PILOT.north;
const geom = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => ({ lat: n.lat, lon: n.lon }));

const elements = [];
for (const w of ways.values()) {
  const t = w.tags || {};
  if (!WAY_TESTS.some((f) => f(t))) continue;
  const g = geom(w);
  if (g.length < 2 || !g.some((p) => inPilot(p.lon, p.lat))) continue;
  elements.push({ type: 'way', id: w.id, nodes: w.nodes, geometry: g, tags: keepTags(t) });
}
for (const r of rels.values()) {
  const t = r.tags || {};
  if (!REL_TESTS.some((f) => f(t))) continue;
  const members = r.members.filter((m) => m.type === 'way' && ways.has(m.ref)).map((m) => ({ type: 'way', ref: m.ref, role: m.role, geometry: geom(ways.get(m.ref)) }));
  if (!members.length) continue;
  elements.push({ type: 'relation', id: r.id, members, tags: keepTags(t) });
}
const points = [];
for (const n of nodes.values()) {
  const t = n.tags;
  if (!t || !inPilot(n.lon, n.lat) || !NODE_TESTS.some((f) => f(t))) continue;
  points.push({ type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: keepTags(t) });
}
const sortById = (a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.id - b.id);
elements.sort(sortById);
points.sort(sortById);
const NOTE = 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.';
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'osm_hk_pilot.json'), JSON.stringify({ version: 0.6, osm3s: { copyright: NOTE }, elements }));
fs.writeFileSync(path.join(OUT, 'osm_hk_points.json'), JSON.stringify({ version: 0.6, osm3s: { copyright: NOTE }, elements: points }));
console.log(`[osm] ${elements.length} ways/relations, ${points.length} points`);
