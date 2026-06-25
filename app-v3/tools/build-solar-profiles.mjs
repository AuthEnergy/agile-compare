// Dev-time generator for src/data/solarProfiles.generated.ts.
//
// Reads the committed climatology source (tools/solar-climatology.json) and emits
// a deterministic, hand-readable TypeScript module. NOT wired into the normal CI
// gate; run it by hand after editing the source, then commit the regenerated file:
//
//     node tools/build-solar-profiles.mjs
//
// HONESTY: the per-zone annual GHI figures are approximate published UK regional
// climatology (horizontal plane). The within-year monthly split and the within-day
// half-hour SHAPE are MODELLED from clear-sky solar geometry at each zone centroid
// in UTC — this is a representative-climatology product, not a measured per-site
// time series. The provenance constant says exactly this; the UI must caveat it.
//
// DETERMINISM: no Date.now()/Math.random(). Re-running on the same source yields a
// byte-identical module (sorted keys, fixed precision, version-derived stamp), so
// the staleness gate stays meaningful.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'solar-climatology.json');
const OUT = join(here, '..', 'src', 'data', 'solarProfiles.generated.ts');

const DEG = Math.PI / 180;
// Day-of-year for the 15th of each month (non-leap representative day).
const DOY_15 = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

// NOAA solar-position: returns sin(solar elevation) at a UTC instant for a site.
// Includes the equation of time and the longitude correction so solar noon lands
// at the true local meridian crossing (east shifts it earlier in UTC). tz = 0 (UTC).
function sinElevation(latDeg, lngDeg, doy, minutesUtc) {
  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (minutesUtc / 60 - 12) / 24);
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const timeOffset = eqTime + 4 * lngDeg; // minutes; tz = 0 (UTC)
  const tst = minutesUtc + timeOffset; // true solar time, minutes
  const ha = (tst / 4 - 180) * DEG; // hour angle, radians
  const lat = latDeg * DEG;
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  return cosZen; // = sin(elevation)
}

// Clear-sky GHI proxy (Kasten-Young air mass × Bras-style transmittance). Only the
// SHAPE matters here — the absolute constant cancels in normalisation. Zero below
// the horizon. This is the diurnal weight the bundled monthly GHI is spread across.
function clearSkyWeight(latDeg, lngDeg, doy, minutesUtc) {
  const s = sinElevation(latDeg, lngDeg, doy, minutesUtc);
  if (s <= 0.001) return 0;
  const elevDeg = Math.asin(Math.min(1, s)) / DEG;
  const airMass = 1 / (s + 0.50572 * Math.pow(6.07995 + elevDeg, -1.6364));
  return s * Math.pow(0.7, Math.pow(airMass, 0.678));
}

// Largest-remainder rounding of weights → integer ppm summing to exactly `total`
// (0 when the day has no daylight, which never happens for UK latitudes/months).
function toPpm(weights, total = 10000) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const scaled = weights.map((w) => (w / sum) * total);
  const floored = scaled.map((x) => Math.floor(x));
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) {
    const idx = order[k % order.length].i;
    floored[idx] += 1;
  }
  return floored;
}

function build() {
  const src = JSON.parse(readFileSync(SRC, 'utf8'));
  const zoneIds = Object.keys(src.zones).sort();

  // Validate every referenced zone exists (areaZones is keyed BY zone).
  const refs = new Set([
    src.defaultZone,
    ...Object.values(src.dnoRegionZone),
    ...Object.keys(src.areaZones),
  ]);
  for (const z of refs) {
    if (!(z in src.zones)) throw new Error(`zone "${z}" referenced but not defined`);
  }

  const shapeSum = src.monthShape.reduce((a, b) => a + b, 0);

  const monthlyGhi = {};
  const profilesPpm = {};
  for (const id of zoneIds) {
    const z = src.zones[id];
    monthlyGhi[id] = src.monthShape.map(
      (f) => Math.round(((z.annualGhi * f) / shapeSum) * 100) / 100,
    );
    const months = [];
    for (let m = 0; m < 12; m++) {
      const weights = [];
      for (let slot = 0; slot < 48; slot++) {
        const mid = slot * 30 + 15; // minutes UTC at slot midpoint
        weights.push(clearSkyWeight(z.lat, z.lng, DOY_15[m], mid));
      }
      months.push(toPpm(weights, 10000));
    }
    profilesPpm[id] = months;
  }

  // Invert zone → [areas] into AREA → zone (the lookup the flow needs).
  const areaZone = {};
  for (const [zone, areas] of Object.entries(src.areaZones)) {
    for (const a of areas) {
      if (areaZone[a]) throw new Error(`postcode area "${a}" mapped to two zones`);
      areaZone[a] = zone;
    }
  }

  return { src, zoneIds, monthlyGhi, profilesPpm, areaZone };
}

