import type { RawPeriod, SplitPeriod } from '../types/domain';

const DAY_MS = 24 * 60 * 60 * 1000;
// Runaway backstop: the per-period month loop below would iterate once per month
// of span. The live path clamps periods to a ~13-month window and replay caps
// the span before calling here, so no real input approaches this — it only stops
// a future caller from passing an absurd (e.g. ~100M-day) span that would freeze
// the tab. Generous (~54 years) so it never trips on legitimate data.
const MAX_SPLIT_PERIOD_DAYS = 20_000;

// Split any billing period longer than 35 days into calendar-month sub-periods,
// day-apportioning the real statement charge. Split rows are flagged isSplit:true;
// their apportioned actual charge is a display estimate (excluded from headline
// "vs statement" claims). Shared by the live and diagnostic-replay paths.
export function splitLongPeriods(rawPeriods: readonly RawPeriod[]): SplitPeriod[] {
  const result: SplitPeriod[] = [];
  for (const p of rawPeriods) {
    const spanDays = (p.end.getTime() - p.start.getTime()) / DAY_MS;
    if (spanDays > MAX_SPLIT_PERIOD_DAYS) {
      throw new RangeError(
        `splitLongPeriods called with an implausible span (${spanDays.toFixed(0)} days). ` +
          `This is almost certainly a bug or a hostile input, not a real billing period.`,
      );
    }
    if (spanDays <= 35) {
      result.push({ ...p, isSplit: false });
      continue;
    }
    const totalDays = spanDays;
    let cursor = new Date(p.start);
    while (cursor < p.end) {
      const subStart = new Date(cursor);
      const nextMonth = new Date(cursor);
      nextMonth.setUTCDate(1);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      nextMonth.setUTCHours(0, 0, 0, 0);
      const subEnd = nextMonth < p.end ? nextMonth : new Date(p.end);
      const proportion = (subEnd.getTime() - subStart.getTime()) / DAY_MS / totalDays;
      result.push({
        displayStart: subStart,
        displayEnd: subEnd,
        start: subStart,
        end: subEnd,
        actualChargePence:
          p.actualChargePence != null ? Math.round(p.actualChargePence * proportion) : null,
        isSplit: true,
      });
      cursor = subEnd;
    }
  }
  return result;
}
