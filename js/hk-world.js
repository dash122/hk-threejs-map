import * as THREE from 'three/webgpu';
import {
  Fn, attribute, color, float, vec2, texture, uv, positionWorld, normalWorldGeometry, cameraPosition,
  mix, step, smoothstep, fract, floor, abs, max, min, clamp, sin, dot, normalize, pow, fwidth
} from 'three/tsl';
import { cityUniforms, createWaterMaterial, createRoadSurfaceMaterial } from './tsl-materials.js';
import { GEO } from './hk-geodata.js';

// js/hk-world.js
// The Hong Kong scene (Eastern District pilot) built from js/hk-geodata.js: terrain, harbour, roads and flyovers,
// buildings at their surveyed heights, parks, piers, tram tracks and trees, plus the ground-height and road-name
// lookups the players use.
//
// Heights: the geodata is in metres above Hong Kong Principal Datum (mPD). The scene puts the sea (WATER_MPD) at the
// harbour level the shared water material expects (y = -2.2), so world y = mPD + Y_OFFSET.

export const WATER_MPD = 1.0;
export const Y_OFFSET = -2.2 - WATER_MPD;
const ROAD_LIFT = 0.12; // road surface above the terrain mesh
const DECK_LEVEL = 7.0; // flyover deck height above the ground per TD level
const DECK_THICK = 1.3;

// --- World frame helpers ---------------------------------------------------------------------------------------------
const { lat: LAT0, lon: LON0 } = GEO.frame.origin;
const E2 = 6.69437999014e-3;
const SIN0 = Math.sin((LAT0 * Math.PI) / 180);
const KX = (Math.PI / 180) * (6378137 / Math.sqrt(1 - E2 * SIN0 * SIN0)) * Math.cos((LAT0 * Math.PI) / 180);
const KY = (Math.PI / 180) * ((6378137 * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5));
export const lonLatToWorld = (lon, lat) => [(lon - LON0) * KX, (LAT0 - lat) * KY];

const pairs = (a) => {
  const o = [];
  for (let i = 0; i + 1 < a.length; i += 2) o.push([a[i], a[i + 1]]);
  return o;
};
function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// --- Terrain sampling (the same triangles as the terrain meshes, so everything sits exactly on them) -----------------
function decodeGrid(g) {
  const bin = atob(g.data);
  const h = new Float32Array(g.cols * g.rows);
  for (let k = 0; k < h.length; k++) {
    const v = (bin.charCodeAt(2 * k) | (bin.charCodeAt(2 * k + 1) << 8)) << 16 >> 16;
    h[k] = v / 10;
  }
  return { ...g, h };
}
const PILOT_GRID = decodeGrid(GEO.terrain.pilot);
const BACK_GRID = decodeGrid(GEO.terrain.backdrop);

// Triangles of cell (i, j): (00, 01, 10) and (10, 01, 11), split along the 10-01 diagonal
function gridHeight(g, x, z) {
  const fx = (x - g.x0) / g.cell, fz = (z - g.z0) / g.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= g.cols - 1 || j >= g.rows - 1) return null;
  const u = fx - i, v = fz - j;
  const k = j * g.cols + i;
  const h00 = g.h[k], h10 = g.h[k + 1], h01 = g.h[k + g.cols], h11 = g.h[k + g.cols + 1];
  if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
  return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}
// Ground height in mPD (sea floor and anything off the map read as the sea surface)
export function groundMPD(x, z) {
  const h = gridHeight(PILOT_GRID, x, z) ?? gridHeight(BACK_GRID, x, z);
  return h == null ? WATER_MPD - 2 : h;
}
export const groundY = (x, z) => groundMPD(x, z) + Y_OFFSET;

