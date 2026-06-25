// Modelled clear-sky profiles — the default data source, and the per-zone fallback
// the MIDAS ingest uses for zones with no station coverage. Pure + deterministic.

import { clearSkyWeight } from './solarGeom.mjs';

// Day-of-year for the 15th of each month (non-leap representative day).
export const DOY_15 = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

// Largest-remainder rounding of weights → integer ppm summing to exactly `total`
// (0 only when the day has no daylight, which never happens for UK lat/months).
export function toPpm(weights, total = 10000) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const scaled = weights.map((w) => (w / sum) * total);
  const floored = scaled.map((x) => Math.floor(x));
  const remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) floored[order[k % order.length].i] += 1;
  return floored;
}

// Modelled clear-sky half-hour shape (ppm) for one zone-month at a centroid.
export function modelledShape(lat, lng, monthIndex) {
  const weights = [];
  for (let slot = 0; slot < 48; slot++) {
    weights.push(clearSkyWeight(lat, lng, DOY_15[monthIndex], slot * 30 + 15));
  }
  return toPpm(weights, 10000);
}

// Modelled monthly GHI (kWh/m^2) for one zone from its annual total and the shared
// month-shape vector.
export function modelledMonthlyGhi(annualGhi, monthShape) {
  const shapeSum = monthShape.reduce((a, b) => a + b, 0);
  return monthShape.map((f) => Math.round(((annualGhi * f) / shapeSum) * 100) / 100);
}

// Build modelled monthlyGhi + profilesPpm for EVERY zone (the default data source).
export function buildModelledProfiles(src) {
  const zoneIds = Object.keys(src.zones).sort();
  const monthlyGhi = {};
  const profilesPpm = {};
  for (const id of zoneIds) {
    const z = src.zones[id];
    monthlyGhi[id] = modelledMonthlyGhi(z.annualGhi, src.monthShape);
    profilesPpm[id] = Array.from({ length: 12 }, (_, m) => modelledShape(z.lat, z.lng, m));
  }
  return { zoneIds, monthlyGhi, profilesPpm };
}
