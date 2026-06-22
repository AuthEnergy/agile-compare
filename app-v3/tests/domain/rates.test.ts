import { describe, it, expect } from 'vitest';
import { buildGoRateWindows, rateAt, rateAtSorted } from '../../src/domain/rates';
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

describe('buildGoRateWindows', () => {
  // Day rate: single flat window; night windows: two consecutive days.
  const from = new Date('2025-06-01T00:00:00Z');
  const to = new Date('2025-06-03T00:00:00Z');
  const dayRate: RateWindow[] = [{ validFrom: from, validTo: null, value: 28 }];
  const nightRates: RateWindow[] = [
    // Night 1: 00:30–05:30 on June 1
    {
      validFrom: new Date('2025-06-01T00:30:00Z'),
      validTo: new Date('2025-06-01T05:30:00Z'),
      value: 3.5,
    },
    // Night 2: 00:30–05:30 on June 2
    {
      validFrom: new Date('2025-06-02T00:30:00Z'),
      validTo: new Date('2025-06-02T05:30:00Z'),
      value: 3.5,
    },
  ];

  it('applies night rate during off-peak slots and day rate at all other times', () => {
    const merged = buildGoRateWindows(dayRate, nightRates, from, to);
    const lookup = (iso: string) => rateAtSorted(merged, new Date(iso));
    expect(lookup('2025-06-01T00:00:00Z')).toBe(28); // midnight → day
    expect(lookup('2025-06-01T01:00:00Z')).toBe(3.5); // in night window
    expect(lookup('2025-06-01T05:29:00Z')).toBe(3.5); // just before night ends
    expect(lookup('2025-06-01T05:30:00Z')).toBe(28); // day rate resumes
    expect(lookup('2025-06-01T12:00:00Z')).toBe(28); // midday → day
    expect(lookup('2025-06-02T03:00:00Z')).toBe(3.5); // second night window
    expect(lookup('2025-06-02T10:00:00Z')).toBe(28); // after second night
  });

  it('produces non-overlapping windows sorted ascending', () => {
    const merged = buildGoRateWindows(dayRate, nightRates, from, to);
    for (let i = 1; i < merged.length; i++) {
      const prev = merged[i - 1];
      const curr = merged[i];
      if (!prev || !curr) continue;
      expect(curr.validFrom.getTime()).toBe(prev.validTo?.getTime());
    }
  });

  it('falls back to day rate for the full window when there are no night windows', () => {
    const merged = buildGoRateWindows(dayRate, [], from, to);
    expect(merged).toHaveLength(1);
    const w = merged[0];
    expect(w?.value).toBe(28);
    expect(w?.validFrom).toEqual(from);
    expect(w?.validTo).toEqual(to);
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