// --- Spatial index of road links (for road names & the minimap) -------------------------------------------------------
const NODES = GEO.roadGraph.nodes;
const LINKS = GEO.roadGraph.links.map(([a, b, name, w, lanes, dir, inner, level]) => ({
  a, b, name: GEO.roadGraph.names[name], w, lanes, dir, level,
  pts: [[NODES[2 * a], NODES[2 * a + 1]], ...pairs(inner), [NODES[2 * b], NODES[2 * b + 1]]]
}));
const LINK_CELL = 60;
const linkCells = new Map();
LINKS.forEach((l, i) => {
  const seen = new Set();
  for (const [x, z] of densify(l.pts, LINK_CELL / 2)) {
    const k = `${Math.floor(x / LINK_CELL)},${Math.floor(z / LINK_CELL)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!linkCells.has(k)) linkCells.set(k, []);
    linkCells.get(k).push(i);
  }
});
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}
function nearestLinks(x, z, maxDist) {
  const out = [];
  const cx = Math.floor(x / LINK_CELL), cz = Math.floor(z / LINK_CELL);
  const seen = new Set();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const i of linkCells.get(`${cx + dx},${cz + dz}`) || []) {
      if (seen.has(i)) continue;
      seen.add(i);
      const l = LINKS[i];
      let d = Infinity;
      for (let k = 1; k < l.pts.length; k++) d = Math.min(d, segDist(x, z, ...l.pts[k - 1], ...l.pts[k]));
      if (d <= maxDist) out.push({ link: l, d });
    }
  }
  return out.sort((p, q) => p.d - q.d);
}
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/'S\b/g, "'s");
// "Place · Road" or "Road & Road" for the HUD, like the New York street signs
const STATIONS = GEO.points.stations.filter((s) => s.name);
export function locationLabel(x, z) {
  const near = nearestLinks(x, z, 40).filter((n) => n.link.name && n.link.level >= 0);
  const names = [];
  for (const n of near) {
    const t = titleCase(n.link.name);
    if (!names.includes(t)) names.push(t);
    if (names.length === 2) break;
  }
  let place = '';
  let best = 280;
  for (const s of STATIONS) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < best) { best = d; place = s.name; }
  }
  const streets = names.join(' & ');
  if (place && streets) return `${place} · ${streets}`;
  return place || streets || (groundMPD(x, z) > WATER_MPD + 0.5 ? 'Eastern District' : 'Victoria Harbour');
}

// --- Geometry helpers ------------------------------------------------------------------------------------------------
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}
// Left/right edge points of a polyline ribbon of half-width hw (mitred, capped at 2x)
function ribbonEdges(pts, hw) {
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    let s = 1;
    if (i > 0 && i < pts.length - 1) {
      const ux = p[0] - a[0], uz = p[1] - a[1], ul = Math.hypot(ux, uz) || 1;
      const cos = (ux / ul) * tx + (uz / ul) * tz;
      s = Math.min(2, 1 / Math.max(0.5, cos));
    }
    // left of the direction of travel, with z pointing south and x east, is (tz, -tx)
    L.push([p[0] + tz * hw * s, p[1] - tx * hw * s]);
    R.push([p[0] - tz * hw * s, p[1] + tx * hw * s]);
  }
  return [L, R];
}
class GeoBuilder {
  constructor(attrs = {}) {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
    this.extra = Object.fromEntries(Object.entries(attrs).map(([k, n]) => [k, { n, data: [] }]));
  }
  get count() { return this.pos.length / 3; }
  vertex(x, y, z, nx, ny, nz, u, v, extra = {}) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    for (const [k, a] of Object.entries(this.extra)) {
      const val = extra[k];
      if (a.n === 1) a.data.push(val ?? 0);
      else for (let i = 0; i < a.n; i++) a.data.push(val ? val[i] : 0);
    }
    return this.count - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  build(computeNormals = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const [k, a] of Object.entries(this.extra)) g.setAttribute(k, new THREE.Float32BufferAttribute(a.data, a.n));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    if (computeNormals) g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
// Splits items into square tiles so each tile's mesh is frustum-culled on its own
function tileKey(x, z, size) {
  return `${Math.floor(x / size)},${Math.floor(z / size)}`;
}

// =====================================================================================================================
// Terrain
// =====================================================================================================================
function terrainGeometry(g, skip) {
  const b = new GeoBuilder();
  for (let j = 0; j < g.rows; j++) {
    for (let i = 0; i < g.cols; i++) {
      const x = g.x0 + i * g.cell, z = g.z0 + j * g.cell;
      // central differences for the normal
      const hl = g.h[j * g.cols + Math.max(0, i - 1)], hr = g.h[j * g.cols + Math.min(g.cols - 1, i + 1)];
      const hu = g.h[Math.max(0, j - 1) * g.cols + i], hd = g.h[Math.min(g.rows - 1, j + 1) * g.cols + i];
      const nx = (hl - hr) / (2 * g.cell), nz = (hu - hd) / (2 * g.cell);
      const nl = Math.hypot(nx, 1, nz);
      let y = g.h[j * g.cols + i];
      if (skip && skip(x, z)) y -= 4; // under the detailed pilot terrain
      b.vertex(x, y + Y_OFFSET, z, nx / nl, 1 / nl, nz / nl, (x - GEO.pilot.minX) / (GEO.pilot.maxX - GEO.pilot.minX), (z - GEO.pilot.minZ) / (GEO.pilot.maxZ - GEO.pilot.minZ));
    }
  }
  for (let j = 0; j < g.rows - 1; j++) {
    for (let i = 0; i < g.cols - 1; i++) {
      const a = j * g.cols + i, c = a + 1, bq = a + g.cols, d = bq + 1;
      // underwater cells that stay under the sea are left out
      const top = Math.max(g.h[a], g.h[c], g.h[bq], g.h[d]);
      if (top < WATER_MPD - 6) continue;
      b.tri(a, bq, c);
      b.tri(c, bq, d);
    }
  }
  return b.build();
}

// Ground cover painted from the geodata (parks, pitches, pools, paving, vegetation on the hills), draped on the pilot
// terrain through its uv
function groundCoverTexture() {
  const P = GEO.pilot;
  const W = 4096;
  const H = Math.round((W * (P.maxZ - P.minZ)) / (P.maxX - P.minX));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const sx = W / (P.maxX - P.minX), sz = H / (P.maxZ - P.minZ);
  const X = (x) => (x - P.minX) * sx, Z = (z) => (z - P.minZ) * sz;
  // vegetation on the slopes, paving on the flat reclamation: by height, in 8 m steps of the terrain grid
  const T = PILOT_GRID;
  for (let j = 0; j < T.rows; j++) {
    for (let i = 0; i < T.cols; i++) {
      const h = T.h[j * T.cols + i];
      const k = Math.min(1, Math.max(0, (h - 18) / 30));
      const r = Math.round(128 + (62 - 128) * k), gg = Math.round(124 + (92 - 124) * k), bb = Math.round(116 + (52 - 116) * k);
      g.fillStyle = `rgb(${r},${gg},${bb})`;
      g.fillRect(X(T.x0 + (i - 0.5) * T.cell), Z(T.z0 + (j - 0.5) * T.cell), T.cell * sx + 1, T.cell * sz + 1);
    }
  }
  const path = (a) => {
    g.beginPath();
    g.moveTo(X(a[0]), Z(a[1]));
    for (let i = 2; i < a.length; i += 2) g.lineTo(X(a[i]), Z(a[i + 1]));
    g.closePath();
  };
  const FILL = {
    wood: '#3e5f30', scrub: '#5b7440', grass: '#6f9448', park: '#7a8f62', garden: '#6c9452', playground: '#a49a82',
    pitch: '#4f8a3c', track: '#a8553e', sports: '#8f8c85', pool: '#3fa6c8', water: '#3d7f9c', rock: '#8a8780'
  };
  const ORDER = ['wood', 'scrub', 'park', 'garden', 'grass', 'playground', 'sports', 'track', 'pitch', 'rock', 'water', 'pool'];
  for (const cat of ORDER) {
    g.fillStyle = FILL[cat];
    for (const p of GEO.parks) if (p.cat === cat) for (const r of p.rings) { path(r); g.fill('evenodd'); }
  }
  // building footprints: darker paving, so gaps between walls and the ground read as shade
  g.fillStyle = '#6d6a64';
  for (const b of GEO.buildings) { path(b[0]); g.fill(); }
  // footpaths
  g.strokeStyle = '#a49f94';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [kind, level, bridge, , pts] of GEO.footways) {
    if (bridge || level > 0) continue;
    g.lineWidth = (kind === 'steps' ? 2.4 : 2.2) * sx;
    g.beginPath();
    g.moveTo(X(pts[0]), Z(pts[1]));
    for (let i = 2; i < pts.length; i += 2) g.lineTo(X(pts[i]), Z(pts[i + 1]));
    g.stroke();
  }
  // asphalt under the road ribbons (hides seams at junctions)
  g.strokeStyle = '#34363a';
  for (const l of LINKS) {
    if (l.level !== 0) continue;
    g.lineWidth = l.w * sx;
    g.beginPath();
    g.moveTo(X(l.pts[0][0]), Z(l.pts[0][1]));
    for (const [x, z] of l.pts.slice(1)) g.lineTo(X(x), Z(z));
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; // uv v = 0 is the canvas's top row (the pilot's north edge)
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function buildTerrain(group) {
  const P = GEO.pilot;
  const insidePilot = (x, z) => x > P.minX + 20 && x < P.maxX - 20 && z > P.minZ + 20 && z < P.maxZ - 20;

  const pilotMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0 });
  const cover = texture(groundCoverTexture(), uv());
  const grain = sin(positionWorld.x.mul(1.7)).mul(sin(positionWorld.z.mul(1.3))).mul(0.03);
  pilotMat.colorNode = cover.rgb.mul(float(0.97).add(grain));
  const pilot = new THREE.Mesh(terrainGeometry(PILOT_GRID), pilotMat);
  pilot.name = 'HKTerrain';
  pilot.receiveShadow = true;
  group.add(pilot);

  // Backdrop: Kowloon and the hills of Hong Kong Island, coloured by height and slope
  const backMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0 });
  backMat.colorNode = Fn(() => {
    const mpd = positionWorld.y.sub(Y_OFFSET);
    const slope = float(1.0).sub(normalWorldGeometry.y);
    const green = mix(color(0x4f6b3a), color(0x2f4a26), smoothstep(150.0, 450.0, mpd));
    const city = mix(color(0x8f8a82), color(0x9d978c), sin(positionWorld.x.mul(0.05)).mul(sin(positionWorld.z.mul(0.043))).mul(0.5).add(0.5));
    const veg = smoothstep(14.0, 40.0, mpd).max(smoothstep(0.12, 0.3, slope));
    const rock = smoothstep(0.55, 0.8, slope).mul(0.5);
    return mix(mix(city, green, veg), color(0x7c776c), rock);
  })();
  const back = new THREE.Mesh(terrainGeometry(BACK_GRID, insidePilot), backMat);
  back.name = 'HKBackdropTerrain';
  back.receiveShadow = true;
  group.add(back);

  // Victoria Harbour and the sea beyond
  const waterGeo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, createWaterMaterial());
  water.position.y = WATER_MPD + Y_OFFSET;
  water.name = 'HKHarbour';
  group.add(water);
}

// =====================================================================================================================
// Roads & flyovers
// =====================================================================================================================
function buildRoads(group) {
  // Node heights: ground for nodes on a ground-level road, a deck height for nodes only flyovers reach
  const nodeCount = NODES.length / 2;
  const groundNode = new Uint8Array(nodeCount);
  const maxLevel = new Int8Array(nodeCount);
  for (const l of LINKS) {
    if (l.level <= 0) { groundNode[l.a] = 1; groundNode[l.b] = 1; }
    maxLevel[l.a] = Math.max(maxLevel[l.a], l.level);
    maxLevel[l.b] = Math.max(maxLevel[l.b], l.level);
  }
  const nodeY = (n) => groundMPD(NODES[2 * n], NODES[2 * n + 1]) + (groundNode[n] ? 0 : DECK_LEVEL * maxLevel[n]);

  const ground = new Map(); // tile -> GeoBuilder
  const decks = new GeoBuilder();
  const walls = new GeoBuilder();
  const pillars = [];
  const TILE = 500;
  for (const l of LINKS) {
    if (l.level < 0) continue; // underpasses
    const pts = densify(l.pts, 4);
    const hw = Math.max(2.6, l.w / 2);
    const [Lp, Rp] = ribbonEdges(pts, hw);
    let total = 0;
    const dist = [0];
    for (let i = 1; i < pts.length; i++) dist.push((total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])));
    // roadInfo: lanes, two-way (1) / one-way (0), length, distance along
    const info = (i) => [l.lanes, l.dir ? 0 : 1, total, dist[i]];
    if (l.level === 0) {
      const mid = pts[pts.length >> 1];
      const k = tileKey(mid[0], mid[1], TILE);
      if (!ground.has(k)) ground.set(k, new GeoBuilder({ roadInfo: 4 }));
      const b = ground.get(k);
      let prev = null;
      for (let i = 0; i < pts.length; i++) {
        const yl = groundY(...Lp[i]) + ROAD_LIFT, yr = groundY(...Rp[i]) + ROAD_LIFT;
        const vl = b.vertex(Lp[i][0], yl, Lp[i][1], 0, 1, 0, 0, dist[i], { roadInfo: info(i) });
        const vr = b.vertex(Rp[i][0], yr, Rp[i][1], 0, 1, 0, 1, dist[i], { roadInfo: info(i) });
        if (prev) b.quad(prev[0], prev[1], vr, vl);
        prev = [vl, vr];
      }
      continue;
    }
    // Flyover: deck from node height to node height, with parapets, an underside and pillars
    const ya = nodeY(l.a) + Y_OFFSET, yb = nodeY(l.b) + Y_OFFSET;
    let prev = null;
    let nextPillar = 18;
    for (let i = 0; i < pts.length; i++) {
      const t = total > 0 ? dist[i] / total : 0;
      const y = ya + (yb - ya) * t + ROAD_LIFT;
      const g0 = Math.max(groundY(...Lp[i]), groundY(...Rp[i]));
      const yy = Math.max(y, g0 + ROAD_LIFT);
      const vl = decks.vertex(Lp[i][0], yy, Lp[i][1], 0, 1, 0, 0, dist[i], { roadInfo: info(i) });
      const vr = decks.vertex(Rp[i][0], yy, Rp[i][1], 0, 1, 0, 1, dist[i], { roadInfo: info(i) });
      // parapets (outer faces) & underside, each face with vertices of its own for flat shading
      const sx = Lp[i][0] - Rp[i][0], sz = Lp[i][1] - Rp[i][1], sl = Math.hypot(sx, sz) || 1;
      const nx = sx / sl, nz = sz / sl; // towards the left edge
      const yu = yy + 0.95, yd = yy - DECK_THICK;
      const ul = walls.vertex(Lp[i][0], yu, Lp[i][1], nx, 0, nz, 0, dist[i]);
      const dl = walls.vertex(Lp[i][0], yd, Lp[i][1], nx, 0, nz, 0, dist[i]);
      const ur = walls.vertex(Rp[i][0], yu, Rp[i][1], -nx, 0, -nz, 1, dist[i]);
      const dr = walls.vertex(Rp[i][0], yd, Rp[i][1], -nx, 0, -nz, 1, dist[i]);
      const bl = walls.vertex(Lp[i][0], yd, Lp[i][1], 0, -1, 0, 0, dist[i]);
      const br = walls.vertex(Rp[i][0], yd, Rp[i][1], 0, -1, 0, 1, dist[i]);
      if (prev) {
        decks.quad(prev.vl, prev.vr, vr, vl);
        walls.quad(prev.dl, prev.ul, ul, dl); // left side, facing out
        walls.quad(prev.dr, dr, ur, prev.ur); // right side, facing out
        walls.quad(prev.bl, bl, br, prev.br); // underside, facing down
      }
      prev = { vl, vr, ul, dl, ur, dr, bl, br };
      if (dist[i] >= nextPillar && yy - g0 > 4.5) {
        pillars.push([pts[i][0], pts[i][1], g0 - 0.5, yy - DECK_THICK, Math.min(hw * 1.4, 7)]);
        nextPillar = dist[i] + 32;
      }
    }
  }

  const roadMat = createRoadSurfaceMaterial();
  addLaneMarkings(roadMat);
  roadMat.polygonOffset = true;
  roadMat.polygonOffsetFactor = -2;
  roadMat.polygonOffsetUnits = -2;
  for (const b of ground.values()) {
    const m = new THREE.Mesh(b.build(), roadMat);
    m.receiveShadow = true;
    m.name = 'HKRoad';
    group.add(m);
  }
  const deckMesh = new THREE.Mesh(decks.build(), roadMat);
  deckMesh.receiveShadow = true;
  deckMesh.castShadow = true;
  deckMesh.name = 'HKFlyoverDeck';
  group.add(deckMesh);
  const concrete = new THREE.MeshStandardNodeMaterial({ color: 0x9c988e, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
  const wallMesh = new THREE.Mesh(walls.build(), concrete);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  wallMesh.name = 'HKFlyoverStructure';
  group.add(wallMesh);

  if (pillars.length) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const inst = new THREE.InstancedMesh(geo, concrete, pillars.length);
    const m = new THREE.Matrix4();
    pillars.forEach(([x, z, y0, y1, w], i) => {
      m.makeScale(Math.max(1.6, w * 0.35), Math.max(0.1, y1 - y0), 1.8);
      m.setPosition(x, y0, z);
      inst.setMatrixAt(i, m);
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.name = 'HKFlyoverPillars';
    group.add(inst);
  }
  return { pillars };
}

// White lane lines (dashed between lanes of one direction, double white at the middle of two-way roads), faded out
// near the ends of each link where they cross junctions
function addLaneMarkings(mat) {
  const baseColor = mat.colorNode;
  const info = attribute('roadInfo', 'vec4');
  const lanes = max(info.x, 1.0);
  const across = uv().x; // 0..1 from the left edge
  const along = uv().y; // metres
  const fw = fwidth(across).max(0.0005);
  const laneU = across.mul(lanes);
  const nearDivider = abs(fract(laneU.add(0.5)).sub(0.5)).div(lanes); // distance (in u) to the nearest divider
  const lineW = float(0.12).div(lanes.mul(3.4));
  const dash = step(fract(along.div(9.0)), 0.45);
  const inner = step(0.5, laneU).mul(step(laneU, lanes.sub(0.5)));
  const divider = smoothstep(lineW.add(fw), lineW, nearDivider).mul(inner);
  const twoWay = info.y;
  const middle = abs(across.sub(0.5));
  const centre = smoothstep(lineW.mul(3.0).add(fw), lineW.mul(3.0), middle).mul(step(lineW, middle)).mul(twoWay);
  const isCentre = smoothstep(lineW.mul(4.0), lineW.mul(2.0), middle).mul(twoWay);
  const dividers = divider.mul(dash).mul(float(1.0).sub(isCentre));
  const edge = smoothstep(0.035, 0.02, min(across, float(1.0).sub(across))).mul(step(0.004, min(across, float(1.0).sub(across))));
  const ends = smoothstep(4.0, 9.0, along).mul(smoothstep(4.0, 9.0, info.z.sub(along)));
  const paint = clamp(dividers.add(centre).add(edge.mul(0.8)), 0.0, 1.0).mul(ends).mul(0.85);
  mat.colorNode = mix(baseColor, color(0xe8e6df), paint);
}

// =====================================================================================================================
// Buildings
// =====================================================================================================================
// Hong Kong facades: tiled residential towers in pale tones with rows of small windows and split units, curtain-wall
// glass on the tall office towers, shop fronts at street level
function createHKFacadeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0.0 });
  const bInfo = attribute('bInfo', 'vec4'); // seed, height (m), glass share, base y
  const u = uv().x; // metres along the walls
  const v = uv().y; // metres above the base
  const seed = bInfo.x;
  const glass = bInfo.z;
  const floorH = mix(float(2.9), float(3.9), glass);
  const bay = mix(mix(float(2.2), float(3.2), fract(seed.mul(7.13))), float(1.6), glass);
  const fu = fract(u.div(bay));
  const fv = fract(v.div(floorH));
  const floorIdx = floor(v.div(floorH));
  const bayIdx = floor(u.div(bay));
  const fwu = fwidth(u.div(bay)).add(0.001);
  const fwv = fwidth(v.div(floorH)).add(0.001);
  const winW = mix(float(0.36), float(0.9), glass);
  const winH = mix(float(0.42), float(0.78), glass);
  const inX = smoothstep(float(0.5).sub(winW.mul(0.5)).sub(fwu), float(0.5).sub(winW.mul(0.5)), fu)
    .mul(smoothstep(float(0.5).add(winW.mul(0.5)).add(fwu), float(0.5).add(winW.mul(0.5)), fu));
  const inY = smoothstep(float(0.3).sub(fwv), float(0.3), fv).mul(smoothstep(float(0.3).add(winH).add(fwv), float(0.3).add(winH), fv));
  const shopLevel = step(v, 4.2);
  const isWin = inX.mul(inY).mul(float(1.0).sub(shopLevel));
  const r1 = fract(sin(dot(vec2(floorIdx, bayIdx), vec2(12.9898, 78.233)).add(seed.mul(43.1))).mul(43758.5453));
  const r2 = fract(sin(dot(vec2(bayIdx, seed), vec2(39.3468, 11.135))).mul(24634.6345));

  // Tile colours: cream, white, pink, pale blue, beige, grey (one per building, varied per bay of units)
  const pick = fract(seed.mul(3.17));
  const tile = mix(
    mix(mix(color(0xe7dfcc), color(0xf0efea), step(0.2, pick)), mix(color(0xe6c9c0), color(0xc9d6de), step(0.5, pick)), step(0.35, pick)),
    mix(color(0xd8cbb0), color(0xa9aaa6), step(0.85, pick)),
    step(0.7, pick)
  ).mul(float(0.9).add(r2.mul(0.12)));
  const weathering = smoothstep(0.0, 1.0, fv).mul(0.06).add(smoothstep(30.0, 0.0, v).mul(0.08));
  const wall = mix(tile.mul(float(1.0).sub(weathering)), color(0x5a6a76), glass.mul(0.6));
  const glassCol = mix(color(0x1d2a33), color(0x223a4e), glass);

  // reflection-ish sky tint on glass
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(clamp(float(1.0).sub(abs(dot(viewDir, normalWorldGeometry))), 0.0, 1.0), 2.0);
  const skyRef = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, 0.45);
  const glassFinal = mix(glassCol, skyRef, fres.mul(0.55).add(glass.mul(0.15)));

  // shop fronts: dark glass with signage colour
  const sign = mix(color(0xb43a2c), color(0x2c6bb4), step(0.5, r2)).mul(step(3.2, v)).mul(step(v, 4.2));
  const shop = mix(color(0x2b2f33), sign, step(0.001, sign.r.add(sign.b)));
  const base = mix(mix(wall, glassFinal, isWin), shop, shopLevel.mul(step(0.0, v)));
  mat.colorNode = base;
  mat.roughnessNode = mix(float(0.78), float(0.12), isWin.max(glass.mul(0.6)));
  mat.metalnessNode = isWin.mul(mix(float(0.25), float(0.65), glass));
  // lit windows at dusk & night
  const lit = step(0.62, r1).mul(isWin).add(shopLevel.mul(0.6));
  const warm = mix(color(0xffd9a0), color(0xdfeaff), step(0.8, r2));
  mat.emissiveNode = warm.mul(lit).mul(cityUniforms.uInteriorGlow).mul(0.55);
  return mat;
}

const cross2 = (p, a, b, c) => (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0]);

function minAreaRect(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    const cs = (bx - ax) / L, sn = (bz - az) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of ring) {
      const u = x * cs + z * sn, v = -x * sn + z * cs;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, cs, sn, u0, u1, v0, v1 };
  }
  return best;
}

function buildBuildings(group) {
  const TILE = 400;
  const tiles = new Map();
  const roofTiles = new Map();
  const colliders = [];
  const labels = [];
  const bAttrs = { bInfo: 4 };
  GEO.buildings.forEach(([flatRing, base, top, type, nameIdx, holes], index) => {
    const ring = pairs(flatRing);
    if (ring.length < 3) return;
    let ground = Infinity;
    for (const [x, z] of ring) ground = Math.min(ground, groundMPD(x, z));
    const b0 = Math.min(base ?? ground, ground) - 1.5;
    const t = top ?? (base ?? ground) + 6;
    if (!(t > b0 + 1)) return;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const k = tileKey(cx, cz, TILE);
    if (!tiles.has(k)) { tiles.set(k, new GeoBuilder(bAttrs)); roofTiles.set(k, new GeoBuilder()); }
    const walls = tiles.get(k), roofs = roofTiles.get(k);
    const seed = hash(index + 0.5);
    const height = t - (base ?? ground);
    const glass = height > 110 || (height > 60 && seed > 0.55) ? 1 : 0;
    const open = type === 2; // open-sided structure: a roof slab on posts
    const yTop = t + Y_OFFSET;
    const yBot = (open ? t - 0.6 : b0) + Y_OFFSET;
    const info = [seed, height, glass, yBot];
    // Walls facing out of the footprint (outer ring) or into a courtyard (hole). The shoelace area is positive when a
    // ring turns counter-clockwise in (x, z); the right-hand side (dz, -dx) of each edge then faces out of it.
    const addWalls = (r, outer) => {
      let area = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) area += r[j][0] * r[i][1] - r[i][0] * r[j][1];
      const right = (area > 0) === outer;
      let u = 0;
      for (let i = 0; i < r.length; i++) {
        const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.05) continue;
        const s = right ? 1 : -1;
        const nx = (s * (bz - az)) / L, nz = (-s * (bx - ax)) / L;
        const vBase = (base ?? ground) + Y_OFFSET;
        const a0 = walls.vertex(ax, yBot, az, nx, 0, nz, u, yBot - vBase, { bInfo: info });
        const a1 = walls.vertex(ax, yTop, az, nx, 0, nz, u, yTop - vBase, { bInfo: info });
        const b1 = walls.vertex(bx, yTop, bz, nx, 0, nz, u + L, yTop - vBase, { bInfo: info });
        const b2 = walls.vertex(bx, yBot, bz, nx, 0, nz, u + L, yBot - vBase, { bInfo: info });
        if (right) walls.quad(a0, a1, b1, b2);
        else walls.quad(a0, b2, b1, a1);
        u += L;
      }
    };
    addWalls(ring, true);
    const holeRings = holes ? holes.map(pairs) : [];
    for (const h of holeRings) addWalls(h, false);
    // flat roof
    const shapePts = ring.map(([x, z]) => new THREE.Vector2(x, z));
    const holePts = holeRings.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
    const tris = THREE.ShapeUtils.triangulateShape(shapePts, holePts);
    const all = [...ring, ...holeRings.flat()];
    const off = roofs.count;
    for (const [x, z] of all) roofs.vertex(x, yTop, z, 0, 1, 0, x * 0.25, z * 0.25);
    for (const [a, b, c] of tris) {
      // facing up: (a, b, c) turns clockwise in (x, z), i.e. a negative 2D cross product
      if (cross2(all, a, b, c) < 0) roofs.tri(off + a, off + b, off + c);
      else roofs.tri(off + a, off + c, off + b);
    }
    if (open) {
      // underside of the slab
      const off2 = roofs.count;
      for (const [x, z] of all) roofs.vertex(x, yBot, z, 0, -1, 0, x * 0.25, z * 0.25);
      for (const [a, b, c] of tris) {
        if (cross2(all, a, b, c) < 0) roofs.tri(off2 + a, off2 + c, off2 + b);
        else roofs.tri(off2 + a, off2 + b, off2 + c);
      }
      return;
    }
    // collider: the footprint's minimum-area rectangle, slightly inset
    const r = minAreaRect(ring);
    if (r && r.area > 6) {
      const hx = Math.max(0.3, (r.u1 - r.u0) / 2 - 0.15), hz = Math.max(0.3, (r.v1 - r.v0) / 2 - 0.15);
      const mu = (r.u0 + r.u1) / 2, mv = (r.v0 + r.v1) / 2;
      const ocx = mu * r.cs - mv * r.sn, ocz = mu * r.sn + mv * r.cs;
      const ex = Math.abs(r.cs) * hx + Math.abs(r.sn) * hz, ez = Math.abs(r.sn) * hx + Math.abs(r.cs) * hz;
      colliders.push({ minX: ocx - ex, maxX: ocx + ex, minZ: ocz - ez, maxZ: ocz + ez, maxY: yTop, obb: { cx: ocx, cz: ocz, hx, hz, cs: r.cs, sn: -r.sn } }); // controllers.js frame: lx = dx cs - dz sn
    }
    if (nameIdx >= 0 && height > 40) labels.push({ name: GEO.buildingNames[nameIdx], x: cx, z: cz, top: yTop, height });
  });

  const facade = createHKFacadeMaterial();
  const roofMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.0 });
  roofMat.colorNode = Fn(() => {
    const n = sin(positionWorld.x.mul(0.31)).mul(sin(positionWorld.z.mul(0.27))).mul(0.5).add(0.5);
    return mix(color(0x77746e), color(0x8e8a82), n);
  })();
  for (const [k, b] of tiles) {
    const m = new THREE.Mesh(b.build(), facade);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'HKBuildings';
    group.add(m);
    const r = new THREE.Mesh(roofTiles.get(k).build(), roofMat);
    r.castShadow = true;
    r.receiveShadow = true;
    r.name = 'HKRoofs';
    group.add(r);
  }
  return { colliders, labels };
}

// =====================================================================================================================
// Piers, tram tracks, trees
// =====================================================================================================================
function buildPiers(group) {
  const b = new GeoBuilder();
  const deckY = WATER_MPD + 2.6 + Y_OFFSET;
  const baseY = WATER_MPD - 3 + Y_OFFSET;
  for (const p of GEO.piers) {
    if (!p.ring) continue;
    const ring = pairs(p.ring);
    const pts = ring.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    const off = b.count;
    for (const [x, z] of ring) b.vertex(x, deckY, z, 0, 1, 0, 0, 0);
    for (const [a, c, d] of tris) {
      if (cross2(ring, a, c, d) < 0) b.tri(off + a, off + c, off + d);
      else b.tri(off + a, off + d, off + c);
    }
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      const v = [b.vertex(ax, baseY, az, nx, 0, nz, 0, 0), b.vertex(ax, deckY, az, nx, 0, nz, 0, 0), b.vertex(bx, deckY, bz, nx, 0, nz, 0, 0), b.vertex(bx, baseY, bz, nx, 0, nz, 0, 0)];
      b.quad(v[0], v[1], v[2], v[3]);
      b.quad(v[0], v[3], v[2], v[1]); // either winding of the ring
    }
  }
  const mesh = new THREE.Mesh(b.build(), new THREE.MeshStandardNodeMaterial({ color: 0x8d8574, roughness: 0.88 }));
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = 'HKPiers';
  group.add(mesh);
}

function buildTramTracks(group) {
  const b = new GeoBuilder();
  const GAUGE = 1.067;
  for (const r of GEO.rail) {
    if (r.kind !== 'tram') continue;
    const pts = densify(pairs(r.pts), 3);
    for (const rail of ribbonEdges(pts, GAUGE / 2)) {
      const [L, R] = ribbonEdges(rail, 0.04);
      let prev = null;
      for (let i = 0; i < rail.length; i++) {
        const y = groundY(...rail[i]) + ROAD_LIFT + 0.02;
        const vl = b.vertex(L[i][0], y, L[i][1], 0, 1, 0, 0, 0);
        const vr = b.vertex(R[i][0], y, R[i][1], 0, 1, 0, 1, 0);
        if (prev) b.quad(prev[0], prev[1], vr, vl);
        prev = [vl, vr];
      }
    }
  }
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.9 });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -4;
  mat.polygonOffsetUnits = -4;
  const mesh = new THREE.Mesh(b.build(), mat);
  mesh.name = 'HKTramTracks';
  group.add(mesh);
}

function buildTrees(group) {
  const spots = [];
  for (let i = 0; i < GEO.points.trees.length; i += 2) spots.push([GEO.points.trees[i], GEO.points.trees[i + 1], 0.5]);
  // scatter trees in parks and gardens (not on pitches), and in woods on the slopes
  const inRing = (x, z, r) => {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const blocked = GEO.parks.filter((p) => /^(pitch|pool|track|water|sports)$/.test(p.cat));
  let n = 0;
  for (const p of GEO.parks) {
    const density = { park: 1 / 220, garden: 1 / 160, wood: 1 / 260, scrub: 1 / 900 }[p.cat];
    if (!density) continue;
    for (const r of p.rings) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); z0 = Math.min(z0, r[i + 1]); z1 = Math.max(z1, r[i + 1]); }
      const count = Math.min(1500, Math.round((x1 - x0) * (z1 - z0) * density));
      for (let k = 0; k < count; k++) {
        const x = x0 + hash(++n) * (x1 - x0), z = z0 + hash(n + 0.37) * (z1 - z0);
        if (!inRing(x, z, r)) continue;
        if (blocked.some((b) => b.rings.some((br) => inRing(x, z, br)))) continue;
        if (nearestLinks(x, z, 6).length) continue;
        spots.push([x, z, hash(n + 0.71)]);
      }
    }
  }
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardNodeMaterial({ color: 0x3f6a2e, roughness: 0.85 }), spots.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardNodeMaterial({ color: 0x5a4636, roughness: 0.9 }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  spots.forEach(([x, z, r], i) => {
    const y = groundY(x, z);
    const h = 4 + r * 6, w = 2 + r * 2.5;
    m.compose(new THREE.Vector3(x, y + h * 0.62, z), q, new THREE.Vector3(w, h * 0.45, w));
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, c.setHSL(0.25 + r * 0.06, 0.45, 0.22 + r * 0.08));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, h * 0.5, 1));
    trunks.setMatrixAt(i, m);
  });
  for (const t of [crowns, trunks]) {
    t.castShadow = true;
    t.receiveShadow = true;
    group.add(t);
  }
  crowns.name = 'HKTreeCrowns';
  trunks.name = 'HKTreeTrunks';
  return spots.length;
}

// =====================================================================================================================
export function buildHongKong(scene) {
  const group = new THREE.Group();
  group.name = 'HongKongEasternDistrict';
  buildTerrain(group);
  const roads = buildRoads(group);
  const { colliders, labels } = buildBuildings(group);
  buildPiers(group);
  buildTramTracks(group);
  const trees = buildTrees(group);
  scene.add(group);
  // flyover pillars stop players too
  for (const [x, z, , y1, w] of roads.pillars) {
    const hx = Math.max(0.8, w * 0.175), hz = 0.9;
    colliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, maxY: y1 });
  }
  console.log(`[hk] ${LINKS.length} road links, ${GEO.buildings.length} buildings, ${colliders.length} colliders, ${trees} trees`);
  return { group, colliders, labels };
}

export { LINKS as HK_ROAD_LINKS, titleCase };
