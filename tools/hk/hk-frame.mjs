// tools/hk/hk-frame.mjs
// The Hong Kong world frame and coordinate conversions shared by the Hong Kong data tools.
// Frame: 1 unit = 1 m, x = east, z = south (north = -z), y = up in metres above Hong Kong Principal Datum (mPD).
// Origin on King's Road by Java Road, North Point. No rotation: Hong Kong has no street grid to line up with.
//
// Government data comes in the Hong Kong 1980 Grid (EPSG:2326): a transverse Mercator projection of the HK1980
// datum (International 1924 ellipsoid). hk1980ToWgs84 / wgs84ToHk1980 convert between it and WGS 84 longitude and
// latitude with the projection formulae and the Lands Department's 7-parameter datum shift.

// --- Pilot area and backdrop ---------------------------------------------------------------------------------------
// Pilot: the north shore of Eastern District, from Causeway Bay's Victoria Park to Taikoo Shing, with the harbour
// edge, the Island Eastern Corridor and the first slopes behind King's Road.
export const PILOT = { south: 22.276, west: 114.184, north: 22.297, east: 114.224 };
// Backdrop: Kowloon across the harbour and the hills behind, drawn in low detail.
export const BACKDROP = { south: 22.245, west: 114.15, north: 22.325, east: 114.26 };

export const LAT0 = 22.291;
export const LON0 = 114.2;

// --- WGS 84 to the world frame (local tangent plane, metres) ---------------------------------------------------------
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;

export const toWorld = (lon, lat) => [(lon - LON0) * KX, (LAT0 - lat) * KY];
export const fromWorld = (x, z) => [LON0 + x / KX, LAT0 - z / KY];

// --- Hong Kong 1980 Grid ---------------------------------------------------------------------------------------------
const INTL_A = 6378388.0;
const INTL_F = 1 / 297;
const INTL_E2 = INTL_F * (2 - INTL_F);
const dms = (d, m, s) => d + m / 60 + s / 3600;
const TM = { lat0: dms(22, 18, 43.68), lon0: dms(114, 10, 42.8), k0: 1, fe: 836694.05, fn: 819069.8 };

// Meridian arc length from the equator (International 1924)
function meridian(phi) {
  const e2 = INTL_E2, e4 = e2 * e2, e6 = e4 * e2;
  return INTL_A * ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
}
const RAD = Math.PI / 180;
const M0 = meridian(TM.lat0 * RAD);

// HK1980 geographic (degrees) to grid easting/northing
function tmForward(lon, lat) {
  const phi = lat * RAD, dl = (lon - TM.lon0) * RAD;
  const e2 = INTL_E2, ep2 = e2 / (1 - e2);
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const nu = INTL_A / Math.sqrt(1 - e2 * s * s);
  const T = t * t, C = ep2 * c * c, Aa = dl * c;
  const M = meridian(phi);
  const x = TM.k0 * nu * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * Aa ** 5) / 120);
  const y = TM.k0 * (M - M0 + nu * t * (Aa * Aa / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * Aa ** 6) / 720));
  return [TM.fe + x, TM.fn + y];
}
// Grid easting/northing to HK1980 geographic (degrees)
function tmInverse(e, n) {
  const e2 = INTL_E2, ep2 = e2 / (1 - e2);
  const M = M0 + (n - TM.fn) / TM.k0;
  const mu = M / (INTL_A * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const nu = INTL_A / Math.sqrt(1 - e2 * s * s);
  const rho = (INTL_A * (1 - e2)) / Math.pow(1 - e2 * s * s, 1.5);
  const T = t * t, C = ep2 * c * c, D = (e - TM.fe) / (nu * TM.k0);
  const phi = phi1 - ((nu * t) / rho) * (D * D / 2 - ((5 + 3 * T + 10 * C - 4 * C * C - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T + 298 * C + 45 * T * T - 252 * ep2 - 3 * C * C) * D ** 6) / 720);
  const lam = (D - ((1 + 2 * T + C) * D ** 3) / 6 + ((5 - 2 * C + 28 * T - 3 * C * C + 8 * ep2 + 24 * T * T) * D ** 5) / 120) / c;
  return [TM.lon0 + lam / RAD, phi / RAD];
}

// Geodetic <-> earth-centred cartesian
function toECEF(lon, lat, a, e2) {
  const phi = lat * RAD, lam = lon * RAD;
  const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [nu * Math.cos(phi) * Math.cos(lam), nu * Math.cos(phi) * Math.sin(lam), nu * (1 - e2) * Math.sin(phi)];
}
function fromECEF([x, y, z], a, e2) {
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    phi = Math.atan2(z + e2 * nu * Math.sin(phi), p);
  }
  return [Math.atan2(y, x) / RAD, phi / RAD];
}
// HK1980 -> WGS 84 datum shift (Lands Department / EPSG:1825, position-vector form as in PROJ's +towgs84)
const AS = Math.PI / 180 / 3600;
const H = { tx: -162.619, ty: -276.959, tz: -161.764, rx: 0.067753 * AS, ry: -2.243648 * AS, rz: -1.158828 * AS, s: -1.094246e-6 };
function helmert([x, y, z], sign) {
  const { tx, ty, tz, rx, ry, rz, s } = H;
  const k = sign, m = 1 + k * s;
  return [k * tx + m * (x - k * rz * y + k * ry * z), k * ty + m * (k * rz * x + y - k * rx * z), k * tz + m * (-k * ry * x + k * rx * y + z)];
}

export const hk1980Geographic = tmInverse;
export const hk1980FromGeographic = tmForward;
export function hk1980ToWgs84(e, n) {
  const [lon, lat] = tmInverse(e, n);
  return fromECEF(helmert(toECEF(lon, lat, INTL_A, INTL_E2), 1), A, E2);
}
export function wgs84ToHk1980(lon, lat) {
  const [lo, la] = fromECEF(helmert(toECEF(lon, lat, A, E2), -1), INTL_A, INTL_E2);
  return tmForward(lo, la);
}
export const hk1980ToWorld = (e, n) => toWorld(...hk1980ToWgs84(e, n));
export const worldToHk1980 = (x, z) => wgs84ToHk1980(...fromWorld(x, z));
