// Solar "what-if" flow (Phase A — solar only). Returns a typed SolarRun; NO DOM.
//
// runSolar (async) fetches the real Octopus export rates ONCE and hands back the
// rate windows so the UI can cache them; later input tweaks call recomputeSolar
// (pure, synchronous) without re-fetching. Self-consumption (avoided import) is
// valued on the per-slot import basis (Agile when available, else Flexible); export
// surplus is valued under each Octopus Outgoing source we found, or a clearly-
// labelled assumed flat SEG rate when none is available (e.g. sample/replay, or a
// region with no Outgoing product).

import type { OctopusClient } from '../api/client';
import {
  fetchMergedRateWindows,
  findFlatOutgoingProducts,
  findProductsByDisplayNameOverlapping,
} from '../api/products';
import { rateAtSorted } from '../domain/rates';
import { summaryScopePeriods } from '../domain/headline';
import { modelledGeneration, resolveZone, scopeWindowDays } from '../domain/solar';
import { SOLAR_DATA_PROVENANCE, SOLAR_DATA_VERSION } from '../data/solarProfiles.generated';
import type { RateWindow } from '../types/domain';
import type { ComparisonRun, ProgressFn } from '../types/result';
import type {
  SolarConfig,
  SolarExportBasis,
  SolarMonthRow,
  SolarResult,
  SolarRun,
  SolarTariffBasis,
} from '../types/solar';

// Assumed flat SEG when we have no Octopus export rate. Deliberately low and
// illustrative (real SEG offers vary widely); the user can change it and the UI
// must label it as an assumption, never a quoted rate.
export const DEFAULT_SEG_PENCE = 5;

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export interface SolarExportWindows {
  agileOutgoing: RateWindow[];
  flatOutgoing: RateWindow[];
  // Whether any Octopus export rates were actually fetched (false for sample/replay,
  // a null client, a region with no Outgoing product, or a failed fetch).
  source: 'octopus' | 'none';
}

export interface RecomputeOpts {
  segRatePence?: number;
}

function scopeSpan(run: ComparisonRun): { from: Date; to: Date } {
  const periods = summaryScopePeriods(run);
  let from = Infinity;
  let to = -Infinity;
  for (const p of periods) {
    from = Math.min(from, p.start.getTime());
    to = Math.max(to, p.end.getTime());
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { from: run.context.periodFrom, to: run.context.periodTo };
  }
  return { from: new Date(from), to: new Date(to) };
}

