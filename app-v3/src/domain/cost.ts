import type { CostResult, ExportValue, RateWindow, Reading } from '../types/domain';
import { rateAtSorted } from './rates';

const DAY_MS = 24 * 60 * 60 * 1000;
// Generous ceiling above the ~13-month fetch window: catches an unclamped
// statement date (a bug) without rejecting a real long billing period.
const MAX_PERIOD_DAYS = 500;

export function calculateCost(
  readings: readonly Reading[],
  periodStart: Date,
  periodEnd: Date,
  unitRateWindows: readonly RateWindow[],
  standingChargeWindows: readonly RateWindow[],
  preSorted = false,
): CostResult {
  let kwh = 0;
  let energyCostPence = 0;
  let unmatchedReadings = 0;

  // Unit-rate windows must be ascending for the binary search. A caller pricing
  // many split periods sorts the (large Agile) array ONCE and passes preSorted.
  const sortedUnit = preSorted
    ? unitRateWindows
    : [...unitRateWindows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  for (const r of readings) {
    if (r.start >= periodStart && r.start < periodEnd) {
      kwh += r.kwh;
      const rate = rateAtSorted(sortedUnit, r.start);
      if (rate === null) unmatchedReadings++;
      else energyCostPence += r.kwh * rate;
    }
  }

  // Defensive guard against an unclamped/implausible range (would otherwise
  // silently inflate the standing charge by iterating the day loop forever).
  const spanDays = (periodEnd.getTime() - periodStart.getTime()) / DAY_MS;
  if (spanDays > MAX_PERIOD_DAYS) {
    throw new Error(
      `calculateCost called with an implausible date range (${spanDays.toFixed(0)} days, ` +
        `${periodStart.toISOString()} to ${periodEnd.toISOString()}). This is almost certainly a bug ` +
        `(an unclamped statement date) rather than a real billing period.`,
    );
  }

  // Standing windows can overlap like unit rates; always sort + binary-search so
  // the later-starting (newer) window wins, not a stale open-ended older one.
  // Standing windows are few, so the unconditional sort is negligible.
  const sortedStanding = [...standingChargeWindows].sort(
    (a, b) => a.validFrom.getTime() - b.validFrom.getTime(),
  );
  let standingChargePence = 0;
  let unmatchedStandingDays = 0;
  const cursor = new Date(periodStart);
  cursor.setUTCHours(12, 0, 0, 0);
  if (cursor < periodStart) cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor < periodEnd) {
    const rate = rateAtSorted(sortedStanding, cursor);
    // A day with no matching standing window contributes nothing — count it so
    // the caller can flag the period as not fully covered.
    if (rate !== null) standingChargePence += rate;
    else unmatchedStandingDays++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    kwh,
    energyCostPence,
    standingChargePence,
    totalPence: energyCostPence + standingChargePence,
    unmatchedReadings,
    unmatchedStandingDays,
  };
}

// Value exported electricity under an export ("Outgoing") tariff: unit rate ×
// kWh only, with NO standing charge (income, not cost).
export function calculateExportValue(
  readings: readonly Reading[],
  periodStart: Date,
  periodEnd: Date,
  unitRateWindows: readonly RateWindow[],
): ExportValue {
  let kwh = 0;
  let valuePence = 0;
  let unmatchedReadings = 0;
  const sortedUnit = [...unitRateWindows].sort(
    (a, b) => a.validFrom.getTime() - b.validFrom.getTime(),
  );
  for (const r of readings) {
    if (r.start >= periodStart && r.start < periodEnd) {
      kwh += r.kwh;
      const rate = rateAtSorted(sortedUnit, r.start);
      if (rate === null) unmatchedReadings++;
      else valuePence += r.kwh * rate;
    }
  }
  return { kwh, valuePence, unmatchedReadings };
}
