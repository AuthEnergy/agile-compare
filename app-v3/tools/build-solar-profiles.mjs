// Dev-time generator for src/data/solarProfiles.generated.ts. NOT in the CI gate;
// run by hand after editing the source, then commit the regenerated file.
//
//   node tools/build-solar-profiles.mjs
//       → modelled clear-sky shapes scaled to approximate regional annual GHI
//         (the committed default; honest representative climatology).
//
//   node tools/build-solar-profiles.mjs --source midas --midas-dir <path/to/midas>
//       → REAL Met Office MIDAS Open "uk-radiation-obs" measured data. Point it at a
//         local CEDA download (badc/ukmo-midas-open/data/uk-radiation-obs/...). Zones
//         with no station coverage fall back to modelled shapes, so output is complete.
//       Add --dry-run --json to print computed structures to stdout without writing
//       (used by the fixture test).
//
// DETERMINISM: no Date.now()/Math.random(); re-running on the same input is
// byte-identical, so the staleness gate stays meaningful.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModelledProfiles } from './midas/modelled.mjs';
import { ingestMidas } from './midas/ingest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'solar-climatology.json');
const OUT = join(here, '..', 'src', 'data', 'solarProfiles.generated.ts');

const MIDAS_DOI = '10.5285/76e54f87291c4cd98c793e37524dc98e';
const MIDAS_UUID = '76e54f87291c4cd98c793e37524dc98e';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

function invertAreaZones(src) {
  const areaZone = {};
  for (const [zone, areas] of Object.entries(src.areaZones)) {
    for (const a of areas) {
      if (areaZone[a]) throw new Error(`postcode area "${a}" mapped to two zones`);
      areaZone[a] = zone;
    }
  }
  return areaZone;
}

function build() {
  const src = JSON.parse(readFileSync(SRC, 'utf8'));

  // Every referenced zone must exist (areaZones is keyed BY zone).
  for (const z of [
    src.defaultZone,
    ...Object.values(src.dnoRegionZone),
    ...Object.keys(src.areaZones),
  ]) {
    if (!(z in src.zones)) throw new Error(`zone "${z}" referenced but not defined`);
  }
  const areaZone = invertAreaZones(src);

  const source = opt('--source') ?? 'modelled';
  if (source === 'midas') {
    const midasDir = opt('--midas-dir');
    if (!midasDir) throw new Error('--source midas requires --midas-dir <path>');
    const midasVersion = opt('--midas-version') ?? 'v202507';
    const ing = ingestMidas({ midasDir: resolve(process.cwd(), midasDir), src });
    const coverage =
      ing.coverage.minYear && ing.coverage.maxYear
        ? `${ing.coverage.minYear}–${ing.coverage.maxYear}`
        : 'unknown';
    const provenance = {
      dataset: 'Met Office MIDAS Open: UK hourly solar radiation data',
      version: midasVersion,
      doi: MIDAS_DOI,
      uuid: MIDAS_UUID,
      coverage: `${coverage} (ingested station-years)`,
      license: 'Open Government Licence v3.0 — requires citation',
      citation: `Met Office (2025): MIDAS Open: UK hourly solar radiation data, ${midasVersion}. NERC EDS Centre for Environmental Data Analysis. doi:${MIDAS_DOI}`,
      shapeBasis:
        'Measured hourly global/diffuse irradiation; hour-ending values mapped to UTC half-hours by elevation weighting.',
      zonesFromMidas: ing.coverage.midasZones,
      zonesModelledFallback: ing.coverage.modelledZones,
      generatedBy: 'tools/build-solar-profiles.mjs --source midas',
      generatedFrom: `MIDAS Open uk-radiation-obs ${midasVersion}`,
    };
    return {
      src,
      source,
      areaZone,
      zoneIds: ing.zoneIds,
      monthlyGhi: ing.monthlyGhi,
      profilesPpm: ing.profilesPpm,
      diffuseFraction: ing.diffuseFraction,
      zoneSources: ing.zoneSources,
      dataVersion: `midas-${midasVersion}`,
      provenance,
    };
  }

  // Default: modelled clear-sky.
  const m = buildModelledProfiles(src);
  const zoneSources = Object.fromEntries(m.zoneIds.map((id) => [id, 'modelled']));
  const provenance = {
    dataset: 'UK regional solar climatology (modelled half-hour shapes)',
    version: src.version,
    annualGhiBasis: 'Approximate published UK regional GHI averages (horizontal plane).',
    shapeBasis:
      'Clear-sky geometry at zone centroid, UTC (NOAA solar position + Kasten-Young air mass).',
    coverage: 'Representative climatology — not a measured per-site time series.',
    license: src.license,
    citation: 'Modelled UK solar climatology — see tools/solar-climatology.json.',
    generatedBy: 'tools/build-solar-profiles.mjs',
    generatedFrom: `tools/solar-climatology.json@${src.version}`,
  };
  return {
    src,
    source,
    areaZone,
    zoneIds: m.zoneIds,
    monthlyGhi: m.monthlyGhi,
    profilesPpm: m.profilesPpm,
    diffuseFraction: src.monthlyDiffuseFraction,
    zoneSources,
    dataVersion: src.version,
    provenance,
  };
}

