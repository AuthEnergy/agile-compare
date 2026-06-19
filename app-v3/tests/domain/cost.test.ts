import { describe, it, expect } from 'vitest';
import { calculateCost, calculateExportValue } from '../../src/domain/cost';
import type { RateWindow } from '../../src/types/domain';
import { makeReadings } from '../helpers';

describe('calculateCost', () => {
  it('matches a hand calculation (flat rates)', () => {
    const readings = makeReadings('2026-01-01T00:00:00Z', 48 * 5, 0.5); // 120 kWh
    const unit: RateWindow[] = [
      { validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 25 },
    ];
    const standing: RateWindow[] = [
      { validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 50 },
    ];
    const r = calculateCost(
      readings,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-06T00:00:00Z'),
      unit,
      standing,
    );
    expect(r.kwh).toBe(120);
    expect(r.energyCostPence).toBe(120 * 25);
    expect(r.standingChargePence).toBe(5 * 50);
    expect(r.totalPence).toBe(120 * 25 + 5 * 50);
    expect(r.unmatchedReadings).toBe(0);
    expect(r.unmatchedStandingDays).toBe(0);
  });

  it('handles a mid-period rate boundary (noon-of-day standing lookup)', () => {
    const readings = makeReadings('2026-01-01T00:00:00Z', 48 * 10, 1.0); // 480 kWh
    const unit: RateWindow[] = [
      {
        validFrom: new Date('2020-01-01T00:00:00Z'),
        validTo: new Date('2026-01-06T00:00:00Z'),
        value: 20,
      },
      { validFrom: new Date('2026-01-06T00:00:00Z'), validTo: null, value: 30 },
    ];
    const standing: RateWindow[] = [
      {
        validFrom: new Date('2020-01-01T00:00:00Z'),
        validTo: new Date('2026-01-06T00:00:00Z'),
        value: 40,
      },
      { validFrom: new Date('2026-01-06T00:00:00Z'), validTo: null, value: 60 },
    ];
    const r = calculateCost(
      readings,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-11T00:00:00Z'),
      unit,
      standing,
    );
    expect(r.kwh).toBe(480);
    expect(r.energyCostPence).toBe(5 * 48 * 20 + 5 * 48 * 30);
    expect(r.standingChargePence).toBe(5 * 40 + 5 * 60);
  });

  it('flags unmatched readings instead of silently miscalculating', () => {
    const readings = makeReadings('2026-01-01T00:00:00Z', 48, 1.0);
    const unit: RateWindow[] = [
      { validFrom: new Date('2027-01-01T00:00:00Z'), validTo: null, value: 25 },
    ];
    const standing: RateWindow[] = [
      { validFrom: new Date('2027-01-01T00:00:00Z'), validTo: null, value: 50 },
    ];
    const r = calculateCost(
      readings,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-02T00:00:00Z'),
      unit,
      standing,
    );
    expect(r.unmatchedReadings).toBe(48);
    expect(r.energyCostPence).toBe(0);
    expect(r.unmatchedStandingDays).toBe(1);
  });

  it('accepts a realistic 420-day billing period', () => {
    const readings = makeReadings('2025-01-01T00:00:00Z', 48 * 420, 0.3);
    const unit: RateWindow[] = [
      { validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 25 },
    ];
    const standing: RateWindow[] = [
      { validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 45 },
    ];
    const r = calculateCost(
      readings,
      new Date('2025-01-01T00:00:00Z'),
      new Date('2026-02-25T00:00:00Z'),
      unit,
      standing,
    );
    expect(r.kwh).toBeGreaterThan(0);
  });

  it('rejects a genuinely implausible (~36000-day) range', () => {
    expect(() =>
      calculateCost([], new Date('2000-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z'), [], []),
    ).toThrow(/implausible/);
  });
});

describe('calculateExportValue', () => {
  it('values exported energy with no standing charge', () => {
    const readings = makeReadings('2026-01-01T00:00:00Z', 4, 1.0);
    const win: RateWindow[] = [
      { validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 15 },
    ];
    const r = calculateExportValue(
      readings,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-02T00:00:00Z'),
      win,
    );
    expect(r.kwh).toBe(4);
    expect(r.valuePence).toBe(4 * 15);
    expect(r.unmatchedReadings).toBe(0);
  });
});
