// js/hk-world.js
// The Hong Kong (Eastern District pilot) world, built from js/hk-geodata.js: the 5 m DTM terrain as a ground mesh,
// roads draped over it, flyovers (TD road levels > 0) raised on decks with ramps down to their ground-level joins and
// piers underneath, LandsD building blocks extruded from their base to their top level (mPD), parks, piers and the sea.
// Also provides the ground the controllers stand on (terrain or a deck, whichever is right under the player) and the
// building wall colliders.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GEO } from './hk-geodata.js';

const SEA_LEVEL = 1.1; // mean sea level, metres above Principal Datum
const ROAD_LIFT = 0.25; // road surfaces sit just above the terrain mesh
const DECK_RISE = 8; // deck height above the ground per TD level
const RAMP_GRADE = 0.06; // ramps climb at most 6% from their ground-level join
const DECK_DEPTH = 1.4; // girder depth under a deck
const PIER_SPACING = 28;

// =====================================================================================================================
// Terrain
// =====================================================================================================================
function decodeGrid(g) {
  const bin = atob(g.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ...g, h: new Int16Array(bytes.buffer) };
}
const PILOT = decodeGrid(GEO.terrain.pilot);
const BACKDROP = decodeGrid(GEO.terrain.backdrop);

function sampleGrid(g, x, z) {
  const fx = (x - g.x0) / g.cell, fz = (z - g.z0) / g.cell;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i + 1 >= g.cols || j + 1 >= g.rows) return null;
  const tx = fx - i, tz = fz - j, c = g.cols, h = g.h;
  const a = h[j * c + i], b = h[j * c + i + 1], d = h[(j + 1) * c + i], e = h[(j + 1) * c + i + 1];
  return ((a * (1 - tx) + b * tx) * (1 - tz) + (d * (1 - tx) + e * tx) * tz) / 10;
}

/** Ground height (mPD) of the bare terrain at (x, z); the sea floor reads as 0. */
export function terrainHeight(x, z) {
  const p = sampleGrid(PILOT, x, z);
  if (p != null) return p;
  const b = sampleGrid(BACKDROP, x, z);
  return b != null ? b : 0;
}

function terrainMesh(g, material, sink = null) {
  const { cols, rows, cell, x0, z0 } = g;
  const pos = new Float32Array(cols * rows * 3);
  const col = new Float32Array(cols * rows * 3);
  const c = new THREE.Color();
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, x = x0 + i * cell, z = z0 + j * cell;
    let y = g.h[k] / 10;
    if (sink && x > sink.minX && x < sink.maxX && z > sink.minZ && z < sink.maxZ) y -= 4; // under the pilot's finer mesh
    if (y < 0.4) y = -6; // the sea floor drops away under the water surface
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    // Shore sand, urban grey-green lowland, wooded hillsides, rock on the peaks
    if (y < 3) c.setRGB(0.46, 0.46, 0.42);
    else if (y < 25) c.setRGB(0.42, 0.44, 0.38);
    else if (y < 280) c.setRGB(0.22, 0.33, 0.17).lerp(new THREE.Color(0.30, 0.36, 0.22), Math.min(1, (y - 25) / 250));
    else c.setRGB(0.42, 0.40, 0.34);
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, d = a + cols, e = d + 1;
    idx[n++] = a; idx[n++] = d; idx[n++] = b;
    idx[n++] = b; idx[n++] = d; idx[n++] = e;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

// =====================================================================================================================
// Road network: per-point elevation, deck spans
// =====================================================================================================================
function linkPoints(nodes, link) {
  const [a, b, , , , , inner] = link;
  const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
  for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
  pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
  // Subdivide so draped roads follow the terrain and ramps climb smoothly
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 6));
    for (let s = 1; s <= n; s++) out.push([ax + (bx - ax) * s / n, az + (bz - az) * s / n]);
  }
  return out;
}

