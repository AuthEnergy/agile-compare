// Ingest real MIDAS Open "uk-radiation-obs" BADC-CSV files into the bundled
// solar-profile shape. Pure data transforms (no app dependency). Zones with no
// station coverage fall back to the modelled clear-sky profiles, so the output is
// always complete.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { haversineKm, sinElevationAt } from './solarGeom.mjs';
import { parseRadiationFile } from './parseBadcCsv.mjs';
import { buildModelledProfiles, modelledMonthlyGhi, modelledShape, toPpm } from './modelled.mjs';

const HALF_HOUR_MS = 30 * 60 * 1000;

function daysInMonthUtc(monthIndex) {
  return new Date(Date.UTC(2021, monthIndex + 1, 0)).getUTCDate(); // non-leap reference
}

// Assign a station to the nearest zone centroid.
export function assignZone(lat, lng, zones) {
  let best = null;
  let bestKm = Infinity;
  for (const [id, z] of Object.entries(zones)) {
    const km = haversineKm(lat, lng, z.lat, z.lng);
    if (km < bestKm) {
      bestKm = km;
      best = id;
    }
  }
  return best;
}

// Split one hour-ENDING observation into its two UTC half-hour slots, weighting the
// energy by clear-sky elevation at each half-hour midpoint. This is the documented
// hour-ending → half-hour mapping (the off-by-one trap): the value at ob_end_time T
// covers [T−1h, T), i.e. half-hours [T−60, T−30) and [T−30, T).
export function splitHourToHalfHours(lat, lng, obEndTime, glblKwh) {
  const endMs = obEndTime.getTime();
  const startMs = endMs - 2 * HALF_HOUR_MS;
  const s1 = new Date(startMs);
  const s2 = new Date(startMs + HALF_HOUR_MS);
  const mid1 = new Date(startMs + HALF_HOUR_MS / 2);
  const mid2 = new Date(startMs + HALF_HOUR_MS + HALF_HOUR_MS / 2);
  let w1 = Math.max(0, sinElevationAt(lat, lng, mid1));
  let w2 = Math.max(0, sinElevationAt(lat, lng, mid2));
  if (w1 + w2 <= 0) {
    w1 = 0.5;
    w2 = 0.5; // both below the horizon (≈0 energy anyway) → split evenly, lose nothing
  }
  const total = w1 + w2;
  return [
    { slotStart: s1, kwh: (glblKwh * w1) / total },
    { slotStart: s2, kwh: (glblKwh * w2) / total },
  ];
}

function slotOfDay(date) {
  return date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0);
}

function* walkCsv(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkCsv(p);
    else if (name.toLowerCase().endsWith('.csv')) yield p;
  }
}

// Ingest a directory tree of MIDAS radiation CSVs. Returns the same shape the
// generator emits, plus per-zone provenance.
export function ingestMidas({ midasDir, src }) {
  const zones = src.zones;
  const zoneIds = Object.keys(zones).sort();

  // Per zone: shape[month][48] kWh accumulators, monthly kWh sum, observed-day set,
  // and diffuse/global accumulators (only where diffuse is present).
  const acc = {};
  for (const id of zoneIds) {
    acc[id] = {
      shape: Array.from({ length: 12 }, () => new Array(48).fill(0)),
      monthKwh: new Array(12).fill(0),
      days: Array.from({ length: 12 }, () => new Set()),
      difu: new Array(12).fill(0),
      glblWithDifu: new Array(12).fill(0),
      stations: new Set(),
    };
  }

  let minYear = Infinity;
  let maxYear = -Infinity;
  let filesUsed = 0;

  for (const file of walkCsv(midasDir)) {
    let station;
    try {
      station = parseRadiationFile(readFileSync(file, 'utf8'));
    } catch {
      station = null;
    }
    if (!station) continue;
    const zoneId = assignZone(station.lat, station.lng, zones);
    if (!zoneId) continue;
    const a = acc[zoneId];
    a.stations.add(station.srcId ?? `${station.lat},${station.lng}`);
    filesUsed++;

    for (const row of station.rows) {
      const halves = splitHourToHalfHours(station.lat, station.lng, row.obEndTime, row.glblKwh);
      for (const h of halves) {
        const m = h.slotStart.getUTCMonth();
        a.shape[m][slotOfDay(h.slotStart)] += h.kwh;
        a.monthKwh[m] += h.kwh;
        a.days[m].add(
          `${h.slotStart.getUTCFullYear()}-${h.slotStart.getUTCMonth()}-${h.slotStart.getUTCDate()}`,
        );
        const y = h.slotStart.getUTCFullYear();
        if (y < minYear) minYear = y;
        if (y > maxYear) maxYear = y;
      }
      if (row.difuKwh !== null) {
        const m = row.obEndTime.getUTCMonth();
        a.difu[m] += row.difuKwh;
        a.glblWithDifu[m] += row.glblKwh;
      }
    }
  }

  const monthlyGhi = {};
  const profilesPpm = {};
  const zoneSources = {};
  // Shared monthly diffuse fraction: mean of measured fractions across zones, with a
  // modelled cloudy-UK fallback where nothing was measured.
  const difuNum = new Array(12).fill(0);
  const difuDen = new Array(12).fill(0);

  for (const id of zoneIds) {
    const a = acc[id];
    const hasData = a.monthKwh.some((v, m) => v > 0 && a.days[m].size > 0);
    if (hasData) {
      zoneSources[id] = 'midas';
      monthlyGhi[id] = a.monthKwh.map((kwh, m) => {
        const nDays = a.days[m].size;
        if (nDays === 0) {
          // No data this month → modelled fill for just this month.
          return modelledMonthlyGhi(zones[id].annualGhi, src.monthShape)[m];
        }
        return Math.round((kwh / nDays) * daysInMonthUtc(m) * 100) / 100;
      });
      profilesPpm[id] = a.shape.map((slots, m) =>
        a.days[m].size > 0 ? toPpm(slots, 10000) : modelledShape(zones[id].lat, zones[id].lng, m),
      );
      for (let m = 0; m < 12; m++) {
        if (a.glblWithDifu[m] > 0) {
          difuNum[m] += a.difu[m];
          difuDen[m] += a.glblWithDifu[m];
        }
      }
    } else {
      zoneSources[id] = 'modelled';
      monthlyGhi[id] = modelledMonthlyGhi(zones[id].annualGhi, src.monthShape);
      profilesPpm[id] = Array.from({ length: 12 }, (_, m) =>
        modelledShape(zones[id].lat, zones[id].lng, m),
      );
    }
  }

  const diffuseFraction = src.monthlyDiffuseFraction.map((fallback, m) =>
    difuDen[m] > 0 ? Math.round((difuNum[m] / difuDen[m]) * 1000) / 1000 : fallback,
  );

  const midasZones = Object.values(zoneSources).filter((s) => s === 'midas').length;
  if (midasZones === 0) {
    throw new Error(
      `No usable MIDAS radiation files found under ${midasDir} — check the path and that files are uk-radiation-obs BADC-CSV.`,
    );
  }

  return {
    zoneIds,
    monthlyGhi,
    profilesPpm,
    diffuseFraction,
    zoneSources,
    coverage: {
      minYear: Number.isFinite(minYear) ? minYear : null,
      maxYear: Number.isFinite(maxYear) ? maxYear : null,
      filesUsed,
      midasZones,
      modelledZones: zoneIds.length - midasZones,
    },
  };
}

// Re-export so the generator's default path and the fallback share one implementation.
export { buildModelledProfiles };
