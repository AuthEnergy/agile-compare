// Golden-fixture lock: frozen input → output pairs derived from the hardened
// l-wip v2 logic. If a port drifts, these fail. (The per-function suites cover
// behaviour; this is the regression freeze.)
import { describe, it, expect } from 'vitest';
import classifyGolden from '../fixtures/classify-tariff.golden.json';
import { classifyTariffCode } from '../../src/domain/tariff';
import { calculateCost } from '../../src/domain/cost';
import { rateAtSorted } from '../../src/domain/rates';
import type { RateWindow } from '../../src/types/domain';
import { makeReadings } from '../helpers';

describe('golden: classifyTariffCode', () => {
  it.each(classifyGolden as [string, string, string][])('%s -> %s/%s', (code, kind, label) => {
    expect(classifyTariffCode(code)).toEqual({ kind, label });
  });
});

describe('golden: calculateCost frozen scenario', () => {
  it('5 days @ 0.5kWh/hh, 25p unit, 50p/day standing', () => {
    const r = calculateCost(
      makeReadings('2026-01-01T00:00:00Z', 48 * 5, 0.5),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-06T00:00:00Z'),
      [{ validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 25 }],
      [{ validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 50 }],
    );
    expect(r).toEqual({
      kwh: 120,
      energyCostPence: 3000,
      standingChargePence: 250,
      totalPence: 3250,
      unmatchedReadings: 0,
      unmatchedStandingDays: 0,
    });
  });
});

describe('golden: rateAtSorted overlap precedence', () => {
  it('newer window wins on overlap, gap stays null', () => {
    const w: RateWindow[] = [
      {
        validFrom: new Date('2020-01-01T00:00:00Z'),
        validTo: new Date('2023-01-01T00:00:00Z'),
        value: 10,
      },
      { validFrom: new Date('2024-01-01T00:00:00Z'), validTo: null, value: 20 },
    ];
    expect(rateAtSorted(w, new Date('2022-01-01T00:00:00Z'))).toBe(10);
    expect(rateAtSorted(w, new Date('2023-06-01T00:00:00Z'))).toBeNull(); // genuine gap
    expect(rateAtSorted(w, new Date('2025-01-01T00:00:00Z'))).toBe(20);
  });
});
