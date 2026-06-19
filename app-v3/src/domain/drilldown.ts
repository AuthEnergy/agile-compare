import { rateAtSorted } from './rates';
import type { Reading } from '../types/domain';
import type { RunDetail } from '../types/result';
import type { DayComparison, PeriodWindow, SlotCalculation } from '../types/drilldown';

const HALF_HOUR_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// First UTC midnight at or before an instant.
function utcMidnightMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Walk a (possibly clamped) period by UTC settlement day, summing energy and
// standing EXACTLY as calculateCost does — energy per reading in
// [period.start, period.end), standing once per day whose 12:00 UTC cursor falls
// in the period. This makes Σ days === period for energy, standing and total
// (associativity of the same per-reading / per-day sums, modulo float rounding).
export function buildDayComparisons(period: PeriodWindow, detail: RunDetail): DayComparison[] {
  const { readings, flexUnitSorted, agileUnitSorted, flexStanding, agileStanding, agileAvailable } =
    detail;
  const periodStart = period.start.getTime();
  const periodEnd = period.end.getTime();
  const days: DayComparison[] = [];

  for (let dayMid = utcMidnightMs(period.start); dayMid < periodEnd; dayMid += DAY_MS) {
    const dayEnd = dayMid + DAY_MS;
    const winStart = Math.max(dayMid, periodStart);
    const winEnd = Math.min(dayEnd, periodEnd);
    if (winStart >= winEnd) continue;

    let kwh = 0;
    let flexEnergy = 0;
    let agileEnergy = 0;
    let flexUnmatchedReadings = 0;
    let agileUnmatchedReadings = 0;
    for (const r of readings) {
      const t = r.start.getTime();
      if (t >= winStart && t < winEnd) {
        kwh += r.kwh;
        const fr = rateAtSorted(flexUnitSorted, r.start);
        if (fr === null) flexUnmatchedReadings++;
        else flexEnergy += r.kwh * fr;
        if (agileAvailable) {
          const ar = rateAtSorted(agileUnitSorted, r.start);
          if (ar === null) agileUnmatchedReadings++;
          else agileEnergy += r.kwh * ar;
        }
      }
    }

    // Standing: one charge per day whose noon cursor is inside the period — the
    // same cursor calculateCost iterates (12:00 UTC, skipping a clamped first day).
    const noon = new Date(dayMid);
    noon.setUTCHours(12, 0, 0, 0);
    const noonMs = noon.getTime();
    const noonInPeriod = noonMs >= periodStart && noonMs < periodEnd;
    let flexStandingP = 0;
    let agileStandingP = 0;
    let flexStandingUnmatched = 0;
    let agileStandingUnmatched = 0;
    if (noonInPeriod) {
      const fs = rateAtSorted(flexStanding, noon);
      if (fs === null) flexStandingUnmatched++;
      else flexStandingP += fs;
      if (agileAvailable) {
        const as = rateAtSorted(agileStanding, noon);
        if (as === null) agileStandingUnmatched++;
        else agileStandingP += as;
      }
    }

    const partial = winStart > dayMid || winEnd < dayEnd;
    const hasUnmatched =
      flexUnmatchedReadings > 0 ||
      agileUnmatchedReadings > 0 ||
      flexStandingUnmatched > 0 ||
      agileStandingUnmatched > 0;

    days.push({
      date: new Date(dayMid),
      kwh,
      flexEnergyPence: flexEnergy,
      agileEnergyPence: agileAvailable ? agileEnergy : null,
      standingPence: { flex: flexStandingP, agile: agileAvailable ? agileStandingP : null },
      flexTotalPence: flexEnergy + flexStandingP,
      agileTotalPence: agileAvailable ? agileEnergy + agileStandingP : null,
      flags: { hasUnmatched, partial },
      unmatched: {
        flexReadings: flexUnmatchedReadings,
        agileReadings: agileUnmatchedReadings,
        flexStandingDays: flexStandingUnmatched,
        agileStandingDays: agileStandingUnmatched,
      },
    });
  }
  return days;
}

// Build the 48 UTC half-hour slots for one settlement day and LEFT-JOIN readings
// + rates onto the skeleton — so a missing slot shows as a gap rather than
// vanishing, a duplicate interval is flagged, and slots outside the clamped
// period are marked outOfPeriod and never priced. Σ slot.energy === day.energy.
export function buildSlotCalculations(
  dayMid: Date,
  period: PeriodWindow,
  detail: RunDetail,
): SlotCalculation[] {
  const { readings, flexUnitSorted, agileUnitSorted, agileAvailable, duplicateIntervals } = detail;
  const periodStart = period.start.getTime();
  const periodEnd = period.end.getTime();

  const byStart = new Map<number, Reading>();
  for (const r of readings) byStart.set(r.start.getTime(), r);

  const base = dayMid.getTime();
  const slots: SlotCalculation[] = [];
  for (let i = 0; i < 48; i++) {
    const slotStartMs = base + i * HALF_HOUR_MS;
    const slotStart = new Date(slotStartMs);
    const inPeriod = slotStartMs >= periodStart && slotStartMs < periodEnd;
    const reading = byStart.get(slotStartMs);
    const hasReading = reading !== undefined;
    const flexRate = rateAtSorted(flexUnitSorted, slotStart);
    const agileRate = agileAvailable ? rateAtSorted(agileUnitSorted, slotStart) : null;

    const missingReading = inPeriod && !hasReading;
    const flexUnmatched = inPeriod && hasReading && flexRate === null;
    const agileUnmatched = inPeriod && hasReading && agileAvailable && agileRate === null;
    const kwh = hasReading ? reading.kwh : null;
    const flexCostPence =
      inPeriod && hasReading && flexRate !== null ? reading.kwh * flexRate : null;
    const agileCostPence =
      inPeriod && hasReading && agileAvailable && agileRate !== null
        ? reading.kwh * agileRate
        : null;

    slots.push({
      intervalStart: slotStart,
      intervalEnd: new Date(slotStartMs + HALF_HOUR_MS),
      kwh,
      flexRate,
      agileRate,
      flexCostPence,
      agileCostPence,
      flags: {
        missingReading,
        duplicate: duplicateIntervals.has(slotStartMs),
        flexUnmatched,
        agileUnmatched,
        outOfPeriod: !inPeriod,
      },
    });
  }
  return slots;
}
