import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hk1980Geographic, hk1980ToWgs84, wgs84ToHk1980, toWorld, fromWorld, worldToHk1980, hk1980ToWorld } from '../tools/hk/hk-frame.mjs';
import { pointInRing } from '../tools/hk/hk-geom.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('HK1980 Grid origin maps to the datum origin', () => {
  const [lon, lat] = hk1980Geographic(836694.05, 819069.8);
  assert.ok(Math.abs(lon - (114 + 10 / 60 + 42.8 / 3600)) < 1e-9);
  assert.ok(Math.abs(lat - (22 + 18 / 60 + 43.68 / 3600)) < 1e-8);
});

test('HK1980 to WGS 84 matches the Lands Department offsets and round-trips', () => {
  // LandsD: WGS 84 latitude is about 5.5" less and longitude about 8.8" more than HK1980 geographic
  for (const [e, n] of [[836694.05, 819069.8], [840000, 816000], [845000, 812000]]) {
    const [lon80, lat80] = hk1980Geographic(e, n);
    const [lon, lat] = hk1980ToWgs84(e, n);
    assert.ok(Math.abs((lat - lat80) * 3600 + 5.5) < 0.1, `latitude shift ${(lat - lat80) * 3600}"`);
    assert.ok(Math.abs((lon - lon80) * 3600 - 8.8) < 0.1, `longitude shift ${(lon - lon80) * 3600}"`);
    const [e2, n2] = wgs84ToHk1980(lon, lat);
    assert.ok(Math.hypot(e2 - e, n2 - n) < 0.01, 'grid round trip within a centimetre');
  }
  const [x, z] = hk1980ToWorld(...worldToHk1980(1234.5, -678.9));
  assert.ok(Math.hypot(x - 1234.5, z + 678.9) < 0.01, 'world round trip within a centimetre');
});

test('world frame is east/south metres around North Point', () => {
  assert.deepEqual(toWorld(114.2, 22.291), [0, 0]);
  const [x, z] = toWorld(114.21, 22.3);
  assert.ok(Math.abs(x - 1030) < 5 && Math.abs(z + 996) < 5, `${x}, ${z}`);
  const [lon, lat] = fromWorld(x, z);
  assert.ok(Math.abs(lon - 114.21) < 1e-9 && Math.abs(lat - 22.3) < 1e-9);
});

test('Hong Kong geodata rebuilds byte for byte from the committed extracts', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Hong Kong 香港 '));
  try {
    const out = path.join(dir, 'hk-geodata.js');
    const result = spawnSync(process.execPath, [path.join(root, 'tools/hk/build-hk-geodata.mjs'), out], { encoding: 'utf8', timeout: 120000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(path.join(root, 'js/hk-geodata.js'))), 'js/hk-geodata.js is stale: run node tools/hk/build-hk-geodata.mjs');
    const median = /median offset ([\d.]+) m/.exec(result.stdout);
    assert.ok(median && +median[1] < 2, `TD centreline lines up with OpenStreetMap streets (${median && median[1]} m)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Hong Kong geodata covers the Eastern District pilot', async () => {
  const { GEO } = await import(pathToFileURL(path.join(root, 'js/hk-geodata.js')).href);
  const ring = (a) => { const r = []; for (let i = 0; i < a.length; i += 2) r.push([a[i], a[i + 1]]); return r; };
  const onLand = (x, z) => GEO.land.some((g) => pointInRing(x, z, ring(g)));
  assert.ok(onLand(0, 0), 'the origin on King\'s Road is on land');
  assert.ok(!onLand(...toWorld(114.2, 22.296)), 'the harbour off North Point is sea');

  const names = new Set(GEO.roads.map((r) => r[0]));
  for (const n of ["KING'S ROAD", 'ISLAND EASTERN CORRIDOR', 'JAVA ROAD', 'ELECTRIC ROAD', 'TAIKOO SHING ROAD']) assert.ok(names.has(n), n);
  assert.ok(GEO.roads.some((r) => r[0] === 'ISLAND EASTERN CORRIDOR' && r[2] > 0), 'the corridor is elevated');
  assert.ok(GEO.roads.some((r) => r[3] === 1) && GEO.roads.some((r) => r[3] === 0), 'one-way and two-way roads');

  const { nodes, links } = GEO.roadGraph;
  assert.ok(links.length > 1000);
  for (const [a, b] of links) assert.ok(a * 2 < nodes.length && b * 2 < nodes.length && a !== b);

  assert.ok(GEO.buildings.length > 3000);
  const height = (name) => {
    const i = GEO.buildingNames.indexOf(name);
    return Math.max(...GEO.buildings.filter((b) => b[4] === i).map((b) => b[2] - b[1]));
  };
  assert.ok(Math.abs(height('One Island East') - 291) < 10, 'One Island East is about 298 m to the roof feature');
  for (const b of GEO.buildings) if (b[1] != null) assert.ok(b[2] > b[1]);

  const parks = new Set(GEO.parks.map((p) => p.name));
  for (const n of ['Victoria Park', 'Quarry Bay Park']) assert.ok(parks.has(n), n);
  assert.ok(GEO.piers.some((p) => /North Point/.test(p.name)));
  assert.ok(GEO.rail.some((r) => r.kind === 'tram'));
  for (const n of ['Tin Hau', 'Fortress Hill', 'North Point', 'Quarry Bay', 'Tai Koo']) assert.ok(GEO.points.stations.some((s) => s.name === n), n);

  const T = GEO.terrain.pilot;
  const buf = Buffer.from(T.data, 'base64');
  const h = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  assert.equal(h.length, T.cols * T.rows);
  const at = (x, z) => h[Math.round((z - T.z0) / T.cell) * T.cols + Math.round((x - T.x0) / T.cell)] / 10;
  assert.ok(at(0, 0) > 2 && at(0, 0) < 10, `King's Road is reclaimed land a few metres above datum (${at(0, 0)})`);
  assert.ok(T.max > 250, 'the hills behind reach well above 250 mPD');
});