// Pure valuation + figures from already-fetched export windows. No fetch, no DOM —
// safe to call on every input tweak.
export function recomputeSolar(
  run: ComparisonRun,
  cfg: SolarConfig,
  exportWindows: SolarExportWindows,
  opts: RecomputeOpts = {},
): SolarRun {
  const segRatePence = opts.segRatePence ?? DEFAULT_SEG_PENCE;
  const periods = summaryScopePeriods(run);
  const zone = resolveZone(run.context.postcodeArea, run.context.regionLetter);
  const { slots, modelledKwh } = modelledGeneration(periods, cfg, zone);

  const agileAvailable = run.detail.agileAvailable && run.detail.agileUnitSorted.length > 0;
  const tariffBasis: SolarTariffBasis = agileAvailable ? 'agile' : 'flexible';
  const importWindows = agileAvailable ? run.detail.agileUnitSorted : run.detail.flexUnitSorted;

  // Load by UTC half-hour slot start (ms).
  const loadByMs = new Map<number, number>();
  for (const r of run.detail.readings) loadByMs.set(r.start.getTime(), r.kwh);

  const hasAgileOut = exportWindows.agileOutgoing.length > 0;
  const hasFlatOut = exportWindows.flatOutgoing.length > 0;

  let valuedKwh = 0;
  let selfConsumedKwh = 0;
  let exportKwh = 0;
  let importSavingPence = 0;
  let exportAgilePence = 0;
  let exportFlatPence = 0;

  // Monthly buckets: generation is the FULL modelled total per month; self-consumed
  // and export are the valued (covered) portion.
  const months = new Map<string, SolarMonthRow>();
  const bucket = (d: Date): SolarMonthRow => {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    let row = months.get(key);
    if (!row) {
      row = {
        key,
        label: `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        generatedKwh: 0,
        selfConsumedKwh: 0,
        exportKwh: 0,
      };
      months.set(key, row);
    }
    return row;
  };

  for (const slot of slots) {
    const gen = slot.kwh;
    const row = bucket(slot.start);
    row.generatedKwh += gen;

    const load = loadByMs.get(slot.start.getTime());
    if (load === undefined) continue; // no usage reading → not valued, lowers coverage
    const importRate = rateAtSorted(importWindows, slot.start);
    if (importRate === null) continue; // no import price for this slot → not valued

    const selfConsumed = Math.min(gen, load);
    const surplus = gen - selfConsumed;
    valuedKwh += gen;
    selfConsumedKwh += selfConsumed;
    exportKwh += surplus;
    importSavingPence += selfConsumed * importRate;
    row.selfConsumedKwh += selfConsumed;
    row.exportKwh += surplus;

    if (surplus > 0) {
      if (hasAgileOut) {
        const r = rateAtSorted(exportWindows.agileOutgoing, slot.start);
        if (r !== null) exportAgilePence += surplus * r;
      }
      if (hasFlatOut) {
        const r = rateAtSorted(exportWindows.flatOutgoing, slot.start);
        if (r !== null) exportFlatPence += surplus * r;
      }
    }
  }

  const bases: SolarExportBasis[] = [];
  if (hasAgileOut) {
    bases.push({
      kind: 'agile-outgoing',
      label: 'Agile Outgoing Octopus',
      exportValuePence: exportAgilePence,
      totalPence: importSavingPence + exportAgilePence,
    });
  }
  if (hasFlatOut) {
    bases.push({
      kind: 'flat-outgoing',
      label: 'Outgoing Octopus',
      exportValuePence: exportFlatPence,
      totalPence: importSavingPence + exportFlatPence,
    });
  }
  const usedAssumedSeg = bases.length === 0;
  if (usedAssumedSeg) {
    const segValue = exportKwh * segRatePence;
    bases.push({
      kind: 'seg-assumed',
      label: 'assumed SEG rate',
      exportValuePence: segValue,
      totalPence: importSavingPence + segValue,
    });
  }

  const coverage = modelledKwh > 0 ? valuedKwh / modelledKwh : 0;
  const windowDays = scopeWindowDays(periods);
  const shortWindow = windowDays > 0 && windowDays < 28;

  const result: SolarResult = {
    config: cfg,
    zoneId: zone.zoneId,
    zoneLabel: zone.label,
    zoneResolvedBy: zone.resolvedBy,
    tariffBasis,
    tariffBasisLabel: tariffBasis === 'agile' ? 'Agile' : 'Flexible',
    generation: {
      modelledKwh,
      valuedKwh,
      coverage,
      selfConsumedKwh,
      exportKwh,
    },
    importSavingPence,
    bases,
    segRatePence,
    usedAssumedSeg,
    perMonth: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)),
    windowDays,
    shortWindow,
    solarDataVersion: SOLAR_DATA_VERSION,
    provenance: {
      version: SOLAR_DATA_PROVENANCE.version,
      license: SOLAR_DATA_PROVENANCE.license,
      citation: SOLAR_DATA_PROVENANCE.citation,
    },
  };

  return { result, caveats: buildCaveats(result) };
}

function buildCaveats(r: SolarResult): string[] {
  const c: string[] = [
    'This is an estimate from average local climate, not your actual weather — a real array on your roof could generate more or less.',
    'Modelled over your own usage for this period only; it is not a forecast of future savings.',
    'No shading, soiling or panel degradation is modelled, so real output may be lower.',
    'The figure is the gross value of the energy. It is not net of the cost of buying and installing equipment.',
  ];
  if (r.zoneResolvedBy !== 'postcode-area') {
    c.push(
      r.zoneResolvedBy === 'dno-region'
        ? 'Location is based on your electricity region, not your postcode, so the local climate estimate is coarser.'
        : 'No location was available, so a UK-average climate was used.',
    );
  }
  if (r.usedAssumedSeg) {
    c.push(
      `No Octopus export rate was available, so an assumed flat ${r.segRatePence}p/kWh export rate was used — change it to match your own.`,
    );
  }
  if (r.shortWindow) {
    c.push(
      'This usage window is shorter than a month, so it does not capture a full year of seasons — treat the figure with extra caution.',
    );
  }
  if (r.generation.coverage < 0.85) {
    c.push(
      'Some half-hours had no usage reading, so the value covers only part of the modelled generation (see coverage).',
    );
  }
  return c;
}

// Fetch the Octopus export rates once, then value. Falls back to an assumed flat
// SEG rate (no fetch) when there is no client or no Outgoing product for the region.
export async function runSolar(
  client: OctopusClient | null,
  run: ComparisonRun,
  cfg: SolarConfig,
  opts: RecomputeOpts & { onProgress?: ProgressFn } = {},
): Promise<{ run: SolarRun; exportWindows: SolarExportWindows }> {
  const onProgress = opts.onProgress ?? (() => {});
  const region = run.context.regionLetter;
  const canFetch = client !== null && !!region && region !== 'MPAN_FOUND_NO_REGION';

  let exportWindows: SolarExportWindows = {
    agileOutgoing: [],
    flatOutgoing: [],
    source: 'none',
  };

  if (canFetch && client) {
    const { from, to } = scopeSpan(run);
    try {
      onProgress('Fetching Agile Outgoing export rates…', 'active', 35);
      const agileProducts = await findProductsByDisplayNameOverlapping(
        client,
        'Agile Outgoing Octopus',
        from,
        to,
      );
      const agileMerged = await fetchMergedRateWindows(
        client,
        agileProducts,
        region,
        'standard-unit-rates',
        from,
        to,
      );

      onProgress('Fetching Outgoing Octopus (flat export) rates…', 'active', 65);
      // Covers the historical FIXED flat export ("Outgoing Octopus 12M Fixed") too,
      // which the variable-only lookup misses for pre-2024-10-28 windows.
      const flatProducts = await findFlatOutgoingProducts(client, from, to);
      const flatMerged = await fetchMergedRateWindows(
        client,
        flatProducts,
        region,
        'standard-unit-rates',
        from,
        to,
      );

      const agileOutgoing = agileMerged.windows;
      const flatOutgoing = flatMerged.windows;
      exportWindows = {
        agileOutgoing,
        flatOutgoing,
        source: agileOutgoing.length || flatOutgoing.length ? 'octopus' : 'none',
      };
    } catch {
      // Leave the SEG fallback in place; the caveat says an assumed rate was used.
      exportWindows = { agileOutgoing: [], flatOutgoing: [], source: 'none' };
    }
  }

  onProgress('Modelling generation and value…', 'active', 90);
  const solarRun = recomputeSolar(run, cfg, exportWindows, opts);
  onProgress('Done.', 'ok', 100);
  return { run: solarRun, exportWindows };
}
