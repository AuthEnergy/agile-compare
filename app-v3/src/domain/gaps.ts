import type { DateRange, GapInfo, MissingEstimate, Reading } from '../types/domain';

const STEP_MS = 30 * 60 * 1000;

export function detectGaps(readings: readonly Reading[]): GapInfo {
  if (readings.length === 0) return { gaps: [], duplicates: [], earliest: null, latest: null };
  const sorted = [...readings].sort((a, b) => a.start.getTime() - b.start.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return { gaps: [], duplicates: [], earliest: null, latest: null };
  const earliest = first.start;
  const latest = last.start;

  const seen = new Map<number, number>();
  for (const r of sorted) {
    const key = r.start.getTime();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates: Date[] = [...seen.entries()].filter(([, c]) => c > 1).map(([t]) => new Date(t));

  const gaps: DateRange[] = [];
  let current = earliest.getTime();
  let gapStart: number | null = null;
  while (current <= latest.getTime()) {
    if (!seen.has(current)) {
      if (gapStart === null) gapStart = current;
    } else if (gapStart !== null) {
      gaps.push({ start: new Date(gapStart), end: new Date(current - STEP_MS) });
      gapStart = null;
    }
    current += STEP_MS;
  }
  if (gapStart !== null) gaps.push({ start: new Date(gapStart), end: new Date(current - STEP_MS) });

  return { gaps, duplicates, earliest, latest };
}

// Estimate the consumption the missing half-hour slots probably represent, using
// the median observed kWh for the same half-hour of day. Sensitivity figure only.
export function estimateMissingKwh(
  readings: readonly Reading[],
  gaps: readonly DateRange[],
): MissingEstimate {
  const empty: MissingEstimate = { totalKwh: 0, slots: 0, perGap: [] };
  if (gaps.length === 0 || readings.length === 0) return empty;
  const slotOfDay = (d: Date): number => d.getUTCHours() * 2 + (d.getUTCMinutes() >= 30 ? 1 : 0);
  const buckets: number[][] = Array.from({ length: 48 }, () => []);
  for (const r of readings) {
    buckets[slotOfDay(r.start)]?.push(r.kwh);
  }
  const medians = buckets.map((vals) => {
    if (vals.length === 0) return 0;
    const s = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    if (s.length % 2) return s[mid] ?? 0;
    return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  });
  let totalKwh = 0;
  let totalSlots = 0;
  const perGap: MissingEstimate['perGap'] = [];
  for (const g of gaps) {
    let gapKwh = 0;
    let gapSlots = 0;
    for (let t = g.start.getTime(); t <= g.end.getTime(); t += STEP_MS) {
      gapKwh += medians[slotOfDay(new Date(t))] ?? 0;
      gapSlots++;
    }
    totalKwh += gapKwh;
    totalSlots += gapSlots;
    perGap.push({ from: new Date(g.start), to: new Date(g.end), slots: gapSlots, kwh: gapKwh });
  }
  return { totalKwh, slots: totalSlots, perGap };
}
