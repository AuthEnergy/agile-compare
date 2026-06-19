import { describe, it, expect } from 'vitest';
import { rateAt, rateAtSorted } from '../../src/domain/rates';
import type { RateWindow } from '../../src/types/domain';

const windows: RateWindow[] = [
  {
    validFrom: new Date('2025-03-31T23:00:00Z'),
    validTo: new Date('2025-06-30T23:00:00Z'),
    value: 26.48,
  },
  {
    validFrom: new Date('2025-06-30T23:00:00Z'),
    validTo: new Date('2025-09-30T23:00:00Z'),
    value: 25.126,
  },
];

describe('rateAt (linear, reference semantics)', () => {
  it('matches windows at and across boundaries (validFrom inclusive, validTo exclusive)', () => {
    expect(rateAt(windows, new Date('2025-05-01T00:00:00Z'))).toBe(26.48);
    expect(rateAt(windows, new Date('2025-07-01T00:00:00Z'))).toBe(25.126);
    expect(rateAt(windows, new Date('2025-06-30T23:00:00Z'))).toBe(25.126);
    expect(rateAt(windows, new Date('2025-06-30T22:59:00Z'))).toBe(26.48);
    expect(rateAt(windows, new Date('2024-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('rateAtSorted (binary search)', () => {
  it('agrees with rateAt at boundaries', () => {
    for (const iso of [
      '2025-05-01T00:00:00Z',
      '2025-07-01T00:00:00Z',
      '2025-06-30T23:00:00Z',
      '2025-06-30T22:59:00Z',
      '2024-01-01T00:00:00Z',
    ]) {
      expect(rateAtSorted(windows, new Date(iso))).toBe(rateAt(windows, new Date(iso)));
    }
  });

  it('newer overlapping (open-ended) window wins on overlap', () => {
    const overlap: RateWindow[] = [
      { validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 10 },
      { validFrom: new Date('2024-01-01T00:00:00Z'), validTo: null, value: 99 },
    ];
    expect(rateAtSorted(overlap, new Date('2025-06-01T12:00:00Z'))).toBe(99);
    expect(rateAtSorted(overlap, new Date('2022-06-01T12:00:00Z'))).toBe(10);
  });
});