function emit({ src, zoneIds, monthlyGhi, profilesPpm, areaZone }) {
  const q = (s) => JSON.stringify(s);
  const sortedObj = (obj, fmtVal) =>
    Object.keys(obj)
      .sort()
      .map((k) => `  ${q(k)}: ${fmtVal(obj[k])},`)
      .join('\n');

  const L = [];
  L.push(
    '// AUTO-GENERATED by tools/build-solar-profiles.mjs — DO NOT EDIT BY HAND.',
    '// Regenerate after editing tools/solar-climatology.json:  node tools/build-solar-profiles.mjs',
    '//',
    '// Per-zone annual GHI is approximate published UK regional climatology (horizontal',
    '// plane). The monthly split and the half-hour shapes are MODELLED clear-sky geometry',
    '// at each zone centroid in UTC — representative climatology, NOT measured site data.',
    '',
    `export const SOLAR_DATA_VERSION = ${q(src.version)};`,
    '',
    'export interface SolarZoneMeta {',
    '  lat: number;',
    '  lng: number;',
    '  label: string;',
    '}',
    '',
    '// Representative centroid per climatological zone. lng is included because it',
    '// shifts solar noon east/west (used by the UTC solar-position model).',
    'export const ZONE_META: Record<string, SolarZoneMeta> = {',
    sortedObj(
      Object.fromEntries(zoneIds.map((id) => [id, src.zones[id]])),
      (z) => `{ lat: ${z.lat}, lng: ${z.lng}, label: ${q(z.label)} }`,
    ),
    '};',
    '',
    '// Monthly global horizontal irradiation, kWh/m^2 (index 0 = January).',
    'export const MONTHLY_GHI_KWH_PER_M2: Record<string, readonly number[]> = {',
    sortedObj(monthlyGhi, (arr) => `[${arr.join(', ')}]`),
    '};',
    '',
    '// Diffuse fraction of GHI by month (shared across zones; cloudy-UK seasonal curve).',
    `export const MONTHLY_DIFFUSE_FRACTION: readonly number[] = [${src.monthlyDiffuseFraction.join(', ')}];`,
    '',
    '// Half-hour diurnal GHI shape as integer parts-per-10000, [month 0..11][slot 0..47].',
    '// Each month sums to exactly 10000 (or 0 for a hypothetical no-daylight day). The PV',
    '// model reconstructs per-slot GHI as MONTHLY_GHI/daysInMonth * (ppm/10000).',
    'export const SOLAR_PROFILES_PPM: Record<string, readonly (readonly number[])[]> = {',
    zoneIds
      .map(
        (id) =>
          `  ${q(id)}: [\n` +
          profilesPpm[id].map((mo) => `    [${mo.join(',')}]`).join(',\n') +
          '\n  ],',
      )
      .join('\n'),
    '};',
    '',
    '// Postcode AREA prefix (alpha part of the outward code, e.g. "BS" from "BS1") → zone.',
    'export const AREA_ZONE: Record<string, string> = {',
    sortedObj(areaZone, (z) => q(z)),
    '};',
    '',
    '// DNO region letter (the trailing letter of an Octopus tariff code) → zone fallback',
    '// when no postcode is available.',
    'export const DNO_REGION_ZONE: Record<string, string> = {',
    sortedObj(src.dnoRegionZone, (z) => q(z)),
    '};',
    '',
    `export const DEFAULT_ZONE = ${q(src.defaultZone)};`,
    '',
    'export const SOLAR_DATA_PROVENANCE = {',
    `  dataset: 'UK regional solar climatology (modelled half-hour shapes)',`,
    `  version: ${q(src.version)},`,
    `  annualGhiBasis: 'Approximate published UK regional GHI averages (horizontal plane).',`,
    `  shapeBasis: 'Clear-sky geometry at zone centroid, UTC (NOAA solar position + Kasten-Young air mass).',`,
    `  coverage: 'Representative climatology — not a measured per-site time series.',`,
    `  license: ${q(src.license)},`,
    `  generatedBy: 'tools/build-solar-profiles.mjs',`,
    `  generatedFrom: ${q(`tools/solar-climatology.json@${src.version}`)},`,
    '} as const;',
    '',
  );
  return L.join('\n');
}

const built = build();
writeFileSync(OUT, emit(built), 'utf8');
const cells = built.zoneIds.length * 12;
console.log(
  `build-solar-profiles: wrote ${OUT}\n  ${built.zoneIds.length} zones, ${cells} zone-months, ` +
    `${Object.keys(built.areaZone).length} postcode areas mapped.`,
);
