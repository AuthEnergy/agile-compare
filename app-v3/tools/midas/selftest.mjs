// Plain-node unit checks for the MIDAS ingest (imports the .mjs directly, which a
// vitest/tsc test can't do cleanly). Gated by tests/tools/midas.test.ts, which shells
// out to this and asserts it prints "midas selftest OK". Run directly:
//   node tools/midas/selftest.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRadiationFile } from './parseBadcCsv.mjs';
import { assignZone, ingestMidas, splitHourToHalfHours } from './ingest.mjs';
import { modelledMonthlyGhi } from './modelled.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, '..', 'solar-climatology.json'), 'utf8'));
const fixtureDir = join(here, '..', 'fixtures', 'midas');
const fixtureFile = join(
  fixtureDir,
  'midas-open_uk-radiation-obs_dv-202507_devon_01336_exeter-fixture_qcv-1_2020.csv',
);

let failures = 0;
function ok(cond, msg) {
  if (!cond) {
    failures++;
    console.error('  FAIL:', msg);
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// 1) BADC-CSV parse + QC filter + KJ→kWh.
const station = parseRadiationFile(readFileSync(fixtureFile, 'utf8'));
ok(station !== null, 'fixture parses');
ok(station.srcId === '1336', `src_id parsed (got ${station?.srcId})`);
ok(near(station.lat, 50.74) && near(station.lng, -3.4), 'lat/lng parsed from header');
// version_num=0 row (the 9999 spike) must be filtered out.
ok(
  station.rows.every((r) => r.glblKwh < 1.5),
  'QC drops the version_num=0 spike row (no 9999/3600 value)',
);
const noon = station.rows.find((r) => r.obEndTime.toISOString() === '2020-06-15T12:00:00.000Z');
ok(noon !== undefined, 'noon row present');
ok(near(noon.glblKwh, 3200 / 3600, 1e-6), 'KJ→kWh: 3200 KJ/m² → 0.8889 kWh/m²');
ok(near(noon.difuKwh, 920 / 3600, 1e-6), 'diffuse KJ→kWh parsed');

// 2) Hour-ending → UTC half-hour split (the off-by-one trap).
const halves = splitHourToHalfHours(station.lat, station.lng, noon.obEndTime, noon.glblKwh);
ok(halves.length === 2, 'split returns two half-hours');
ok(
  halves[0].slotStart.toISOString() === '2020-06-15T11:00:00.000Z' &&
    halves[1].slotStart.toISOString() === '2020-06-15T11:30:00.000Z',
  'the 12:00-ending hour maps to the 11:00 and 11:30 slots (hour-ending, not hour-starting)',
);
ok(near(halves[0].kwh + halves[1].kwh, noon.glblKwh, 1e-9), 'split conserves energy');
ok(halves[0].kwh > 0 && halves[1].kwh > 0, 'both midday half-hours are lit');
// A rising-sun hour weights the later half more.
const dawn = station.rows.find((r) => r.obEndTime.toISOString() === '2020-06-15T05:00:00.000Z');
const dawnHalves = splitHourToHalfHours(station.lat, station.lng, dawn.obEndTime, dawn.glblKwh);
ok(near(dawnHalves[0].kwh + dawnHalves[1].kwh, dawn.glblKwh, 1e-9), 'dawn split conserves energy');
ok(dawnHalves[1].kwh >= dawnHalves[0].kwh, 'rising sun weights the later half-hour more');

// 3) Station → nearest zone.
ok(assignZone(50.74, -3.4, src.zones) === 'south-west', 'Exeter station assigns to south-west');
ok(assignZone(57.5, -4.2, src.zones) === 'scotland-north', 'a Highlands point assigns north');

// 4) Full ingest: measured for the covered zone, modelled fallback elsewhere.
const out = ingestMidas({ midasDir: fixtureDir, src });
ok(out.zoneSources['south-west'] === 'midas', 'south-west sourced from MIDAS');
ok(out.zoneSources['london'] === 'modelled', 'uncovered zone falls back to modelled');
ok(out.coverage.midasZones === 1, 'one zone from MIDAS');
const swJune = out.profilesPpm['south-west'][5];
ok(swJune.reduce((a, b) => a + b, 0) === 10000, 'measured June shape sums to exactly 10000 ppm');
ok(swJune[0] === 0, 'measured June midnight slot is zero');
ok(out.monthlyGhi['south-west'][5] > 0, 'measured June monthly GHI is positive');
const modelledLondon = modelledMonthlyGhi(src.zones['london'].annualGhi, src.monthShape);
ok(
  near(out.monthlyGhi['london'][5], modelledLondon[5], 1e-9),
  'fallback zone matches the modelled monthly GHI',
);
ok(
  out.diffuseFraction[5] > 0 && out.diffuseFraction[5] < 1,
  'measured June diffuse fraction in (0,1)',
);

if (failures === 0) console.log('midas selftest OK');
else {
  console.error(`midas selftest FAILED (${failures})`);
  process.exit(1);
}
