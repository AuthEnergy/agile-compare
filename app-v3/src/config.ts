// App-wide constants. Kept tiny and dependency-free so any module (including the
// pure diagnostics layer) can import it without pulling in DOM/fetch.

// Stamped into every diagnostics/failure bundle so support can tell which build
// produced a file. Bump in lockstep with package.json `version`.
export const APP_VERSION = 'agile-compare v0.3.0 / github.com/AuthEnergy/agile-compare';

// Where "Submit diagnostics" sends the bundle when the Web Share sheet is
// unavailable (the mailto fallback). Configurable in one place.
export const DIAGNOSTICS_RECIPIENT = 'hello@auth.energy';

// Schema/size caps for replaying a diagnostics file: a real diagnostic is at
// most a few years of half-hourly data. Anything past these is refused so a huge
// or hand-edited file can't freeze the tab mapping arrays. Ported from v2.
export const REPLAY_CAPS = {
  readingsRaw: 200_000,
  billingPeriods: 5_000,
  rawUnitRates: 200_000,
  rawStandingCharges: 50_000,
  // Per-period date-span cap (days). The array caps above don't bound how long a
  // single period spans, and splitLongPeriods walks a period one calendar month
  // at a time — so a hostile "2000-01-01 to +275760-09-13" (a valid, ~100M-day
  // Date) would loop millions of times and freeze the tab. The real comparison
  // window is ~13 months, so 800 days is comfortably above any legitimate period.
  maxPeriodDays: 800,
} as const;