// Elevated links rise from the nodes where they meet the ground network: the deck stands DECK_RISE per level above
// the ground (or the sea), reached at RAMP_GRADE along the elevated network from the nearest ground-level join.
function elevateNetwork() {
  const { nodes, links } = GEO.roadGraph;
  const nodeCount = nodes.length / 2;
  const groundNode = new Uint8Array(nodeCount);
  const adj = Array.from({ length: nodeCount }, () => []);
  const shapes = links.map((l) => linkPoints(nodes, l));
  const lengths = shapes.map((p) => {
    let s = 0;
    for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    return s;
  });
  links.forEach((l, k) => {
    if (l[7] > 0) {
      adj[l[0]].push([l[1], lengths[k]]);
      adj[l[1]].push([l[0], lengths[k]]);
    } else {
      groundNode[l[0]] = groundNode[l[1]] = 1;
    }
  });
  // Dijkstra from every ground-level join over the elevated links (a small network: a sorted frontier is plenty)
  const dist = new Float64Array(nodeCount).fill(Infinity);
  const frontier = [];
  for (let i = 0; i < nodeCount; i++) if (groundNode[i] && adj[i].length) { dist[i] = 0; frontier.push(i); }
  while (frontier.length) {
    frontier.sort((a, b) => dist[b] - dist[a]);
    const u = frontier.pop();
    for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; frontier.push(v); }
  }
  // Elevated links with no ground join at all (cut by the pilot's edge) stand at full height
  for (let i = 0; i < nodeCount; i++) if (!Number.isFinite(dist[i])) dist[i] = 1e6;

  const groundAt = (x, z) => Math.max(terrainHeight(x, z), SEA_LEVEL - 0.6) + ROAD_LIFT;
  // A deck's cruising height follows the ground averaged over 40 m round it, so it doesn't step where the shore
  // changes from sea to reclaimed land under it
  const cruise = (x, z, level) => {
    let sum = 0;
    for (let a = 0; a < 8; a++) sum += groundAt(x + Math.cos(a * Math.PI / 4) * 40, z + Math.sin(a * Math.PI / 4) * 40);
    return Math.max(groundAt(x, z), (sum + groundAt(x, z)) / 9) + DECK_RISE * level;
  };
  // Node heights: ground-level joins sit on the ground, elevated nodes at the highest cruise of their links, eased in
  // from the nearest join
  const nodeY = new Float64Array(nodeCount).fill(-Infinity);
  links.forEach((l) => {
    if (l[7] <= 0) return;
    for (const n of [l[0], l[1]]) nodeY[n] = Math.max(nodeY[n], cruise(nodes[n * 2], nodes[n * 2 + 1], l[7]));
  });
  for (let n = 0; n < nodeCount; n++) {
    if (nodeY[n] === -Infinity) continue;
    const g = groundAt(nodes[n * 2], nodes[n * 2 + 1]);
    nodeY[n] = Math.min(nodeY[n], g + dist[n] * RAMP_GRADE);
  }

  return links.map((l, k) => {
    const pts = shapes[k], level = l[7];
    const total = lengths[k];
    const ya = nodeY[l[0]], yb = nodeY[l[1]];
    let s = 0;
    return {
      name: GEO.roadGraph.names[l[2]] || '',
      width: Math.max(3.5, l[3]),
      level,
      pts: pts.map((p, i) => {
        if (i > 0) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
        const ground = groundAt(p[0], p[1]);
        if (level <= 0) return [p[0], ground, p[1]];
        // Cruise height, held within the ramp grade of both ends (a straight blend where the ends disagree)
        const lo = Math.max(ya - s * RAMP_GRADE, yb - (total - s) * RAMP_GRADE);
        const hi = Math.min(ya + s * RAMP_GRADE, yb + (total - s) * RAMP_GRADE);
        const y = lo <= hi ? Math.min(hi, Math.max(lo, cruise(p[0], p[1], level))) : ya + (yb - ya) * (s / (total || 1));
        return [p[0], Math.max(y, ground), p[1]];
      })
    };
  });
}

// A ribbon along pts ([x, y, z]) of half-width hw, with optional side skirts dropping `depth` (deck girders)
function ribbon(pts, hw, depth = 0) {
  const pos = [], idx = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz * hw, nz = dx * hw;
    pos.push(p[0] + nx, p[1], p[2] + nz, p[0] - nx, p[1], p[2] - nz);
    if (depth) pos.push(p[0] + nx, p[1] - depth, p[2] + nz, p[0] - nx, p[1] - depth, p[2] - nz);
  }
  const stride = depth ? 4 : 2;
  for (let i = 0; i < n - 1; i++) {
    const a = i * stride, b = (i + 1) * stride;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    if (depth) {
      idx.push(a + 2, b + 2, a, a, b + 2, b); // left skirt
      idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3); // right skirt
      idx.push(a + 3, b + 3, a + 2, a + 2, b + 3, b + 2); // soffit
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

// =====================================================================================================================
// Spatial index of deck segments (the ground the controllers stand on) and road names (location labels)
// =====================================================================================================================
const CELL = 24;
const cellKey = (ix, iz) => (ix + 2048) * 4096 + (iz + 2048);
function indexSegments(roads, filter) {
  const cells = new Map();
  for (const r of roads) {
    if (!filter(r)) continue;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const seg = { ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], hw: r.width / 2, name: r.name, level: r.level };
      const pad = seg.hw + 1;
      for (let ix = Math.floor((Math.min(a[0], b[0]) - pad) / CELL); ix <= Math.floor((Math.max(a[0], b[0]) + pad) / CELL); ix++) {
        for (let iz = Math.floor((Math.min(a[2], b[2]) - pad) / CELL); iz <= Math.floor((Math.max(a[2], b[2]) + pad) / CELL); iz++) {
          const k = cellKey(ix, iz);
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(seg);
        }
      }
    }
  }
  return cells;
}
// Calls fn(segment, distance, t) for every indexed segment near (x, z)
function nearSegments(cells, x, z, fn) {
  const list = cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!list) return;
  for (const s of list) {
    const dx = s.bx - s.ax, dz = s.bz - s.az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
    fn(s, Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)), t);
  }
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'(-])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/'S\b/g, "'s");

