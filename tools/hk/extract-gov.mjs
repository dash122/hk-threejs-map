// tools/hk/extract-gov.mjs
// Cuts the pilot area out of the Hong Kong government downloads and writes the small extracts that are committed to
// tools/hk/data/ (the raw files are hundreds of megabytes and stay out of the repo):
//   td_centreline.json     Transport Department Road Network (2nd Generation) road centreline, WGS 84
//   landsd_buildings.json  Lands Department Building polygons with base and top levels (mPD), WGS 84
//   dtm_pilot.bin/.json    Lands Department 5 m Digital Terrain Model, pilot area, HK1980 Grid cells
//   dtm_backdrop.bin/.json the same model averaged to 25 m over the backdrop
// Terrain rasters are little-endian Int16 heights in decimetres above Principal Datum, row 0 = north, -32768 = none.
//
// usage: node tools/hk/extract-gov.mjs <raw dir> <out dir>
//   <raw dir> holds CENTERLINE.gml, landsd_building.geojson and Whole_HK_DTM_5m.asc (see fetch-hk-data.sh)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PILOT, BACKDROP, hk1980ToWgs84, wgs84ToHk1980 } from './hk-frame.mjs';
import { rdp } from './hk-geom.mjs';

const [RAW, OUT] = process.argv.slice(2);
if (!RAW || !OUT) {
  console.error('usage: node tools/hk/extract-gov.mjs <raw dir> <out dir>');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[gov]', ...a);
const r7 = (v) => Math.round(v * 1e7) / 1e7;

// Margin around the pilot box (degrees, about 300 m) so roads and buildings on its edge are complete
const M = 0.003;
const near = (lon, lat) => lon > PILOT.west - M && lon < PILOT.east + M && lat > PILOT.south - M && lat < PILOT.north + M;

// HK1980 Grid rectangle that covers a lon/lat box
function gridRect(b, pad = 0) {
  const c = [[b.west, b.south], [b.east, b.south], [b.west, b.north], [b.east, b.north]].map(([lon, lat]) => wgs84ToHk1980(lon, lat));
  return { e0: Math.min(...c.map((p) => p[0])) - pad, e1: Math.max(...c.map((p) => p[0])) + pad, n0: Math.min(...c.map((p) => p[1])) - pad, n1: Math.max(...c.map((p) => p[1])) + pad };
}

// --- TD road centreline (CityGML GenericCityObject, EPSG:2326) --------------------------------------------------------
async function centreline() {
  const file = path.join(RAW, 'CENTERLINE.gml');
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  const features = [];
  let cur = null, attr = null, total = 0;
  for await (const line of rl) {
    if (line.startsWith('<gen:GenericCityObject')) { cur = {}; continue; }
    if (!cur) continue;
    let m;
    if ((m = /^<gen:(?:int|string|double)Attribute name="([A-Z_a-z]+)"/.exec(line))) attr = m[1];
    else if (attr && (m = /^<gen:value>(.*)<\/gen:value>/.exec(line))) { cur[attr] = m[1]; attr = null; }
    else if ((m = /<gml:posList[^>]*>([^<]*)<\/gml:posList>/.exec(line))) cur.pos = (cur.pos ? cur.pos + ' ' : '') + m[1];
    else if (line.startsWith('</gen:GenericCityObject>')) {
      total++;
      const v = (cur.pos || '').trim().split(/\s+/).map(Number);
      const grid = [];
      for (let i = 0; i + 1 < v.length; i += 2) grid.push([v[i], v[i + 1]]);
      const pts = [];
      let hit = false;
      // some pieces carry tens of thousands of millimetre-spaced vertices: simplify in grid metres first
      for (const [e, n] of rdp(grid, 0.15)) {
        const [lon, lat] = hk1980ToWgs84(e, n);
        if (near(lon, lat)) hit = true;
        pts.push(r7(lon), r7(lat));
      }
      if (hit) {
        const name = cur.STREET_ENAME && cur.STREET_ENAME !== '-99' ? cur.STREET_ENAME : '';
        features.push({
          id: +cur.ROUTE_ID, name, cname: name ? cur.STREET_CNAME || '' : '', elev: +cur.ELEVATION || 0,
          // 1: both ways, 3: one way in the digitised direction
          dir: +cur.TRAVEL_DIRECTION === 3 ? 1 : 0, st: +cur.ST_CODE || 0, route: cur.ROUTE_NUM ? +cur.ROUTE_NUM : 0,
          exit: cur.EXIT_NUM || '', remarks: cur.REMARKS || '', pts
        });
      }
      cur = null;
    }
  }
  features.sort((a, b) => a.id - b.id);
  const out = {
    source: 'Transport Department, Road Network (2nd Generation), CENTERLINE.gml, via DATA.GOV.HK',
    fields: { id: 'ROUTE_ID', name: 'STREET_ENAME', cname: 'STREET_CNAME', elev: 'ELEVATION (0 ground, >0 flyover, <0 underground)', dir: '0 two-way, 1 one-way along pts', st: 'ST_CODE', route: 'ROUTE_NUM', exit: 'EXIT_NUM', pts: 'lon, lat, ... (WGS 84)' },
    features
  };
  fs.writeFileSync(path.join(OUT, 'td_centreline.json'), JSON.stringify(out));
  log(`centreline: ${features.length} of ${total} pieces near the pilot`);
}

// --- LandsD buildings (CSDI WFS GeoJSON, WGS 84) -----------------------------------------------------------------------
function buildings() {
  const src = JSON.parse(fs.readFileSync(path.join(RAW, 'landsd_building.geojson'), 'utf8'));
  const features = [];
  for (const f of src.features) {
    const p = f.properties;
    if (p.Status && p.Status !== 'Active') continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const rings = polys.map((poly) => poly.map((ring) => ring.flatMap(([lon, lat]) => [r7(lon), r7(lat)])));
    features.push({
      id: p.BuildingCSUID || String(p.BuildingID), type: p.BuildingBlockType || '', name: p.BuildingNameEN || '', cname: p.BuildingNameTC || '',
      base: p.BaseHeight ?? null, top: p.TopHeight ?? null, storeys: p.Storeys ?? null, basement: p.StoreysInBasement ?? null, polys: rings
    });
  }
  features.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = {
    source: 'Lands Department, Building (iB1000), CSDI Portal WFS landsd_rcd_1637211194312_35158',
    fields: { type: 'BuildingBlockType', base: 'BaseHeight (mPD)', top: 'TopHeight (mPD)', storeys: 'Storeys', polys: 'polygons of rings of lon, lat, ...' },
    features
  };
  fs.writeFileSync(path.join(OUT, 'landsd_buildings.json'), JSON.stringify(out));
  log(`buildings: ${features.length} (${features.filter((f) => f.top == null).length} without a top level)`);
}

// --- LandsD 5 m DTM (ESRI ASCII grid, EPSG:2326) ----------------------------------------------------------------------
async function terrain() {
  const file = path.join(RAW, 'Whole_HK_DTM_5m.asc');
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  const hdr = {};
  const pilot = gridRect(PILOT, 50);
  const back = gridRect(BACKDROP, 50);
  const BACK = 5; // cells averaged per side for the backdrop (25 m)
  let row = -1, grids = null;
  for await (const line of rl) {
    if (row < 0) {
      const m = /^(\w+)\s+(-?[\d.]+)/.exec(line);
      if (m && Object.keys(hdr).length < 6) { hdr[m[1].toLowerCase()] = +m[2]; if (Object.keys(hdr).length < 6) continue; }
      // header complete: set up the two output grids, aligned to the source cells
      const { ncols, nrows, xllcorner, yllcorner, cellsize } = hdr;
      const top = yllcorner + nrows * cellsize;
      const mk = (r, step) => {
        const c0 = Math.max(0, Math.floor((r.e0 - xllcorner) / cellsize / step) * step);
        const c1 = Math.min(ncols, Math.ceil((r.e1 - xllcorner) / cellsize / step) * step);
        const r0 = Math.max(0, Math.floor((top - r.n1) / cellsize / step) * step);
        const r1 = Math.min(nrows, Math.ceil((top - r.n0) / cellsize / step) * step);
        const w = (c1 - c0) / step, h = (r1 - r0) / step;
        return { c0, c1, r0, r1, step, w, h, sum: new Float64Array(w * h), cnt: new Uint16Array(w * h), e0: xllcorner + c0 * cellsize, n1: top - r0 * cellsize, cell: cellsize * step };
      };
      grids = { pilot: mk(pilot, 1), backdrop: mk(back, BACK) };
      row = 0;
      if (m) continue;
    }
    for (const g of Object.values(grids)) {
      if (row < g.r0 || row >= g.r1) continue;
      const vals = line.split(' ');
      const j = Math.floor((row - g.r0) / g.step);
      for (let c = g.c0; c < g.c1; c++) {
        const v = +vals[c];
        if (v === hdr.nodata_value || Number.isNaN(v)) continue;
        const k = j * g.w + Math.floor((c - g.c0) / g.step);
        g.sum[k] += v;
        g.cnt[k]++;
      }
    }
    row++;
    if (row >= Math.max(grids.pilot.r1, grids.backdrop.r1)) break;
  }
  rl.close();
  for (const [name, g] of Object.entries(grids)) {
    const buf = Buffer.alloc(g.w * g.h * 2);
    for (let k = 0; k < g.w * g.h; k++) buf.writeInt16LE(g.cnt[k] ? Math.round((g.sum[k] / g.cnt[k]) * 10) : -32768, k * 2);
    fs.writeFileSync(path.join(OUT, `dtm_${name}.bin`), buf);
    const meta = {
      source: 'Lands Department, 5m Digital Terrain Model (Whole_HK_DTM_5m.asc), via DATA.GOV.HK',
      crs: 'EPSG:2326', units: 'decimetres above Hong Kong Principal Datum, Int16 little-endian, -32768 = no data',
      cols: g.w, rows: g.h, cell: g.cell, west: g.e0, north: g.n1, rowOrder: 'north to south'
    };
    fs.writeFileSync(path.join(OUT, `dtm_${name}.json`), JSON.stringify(meta, null, 1) + '\n');
    log(`terrain ${name}: ${g.w} x ${g.h} cells of ${g.cell} m`);
  }
}

const only = process.env.HK_EXTRACT ? new Set(process.env.HK_EXTRACT.split(',')) : null;
if (!only || only.has('buildings')) buildings();
if (!only || only.has('terrain')) await terrain();
if (!only || only.has('centreline')) await centreline();
