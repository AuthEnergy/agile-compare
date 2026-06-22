import type { RateWindow } from '../types/domain';

// Linear rate lookup by instant — returns the value of the first window covering
// `instant`, or null if none. Kept for its simple, hand-verifiable semantics
// (used in tests as the reference for rateAtSorted's boundary behaviour).
export function rateAt(rateWindows: readonly RateWindow[], instant: Date): number | null {
  const t = instant.getTime();
  for (const w of rateWindows) {
    const from = w.validFrom.getTime();
    const to = w.validTo ? w.validTo.getTime() : Infinity;
    if (t >= from && t < to) return w.value;
  }
  return null;
}

// Build a non-overlapping, fully-covered rate window list for a Go-like tariff
// with fixed daily off-peak windows. Night windows take priority; the
// day rate fills every gap. The result covers [from, to) exactly, is sorted ascending
// by validFrom, and is safe to pass directly to rateAtSorted / calculateCost.
//
// Edge case: if the day rate changes mid-gap (quarterly variable-rate revision), the
// gap window uses the rate in force at the gap's start — an acceptable approximation
// since the day rate seldom changes mid-window.
export function buildGoRateWindows(
  dayRates: readonly RateWindow[],
  nightRates: readonly RateWindow[],
  from: Date,
  to: Date,
): RateWindow[] {
  const sortedDay = [...dayRates].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  const sortedNight = [...nightRates]
    .filter((n) => {
      const nTo = n.validTo ? n.validTo.getTime() : Infinity;
      return n.validFrom.getTime() < to.getTime() && nTo > from.getTime();
    })
    .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());

  const dayAt = (t: Date): number | null => rateAtSorted(sortedDay, t);
  const result: RateWindow[] = [];
  let cursor = from;

  for (const night of sortedNight) {
    const nStart = night.validFrom > cursor ? night.validFrom : cursor;
    const nEnd = night.validTo && night.validTo < to ? night.validTo : to;
    if (nEnd <= cursor) continue;

    if (nStart > cursor) {
      const rate = dayAt(cursor);
      if (rate !== null) result.push({ validFrom: cursor, validTo: nStart, value: rate });
    }
    result.push({ validFrom: nStart, validTo: nEnd, value: night.value });
    cursor = nEnd;
  }

  if (cursor < to) {
    const rate = dayAt(cursor);
    if (rate !== null) result.push({ validFrom: cursor, validTo: to, value: rate });
  }

  return result;
}

// Binary-search variant for the hot per-reading loops. Input MUST be ascending
// by validFrom (callers sort once). Finds the last window starting at or before
// the instant, then checks its end — O(log n). Where versions overlap at a
// boundary it returns the later-starting (newer) window's rate.
export function rateAtSorted(sortedWindows: readonly RateWindow[], instant: Date): number | null {
  const t = instant.getTime();
  let lo = 0;
  let hi = sortedWindows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = sortedWindows[mid];
    if (w && w.validFrom.getTime() <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans === -1) return null;
  const w = sortedWindows[ans];
  if (!w) return null;
  const to = w.validTo ? w.validTo.getTime() : Infinity;
  return t < to ? w.value : null;
}