// =====================================================================================================================
// Build
// =====================================================================================================================
export function buildHongKong(scene) {
  const root = new THREE.Group();
  root.name = 'HongKongWorld';
  scene.add(root);

  // Terrain & sea
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const pilotRect = { minX: PILOT.x0 + 20, maxX: PILOT.x0 + (PILOT.cols - 2) * PILOT.cell, minZ: PILOT.z0 + 20, maxZ: PILOT.z0 + (PILOT.rows - 2) * PILOT.cell };
  root.add(terrainMesh(PILOT, groundMat));
  root.add(terrainMesh(BACKDROP, groundMat, pilotRect));
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshStandardMaterial({ color: 0x1d4256, roughness: 0.12, metalness: 0.3 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA_LEVEL;
  sea.receiveShadow = true;
  root.add(sea);

  // Roads: ground-level ribbons, flyover decks with girders, piers under them (tunnels are not drawn)
  const roads = elevateNetwork();
  const groundRoads = [], decks = [];
  const piers = [];
  for (const r of roads) {
    if (r.level < 0) continue;
    if (r.level === 0) { groundRoads.push(ribbon(r.pts, r.width / 2)); continue; }
    decks.push(ribbon(r.pts, r.width / 2 + 0.4, DECK_DEPTH));
    let run = PIER_SPACING / 2;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      run += Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (run < PIER_SPACING) continue;
      run = 0;
      const base = Math.max(terrainHeight(b[0], b[2]), SEA_LEVEL - 2);
      const h = b[1] - DECK_DEPTH - base;
      if (h > 2.5) piers.push([b[0], base, b[2], h]);
    }
  }
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x3a3b3d, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.85, side: THREE.DoubleSide });
  if (groundRoads.length) root.add(Object.assign(new THREE.Mesh(mergeGeometries(groundRoads), asphalt), { receiveShadow: true }));
  if (decks.length) {
    const deckGeo = mergeGeometries(decks);
    deckGeo.computeVertexNormals();
    const deckMesh = new THREE.Mesh(deckGeo, concrete);
    deckMesh.castShadow = deckMesh.receiveShadow = true;
    root.add(deckMesh);
    // Asphalt on the deck tops
    const tops = roads.filter((r) => r.level > 0).map((r) => ribbon(r.pts.map((p) => [p[0], p[1] + 0.05, p[2]]), r.width / 2));
    root.add(Object.assign(new THREE.Mesh(mergeGeometries(tops), asphalt), { receiveShadow: true }));
  }
  if (piers.length) {
    const pier = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.9, 1.1, 1, 12).translate(0, 0.5, 0), concrete, piers.length);
    const m = new THREE.Matrix4();
    piers.forEach(([x, y, z, h], i) => pier.setMatrixAt(i, m.makeScale(1, h, 1).setPosition(x, y, z)));
    pier.castShadow = pier.receiveShadow = true;
    root.add(pier);
  }

  // Parks & open space: draped over the terrain
  const parkColors = { water: 0x2c5b6e, pool: 0x3b8fb0, rock: 0x77746b, track: 0x9b4d3b, pitch: 0x4c7f3a, sports: 0x5a7d4a };
  const parkGeos = new Map();
  for (const p of GEO.parks) {
    for (const ring of p.rings) {
      if (ring.length < 6) continue;
      const shape = new THREE.Shape();
      for (let i = 0; i < ring.length; i += 2) shape[i ? 'lineTo' : 'moveTo'](ring[i], ring[i + 1]);
      const g = new THREE.ShapeGeometry(shape);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getY(i);
        pos.setXYZ(i, x, terrainHeight(x, z) + 0.12, z);
      }
      g.index.array.reverse(); // the xz plane flips the winding: face up
      const c = parkColors[p.cat] ?? 0x3f6b33;
      if (!parkGeos.has(c)) parkGeos.set(c, []);
      parkGeos.get(c).push(g);
    }
  }
  for (const [color, geos] of parkGeos) {
    const g = mergeGeometries(geos);
    g.computeVertexNormals();
    root.add(Object.assign(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })), { receiveShadow: true }));
  }

  // Ferry piers: slabs over the water
  const pierGeos = GEO.piers.map((p) => {
    const shape = new THREE.Shape();
    for (let i = 0; i < p.ring.length; i += 2) shape[i ? 'lineTo' : 'moveTo'](p.ring[i], -p.ring[i + 1]);
    return new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, SEA_LEVEL - 1, 0);
  });
  if (pierGeos.length) root.add(Object.assign(new THREE.Mesh(mergeGeometries(pierGeos), concrete), { receiveShadow: true }));

  // Buildings: footprints extruded from the ground (or their base level) to their top level; wall colliders
  const colliders = [];
  const buildingGeos = [[], [], []];
  for (const [outline, base, top, type, , holes] of GEO.buildings) {
    if (outline.length < 6 || !(top > base)) continue;
    const shape = new THREE.Shape();
    // Shape space (x, -z) so the extrusion turned upright (rotateX(-90°)) lands back on (x, z)
    for (let i = 0; i < outline.length; i += 2) shape[i ? 'lineTo' : 'moveTo'](outline[i], -outline[i + 1]);
    if (holes) for (const h of holes) {
      const path = new THREE.Path();
      for (let i = 0; i < h.length; i += 2) path[i ? 'lineTo' : 'moveTo'](h[i], -h[i + 1]);
      shape.holes.push(path);
    }
    // A podium-free tower on a slope: reach down to the lowest ground under the footprint
    let ground = Infinity;
    for (let i = 0; i < outline.length; i += 2) ground = Math.min(ground, terrainHeight(outline[i], outline[i + 1]));
    const bottom = type === 2 ? base : Math.min(base, ground - 0.5);
    const g = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2).translate(0, bottom, 0);
    g.deleteAttribute('uv');
    buildingGeos[type === 0 ? 0 : type === 1 ? 1 : 2].push(g);
    if (type < 2) {
      for (let i = 0; i < outline.length; i += 2) {
        const ax = outline[i], az = outline[i + 1];
        const bx = outline[(i + 2) % outline.length], bz = outline[(i + 3) % outline.length];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.3) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len, cx = (ax + bx) / 2, cz = (az + bz) / 2;
        const hx = len / 2, hz = 0.6, ex = Math.abs(ux) * hx + Math.abs(uz) * hz, ez = Math.abs(uz) * hx + Math.abs(ux) * hz;
        colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: bottom, maxY: top, obb: { cx, cz, hx, hz, cs: ux, sn: -uz } });
      }
    }
  }
  const buildingMats = [
    new THREE.MeshStandardMaterial({ color: 0xc9c3b8, roughness: 0.75 }), // towers
    new THREE.MeshStandardMaterial({ color: 0xa8a39a, roughness: 0.8 }), // podiums
    new THREE.MeshStandardMaterial({ color: 0x8b8f92, roughness: 0.6 }) // open-sided & temporary structures
  ];
  buildingGeos.forEach((geos, i) => {
    if (!geos.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(geos), buildingMats[i]);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
  });

  // Ground the controllers stand on: the terrain, or the highest deck under (x, z) within a step of the player
  const deckCells = indexSegments(roads, (r) => r.level > 0);
  const nameCells = indexSegments(roads, (r) => r.level >= 0 && r.name);
  function groundHeight(x, z, mode, refY = null) {
    let y = terrainHeight(x, z);
    if (mode === 'person') y += 0.02;
    if (refY == null) return y;
    nearSegments(deckCells, x, z, (s, d, t) => {
      if (d > s.hw + 0.6) return;
      const dy = s.ay + (s.by - s.ay) * t + 0.05;
      if (dy > y && dy <= refY + 1.2) y = dy;
    });
    return y;
  }

  function locationLabel(x, z) {
    let best = null, bestD = 60;
    nearSegments(nameCells, x, z, (s, d) => { if (d < bestD) { bestD = d; best = s.name; } });
    return best ? titleCase(best) : 'Eastern District, Hong Kong';
  }

  // Teleports: the pilot's MTR stations, plus a spot on the Island Eastern Corridor deck
  const teleports = GEO.points.stations.map((s) => ({ name: `${s.name} Station`, sub: s.zh, x: s.x, z: s.z, heading: Math.PI }));
  const iec = roads.find((r) => r.level > 0 && /EASTERN CORRIDOR/.test(r.name) && r.pts.length > 6);
  if (iec) {
    const m = Math.floor(iec.pts.length / 2), a = iec.pts[m], b = iec.pts[m + 1];
    teleports.unshift({ name: 'Island Eastern Corridor', sub: 'Flyover over the harbour', x: a[0], z: a[2], y: a[1], heading: Math.atan2(b[0] - a[0], b[2] - a[2]) });
  }

  return {
    root,
    colliders,
    bounds: { minX: GEO.pilot.minX, maxX: GEO.pilot.maxX, minZ: GEO.pilot.minZ, maxZ: GEO.pilot.maxZ },
    spawn: { x: 0, z: 0, heading: Math.PI / 2 },
    groundHeight,
    locationLabel,
    teleports
  };
}
