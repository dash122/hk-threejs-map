import { GEO } from './hk-geodata.js';
import { HK_ROAD_LINKS } from './hk-world.js';

// js/hk-minimap.js
// North-up radar minimap of the Eastern District pilot: the map is drawn once to an offscreen canvas, and each update
// copies the window around the player and draws the player's arrow on top.

const SCALE = 0.5; // map pixels per metre
const VIEW = 420; // metres across the radar

export class HKMinimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    if (!this.ctx) return;
    const P = GEO.pilot;
    const pad = VIEW;
    this.x0 = P.minX - pad;
    this.z0 = P.minZ - pad;
    const W = Math.ceil((P.maxX - P.minX + 2 * pad) * SCALE);
    const H = Math.ceil((P.maxZ - P.minZ + 2 * pad) * SCALE);
    const map = document.createElement('canvas');
    map.width = W;
    map.height = H;
    const g = map.getContext('2d');
    const X = (x) => (x - this.x0) * SCALE, Z = (z) => (z - this.z0) * SCALE;
    const poly = (a) => {
      g.beginPath();
      g.moveTo(X(a[0]), Z(a[1]));
      for (let i = 2; i < a.length; i += 2) g.lineTo(X(a[i]), Z(a[i + 1]));
      g.closePath();
    };
    g.fillStyle = '#16304a';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#2b2f36';
    for (const r of GEO.land) { poly(r); g.fill(); }
    g.fillStyle = '#2d4a2f';
    for (const p of GEO.parks) if (/^(park|garden|wood|grass|pitch)$/.test(p.cat)) for (const r of p.rings) { poly(r); g.fill(); }
    g.fillStyle = '#4a4e57';
    for (const b of GEO.buildings) { poly(b[0]); g.fill(); }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const elevated of [false, true]) {
      g.strokeStyle = elevated ? '#e0a83a' : '#c9ccd2';
      for (const l of HK_ROAD_LINKS) {
        if ((l.level > 0) !== elevated || l.level < 0) continue;
        g.lineWidth = Math.max(1.2, l.w * SCALE * 0.8);
        g.beginPath();
        g.moveTo(X(l.pts[0][0]), Z(l.pts[0][1]));
        for (const [x, z] of l.pts.slice(1)) g.lineTo(X(x), Z(z));
        g.stroke();
      }
    }
    g.strokeStyle = '#d64b3c';
    g.lineWidth = 1.2;
    for (const r of GEO.rail) {
      if (r.kind !== 'tram') continue;
      g.beginPath();
      g.moveTo(X(r.pts[0]), Z(r.pts[1]));
      for (let i = 2; i < r.pts.length; i += 2) g.lineTo(X(r.pts[i]), Z(r.pts[i + 1]));
      g.stroke();
    }
    this.map = map;
  }

  update(x, z, heading) {
    const { ctx, canvas } = this;
    if (!ctx || !this.map) return;
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const s = canvas.width / (VIEW * SCALE);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#16304a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const mx = (x - this.x0) * SCALE, mz = (z - this.z0) * SCALE;
    ctx.setTransform(s, 0, 0, s, canvas.width / 2 - mx * s, canvas.height / 2 - mz * s);
    ctx.drawImage(this.map, 0, 0);
    // player arrow: heading 0 faces +z (south), heading π/2 faces +x (east)
    ctx.setTransform(1, 0, 0, 1, canvas.width / 2, canvas.height / 2);
    ctx.rotate(-heading + Math.PI);
    const a = 7 * dpr;
    ctx.fillStyle = '#ffcf33';
    ctx.strokeStyle = '#1b1b1b';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.3);
    ctx.lineTo(a * 0.8, a);
    ctx.lineTo(0, a * 0.45);
    ctx.lineTo(-a * 0.8, a);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
