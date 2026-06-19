import { describe, it, expect } from 'vitest';
import { buildDayComparisons, buildSlotCalculations } from '../../src/domain/drilldown';
import { calculateCost } from '../../src/domain/cost';
import type { RateWindow } from '../../src/types/domain';
import type { RunDetail } from '../../src/types/result';
import type { PeriodWindow } from '../../src/types/drilldown';
import { makeReadings } from '../helpers';

function must<T>(v: T | undefined, msg: string): T {
  if (v == null) throw new Error(msg);
  return v;
}

const win = (fromISO: string, p: number): RateWindow => ({
  validFrom: new Date(fromISO),
  validTo: null,
  value: p,
});

const FLEX_UNIT = [win('2025-01-01T00:00:00Z', 24)];
const AGILE_UNIT = [win('2025-01-01T00:00:00Z', 18)];
const FLEX_STANDING = [win('2025-01-01T00:00:00Z', 50)];
const AGILE_STANDING = [win('2025-01-01T00:00:00Z', 45)];

function makeDetail(readings = makeReadings('2025-03-01T00:00:00Z', 144, 0.5)): RunDetail {
  return {
    readings,
    flexUnitSorted: FLEX_UNIT,
    agileUnitSorted: AGILE_UNIT,
    flexStanding: FLEX_STANDING,
    agileStanding: AGILE_STANDING,
    agileAvailable: true,
    duplicateIntervals: new Set<number>(),
  };
}

const sum = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((s, x) => s + f(x), 0);

describe('buildDayComparisons — Σ days === period invariant', () => {
  it('reproduces calculateCost over a full UTC period (energy, standing, total; flex + agile)', () => {
    const detail = makeDetail();
    const period: PeriodWindow = {
      start: new Date('2025-03-01T00:00:00Z'),
      end: new Date('2025-03-04T00:00:00Z'),
    };
    const flex = calculateCost(
      detail.readings,
      period.start,
      period.end,
      FLEX_UNIT,
      FLEX_STANDING,
      true,
    );
    const agile = calculateCost(
      detail.readings,
      period.start,
      period.end,
      AGILE_UNIT,
      AGILE_STANDING,
      true,
    );
    const days = buildDayComparisons(period, detail);

    expect(days).toHaveLength(3);
    expect(sum(days, (d) => d.flexEnergyPence)).toBeCloseTo(flex.energyCostPence, 6);
    expect(sum(days, (d) => d.standingPence.flex)).toBeCloseTo(flex.standingChargePence, 6);
    expect(sum(days, (d) => d.flexTotalPence)).toBeCloseTo(flex.totalPence, 6);
    expect(sum(days, (d) => d.agileEnergyPence ?? 0)).toBeCloseTo(agile.energyCostPence, 6);
    expect(sum(days, (d) => d.standingPence.agile ?? 0)).toBeCloseTo(agile.standingChargePence, 6);
    expect(sum(days, (d) => d.agileTotalPence ?? 0)).toBeCloseTo(agile.totalPence, 6);
  });

  it('matches calculateCost on a clamped period — partial first day, noon-skipped standing', () => {
    const detail = makeDetail();
    const period: PeriodWindow = {
      start: new Date('2025-03-01T14:00:00Z'),
      end: new Date('2025-03-04T00:00:00Z'),
    };
    const flex = calculateCost(
      detail.readings,
      period.start,
      period.end,
      FLEX_UNIT,
      FLEX_STANDING,
      true,
    );
    const days = buildDayComparisons(period, detail);

    expect(days).toHaveLength(3);
    expect(must(days[0], 'day0').flags.partial).toBe(true);
    // first day's 12:00 noon precedes the 14:00 clamp, so it carries no standing
    expect(must(days[0], 'day0').standingPence.flex).toBe(0);
    expect(sum(days, (d) => d.flexEnergyPence)).toBeCloseTo(flex.energyCostPence, 6);
    expect(sum(days, (d) => d.standingPence.flex)).toBeCloseTo(flex.standingChargePence, 6);
    expect(flex.standingChargePence).toBe(100); // 2 of 3 days
  });
});

describe('buildSlotCalculations — 48-slot skeleton + Σ slots === day energy', () => {
  it('left-joins readings, prices each slot, and sums to the day energy', () => {
    const detail = makeDetail();
    const period: PeriodWindow = {
      start: new Date('2025-03-01T00:00:00Z'),
      end: new Date('2025-03-04T00:00:00Z'),
    };
    const days = buildDayComparisons(period, detail);
    const day2 = must(days[1], 'day2');
    const slots = buildSlotCalculations(day2.date, period, detail);

    expect(slots).toHaveLength(48);
    expect(sum(slots, (s) => s.flexCostPence ?? 0)).toBeCloseTo(day2.flexEnergyPence, 6);
    expect(sum(slots, (s) => s.agileCostPence ?? 0)).toBeCloseTo(day2.agileEnergyPence ?? 0, 6);
  });

  it('flags a missing in-period slot as a gap (not zero) and keeps the day Σ consistent', () => {
    const missingMs = new Date('2025-03-02T10:00:00Z').getTime();
    const readings = makeReadings('2025-03-01T00:00:00Z', 144, 0.5).filter(
      (r) => r.start.getTime() !== missingMs,
    );
    const detail = makeDetail(readings);
    const period: PeriodWindow = {
      start: new Date('2025-03-01T00:00:00Z'),
      end: new Date('2025-03-04T00:00:00Z'),
    };
    const days = buildDayComparisons(period, detail);
    const day2 = must(days[1], 'day2');
    const slots = buildSlotCalculations(day2.date, period, detail);

    const gap = must(
      slots.find((s) => s.intervalStart.getTime() === missingMs),
      'gap slot',
    );
    expect(gap.flags.missingReading).toBe(true);
    expect(gap.kwh).toBeNull();
    expect(gap.flexCostPence).toBeNull();
    // 47 priced slots still reconcile to the (reduced) day energy
    expect(sum(slots, (s) => s.flexCostPence ?? 0)).toBeCloseTo(day2.flexEnergyPence, 6);
  });

  it('marks out-of-period boundary slots (never priced) and duplicate intervals', () => {
    const dupMs = new Date('2025-03-01T16:00:00Z').getTime();
    const detail: RunDetail = { ...makeDetail(), duplicateIntervals: new Set([dupMs]) };
    const period: PeriodWindow = {
      start: new Date('2025-03-01T14:00:00Z'),
      end: new Date('2025-03-04T00:00:00Z'),
    };
    const slots = buildSlotCalculations(new Date('2025-03-01T00:00:00Z'), period, detail);

    const first = must(slots[0], 'slot0'); // 00:00, before the 14:00 clamp
    expect(first.flags.outOfPeriod).toBe(true);
    expect(first.flexCostPence).toBeNull();

    const inPeriod = must(
      slots.find((s) => s.intervalStart.getTime() === new Date('2025-03-01T14:00:00Z').getTime()),
      'slot 14:00',
    );
    expect(inPeriod.flags.outOfPeriod).toBe(false);
    expect(inPeriod.flexCostPence).toBeCloseTo(0.5 * 24, 6);

    const dup = must(
      slots.find((s) => s.intervalStart.getTime() === dupMs),
      'dup slot',
    );
    expect(dup.flags.duplicate).toBe(true);
  });
});