const q = (s) => JSON.stringify(s);

function serializeProvenance(p) {
  return Object.entries(p)
    .map(([k, v]) => `  ${k}: ${typeof v === 'number' ? v : q(v)},`)
    .join('\n');
}

function emit(built) {
  const { src, source, zoneIds, monthlyGhi, profilesPpm, diffuseFraction, areaZone } = built;
  const sortedObj = (obj, fmtVal) =>
    Object.keys(obj)
      .sort()
      .map((k) => `  ${q(k)}: ${fmtVal(obj[k])},`)
      .join('\n');

  const header =
    source === 'midas'
      ? [
          '// AUTO-GENERATED by tools/build-solar-profiles.mjs --source midas — DO NOT EDIT BY HAND.',
          '//',
          '// Built from Met Office MIDAS Open "uk-radiation-obs" MEASURED hourly irradiation.',
          '// Hour-ending observations are mapped to UTC half-hours by elevation weighting. Zones',
          '// with no station coverage fall back to modelled clear-sky shapes (see provenance).',
        ]
      : [
          '// AUTO-GENERATED by tools/build-solar-profiles.mjs — DO NOT EDIT BY HAND.',
          '// Regenerate after editing tools/solar-climatology.json:  node tools/build-solar-profiles.mjs',
          '//',
          '// Per-zone annual GHI is approximate published UK regional climatology (horizontal',
          '// plane). The monthly split and the half-hour shapes are MODELLED clear-sky geometry',
          '// at each zone centroid in UTC — representative climatology, NOT measured site data.',
        ];

  const L = [
    ...header,
    '',
    `export const SOLAR_DATA_VERSION = ${q(built.dataVersion)};`,
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
    `export const MONTHLY_DIFFUSE_FRACTION: readonly number[] = [${diffuseFraction.join(', ')}];`,
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
    serializeProvenance(built.provenance),
    '} as const;',
    '',
  ];
  return L.join('\n');
}

const built = build();

if (flag('--json')) {
  process.stdout.write(
    JSON.stringify(
      {
        source: built.source,
        dataVersion: built.dataVersion,
        provenance: built.provenance,
        monthlyGhi: built.monthlyGhi,
        profilesPpm: built.profilesPpm,
        diffuseFraction: built.diffuseFraction,
        zoneSources: built.zoneSources,
      },
      null,
      2,
    ),
  );
}

if (!flag('--dry-run')) {
  const outPath = opt('--out') ?? OUT;
  writeFileSync(outPath, emit(built), 'utf8');
  const cells = built.zoneIds.length * 12;
  const midas =
    built.source === 'midas' ? ` (MIDAS: ${built.provenance.zonesFromMidas} zones)` : '';
  process.stderr.write(
    `build-solar-profiles: wrote ${outPath}\n  ${built.zoneIds.length} zones, ${cells} zone-months, ` +
      `${Object.keys(built.areaZone).length} postcode areas${midas}.\n`,
  );
}
