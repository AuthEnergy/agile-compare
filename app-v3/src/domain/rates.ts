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
