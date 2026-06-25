import { describe, it, expect } from 'vitest';
import { recomputeSolar, type SolarExportWindows } from '../../src/flows/runSolar';
import { DEFAULT_SOLAR_CONFIG } from '../../src/types/solar';
import type { ComparisonRun } from '../../src/types/result';
import type { RateWindow } from '../../src/types/domain';
import { makeRun } from '../diagnostics/runFactory';
import { makeReadings } from '../helpers';

const NO_OCTOPUS: SolarExportWindows = {
  agileOutgoing: [],
  flatOutgoing: [],
  source: 'none',
};
const flat = (p: number): RateWindow[] => [
  { validFrom: new Date('2024-01-01T00:00:00Z'), validTo: null, value: p },
];

// A one-week current-tariff run in June with a flat half-hourly load and a chosen
// import basis. summaryScopePeriods returns this single period.
function solarRun(loadKwh: number, withAgile: boolean): ComparisonRun {
  const run = makeRun([
    {
      start: '2025-06-01T00:00:00Z',
      end: '2025-06-08T00:00:00Z',
      flexEnergy: 100,
      flexStanding: 10,
      agileEnergy: withAgile ? 80 : null,
    },
  ]);
  run.detail.readings = makeReadings('2025-06-01T00:00:00Z', 7 * 48, loadKwh);
  run.detail.flexUnitSorted = flat(25);
  run.detail.agileUnitSorted = withAgile ? flat(20) : [];
  run.detail.agileAvailable = withAgile;
  run.context.postcodeArea = 'BS1';
  run.context.regionLetter = 'L';
  return run;
}

describe('recomputeSolar (pure valuation)', () => {
  it('values generation, computes coverage, and falls back to an assumed SEG rate', () => {
    const run = solarRun(0.2, true);
    const { result } = recomputeSolar(run, DEFAULT_SOLAR_CONFIG, NO_OCTOPUS, { segRatePence: 5 });
    expect(result.generation.modelledKwh).toBeGreaterThan(0);
    expect(result.tariffBasis).toBe('agile');
    expect(result.usedAssumedSeg).toBe(true);
    expect(result.bases).toHaveLength(1);
    expect(result.bases[0]?.kind).toBe('seg-assumed');
    expect(result.generation.coverage).toBeGreaterThan(0.95);
    expect(result.importSavingPence).toBeGreaterThan(0);
    expect(result.solarDataVersion).toBeTruthy();
  });

  it('a missing-load half-hour still counts toward modelled generation but lowers coverage', () => {
    const full = recomputeSolar(solarRun(0.2, true), DEFAULT_SOLAR_CONFIG, NO_OCTOPUS, {});
    const gappy = solarRun(0.2, true);
    gappy.detail.readings = gappy.detail.readings.slice(48); // drop the first day's readings
    const partial = recomputeSolar(gappy, DEFAULT_SOLAR_CONFIG, NO_OCTOPUS, {});
    // Modelled total is unchanged (it's the full skeleton), coverage drops.
    expect(partial.result.generation.modelledKwh).toBeCloseTo(
      full.result.generation.modelledKwh,
      6,
    );
    expect(partial.result.generation.coverage).toBeLessThan(0.95);
    expect(partial.result.generation.coverage).toBeGreaterThan(0.6);
  });

  it('self-consumption is valued on Flexible with no Agile (never zero-rated)', () => {
    // High load so all generation is self-consumed (no export).
    const run = solarRun(1, false);
    const { result } = recomputeSolar(run, DEFAULT_SOLAR_CONFIG, NO_OCTOPUS, {});
    expect(result.tariffBasis).toBe('flexible');
    expect(result.tariffBasisLabel).toBe('Flexible');
    expect(result.generation.selfConsumedKwh).toBeGreaterThan(0);
    expect(result.importSavingPence).toBeGreaterThan(0);
    expect(result.bases[0]?.totalPence).toBeGreaterThan(0);
  });

  it('prices export under both Octopus Outgoing sources when present', () => {
    const run = solarRun(0.05, true); // low load → surplus to export
    const windows: SolarExportWindows = {
      agileOutgoing: flat(10),
      flatOutgoing: flat(15),
      source: 'octopus',
    };
    const { result } = recomputeSolar(run, DEFAULT_SOLAR_CONFIG, windows, {});
    expect(result.usedAssumedSeg).toBe(false);
    expect(result.bases.map((b) => b.kind)).toEqual(['agile-outgoing', 'flat-outgoing']);
    expect(result.generation.exportKwh).toBeGreaterThan(0);
    // Flat 15p export beats Agile-outgoing 10p on the same surplus.
    const agile = result.bases.find((b) => b.kind === 'agile-outgoing');
    const flatBasis = result.bases.find((b) => b.kind === 'flat-outgoing');
    expect(flatBasis?.exportValuePence ?? 0).toBeGreaterThan(agile?.exportValuePence ?? 0);
  });

  it('flags a short usage window for the seasonal-bias caveat', () => {
    const run = makeRun([
      {
        start: '2025-06-01T00:00:00Z',
        end: '2025-06-08T00:00:00Z',
        flexEnergy: 100,
        flexStanding: 10,
      },
    ]);
    run.detail.readings = makeReadings('2025-06-01T00:00:00Z', 7 * 48, 0.2);
    const { result, caveats } = recomputeSolar(run, DEFAULT_SOLAR_CONFIG, NO_OCTOPUS, {});
    expect(result.shortWindow).toBe(true);
    expect(caveats.some((c) => c.toLowerCase().includes('shorter than a month'))).toBe(true);
  });
});
