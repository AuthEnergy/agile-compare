import { describe, it, expect } from 'vitest';
import { splitLongPeriods } from '../../src/domain/periods';
import type { RawPeriod } from '../../src/types/domain';

function period(startISO: string, endISO: string, actual: number | null): RawPeriod {
  return {
    displayStart: new Date(startISO),
    displayEnd: new Date(endISO),
    start: new Date(startISO),
    end: new Date(endISO),
    actualChargePence: actual,
  };
}

describe('splitLongPeriods', () => {
  it('leaves a short period unsplit and preserves its fields', () => {
    const p = { ...period('2026-01-01T00:00:00Z', '2026-01-28T00:00:00Z', 5000), billedKwh: 300 };
    const out = splitLongPeriods([p]);
    expect(out).toHaveLength(1);
    expect(out[0]?.isSplit).toBe(false);
    expect(out[0]?.actualChargePence).toBe(5000);
    expect(out[0]?.billedKwh).toBe(300);
  });

  it('splits a >35-day period into calendar months, day-apportioning the actual', () => {
    // 90 days spanning Jan–Apr; actual apportioned by day count, sums back ~to total.
    const out = splitLongPeriods([period('2026-01-15T00:00:00Z', '2026-04-15T00:00:00Z', 9000)]);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((p) => p.isSplit)).toBe(true);
    const total = out.reduce((s, p) => s + (p.actualChargePence ?? 0), 0);
    expect(Math.abs(total - 9000)).toBeLessThanOrEqual(out.length); // rounding tolerance
    // Contiguous, non-overlapping sub-periods.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.start.getTime()).toBe(out[i - 1]?.end.getTime());
    }
  });

  it('carries a null actual through as null when splitting', () => {
    const out = splitLongPeriods([period('2026-01-15T00:00:00Z', '2026-04-15T00:00:00Z', null)]);
    expect(out.every((p) => p.actualChargePence === null)).toBe(true);
  });
});
