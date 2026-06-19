import { describe, it, expect } from 'vitest';
import { detectGaps, estimateMissingKwh } from '../../src/domain/gaps';
import { makeReadings } from '../helpers';

const STEP = 30 * 60 * 1000;

describe('detectGaps', () => {
  it('finds no gaps or duplicates in clean data', () => {
    const { gaps, duplicates } = detectGaps(makeReadings('2026-01-01T00:00:00Z', 48, 0.5));
    expect(gaps).toHaveLength(0);
    expect(duplicates).toHaveLength(0);
  });

  it('finds known gaps (sizes [1,3]) and a duplicate', () => {
    let readings = makeReadings('2026-01-01T00:00:00Z', 200, 0.3);
    readings = readings.filter((_, i) => ![50, 51, 52, 100].includes(i));
    const tenth = readings[10];
    if (!tenth) throw new Error('fixture broken');
    readings.push({ ...tenth });

    const { gaps, duplicates } = detectGaps(readings);
    expect(gaps).toHaveLength(2);
    expect(duplicates).toHaveLength(1);
    const sizes = gaps
      .map((g) => Math.round((g.end.getTime() - g.start.getTime()) / STEP) + 1)
      .sort((a, b) => a - b);
    expect(sizes).toEqual([1, 3]);
  });
});

describe('estimateMissingKwh', () => {
  it('estimates zero with no gaps', () => {
    expect(estimateMissingKwh(makeReadings('2026-01-01T00:00:00Z', 48, 0.5), []).totalKwh).toBe(0);
  });

  it('estimates a gap from the median half-hour-of-day profile', () => {
    const all = makeReadings('2026-01-01T00:00:00Z', 96, 0.5);
    const withGap = all.filter((_, i) => ![50, 51, 52].includes(i));
    const from = all[50]?.start;
    const to = all[52]?.start;
    if (!from || !to) throw new Error('fixture broken');
    const est = estimateMissingKwh(withGap, [{ start: from, end: to }]);
    expect(est.slots).toBe(3);
    expect(est.totalKwh).toBeCloseTo(1.5, 6);
  });
});
