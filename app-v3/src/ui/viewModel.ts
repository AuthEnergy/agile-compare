import type { Headline } from '../domain/headline';
import type { ComparisonRun, PeriodComparison } from '../types/result';
import type { Tone } from './components';
import { fmtDateShort, fmtKwh, fmtMoney } from './format';

// Pure ComparisonRun + Headline → view model for the import results screen. Keeps
// all the formatting/classification out of the paint layer so it's unit-testable.

export type PeriodStatus =
  | 'complete'
  | 'preSwitch'
  | 'mixed'
  | 'mismatch'
  | 'partial'
  | 'incomplete';

export interface PeriodRowVM {
  period: PeriodComparison;
  title: string;
  tag: string;
  tagTone: Tone;
  reason: string;
  kwhText: string;
  flexText: string; // this month on Flexible (£)
  agileText: string; // this month on Agile (£), or 'n/a'
  status: PeriodStatus;
  expandable: boolean;
}

export interface FigureVM {
  label: string;
  amount: string; // formatted "12.34" (no prefix)
  prefix: string;
  period?: string;
  caption?: string;
  tone: 'neutral' | 'saving' | 'caution' | 'risk';
  sign?: string;
}

export interface ResultsViewModel {
  windowLabel: string;
  completeLabel: string;
  kwhLabel: string;
  trustworthy: boolean;
  notEnoughData: boolean;
  hasActual: boolean;
  paid: FigureVM;
  agile: FigureVM | null;
  difference: FigureVM | null;
  verdictText: string | null;
  periods: PeriodRowVM[];
  // The header line above the figures: a title + a small count chip. For the
  // normal case "Complete periods on your current tariff:" / "6 of 13"; for the
  // all-pre-switch case "Earlier usage on Fixed ·" / "8 periods".
  scopeTitle: string;
  scopeCount: string;
  confidenceLevel: 'high' | 'medium' | 'low';
  confidencePct: number;
  confidenceCaption: string;
  // Present only when every period predates the move to the current tariff.
  previousTariffNotice: { heading: string; body: string; previousLabel: string } | null;
}

const MONTH_FMT = (d: Date): string =>
  [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ][d.getUTCMonth()] + ` ${d.getUTCFullYear()}`;

const pence = (p: number): string => (p / 100).toFixed(2);

function statementMismatchInPeriod(run: ComparisonRun, p: PeriodComparison): boolean {
  return run.context.statementValidation.some(
    (v) => v.mismatch && v.displayStart < p.end && v.displayEnd > p.start,
  );
}

function classifyPeriod(
  run: ComparisonRun,
  p: PeriodComparison,
  currentTariff: string | null,
  allPredate: boolean,
): PeriodRowVM {
  const title = MONTH_FMT(p.displayStart);
  const mixed = p.tariffCodes.length > 1;
  const preSwitch = !mixed && !!p.actualTariffCode && p.actualTariffCode !== currentTariff;
  const mismatch = statementMismatchInPeriod(run, p);
  const onCurrent =
    !mixed && !preSwitch && (currentTariff === null || p.tariffCodes[0] === currentTariff);

  let status: PeriodStatus;
  let tag: string;
  let tagTone: Tone;
  let reason: string;
  if (mixed) {
    status = 'mixed';
    tag = 'Mixed';
    tagTone = 'caution';
    reason = 'The switch landed mid-statement, mixing two tariffs.';
  } else if (preSwitch) {
    status = 'preSwitch';
    tag = 'Pre-tariff';
    tagTone = 'caution';
    reason = allPredate
      ? 'From before you switched tariff — the figures above are based on this usage.'
      : 'Before your current tariff, so left out of the headline.';
  } else if (mismatch) {
    status = 'mismatch';
    tag = 'Statement mismatch';
    tagTone = 'risk';
    reason = 'Bill and readings disagree, so the “vs bill” check is suppressed.';
  } else if (onCurrent && p.confident) {
    status = 'complete';
    tag = 'Complete';
    tagTone = 'saving';
    reason = 'On your current tariff, complete and confident.';
  } else if (p.wasClamped || p.isSplit) {
    status = 'partial';
    tag = 'Partial';
    tagTone = 'caution';
    reason = 'Statement still open or the window was clamped — incomplete.';
  } else {
    status = 'incomplete';
    tag = 'Incomplete';
    tagTone = 'caution';
    reason = 'Some half-hour readings are missing, so it is left out.';
  }

  // In the all-pre-switch case the figures sum over EVERY period (pre-switch AND
  // any old-vs-old mixed period), so none is "excl." — show its kWh. In the normal
  // case pre-switch and mixed periods are left out of the headline, so mark them.
  const excluded = !allPredate && (status === 'preSwitch' || status === 'mixed');
  return {
    period: p,
    title,
    tag,
    tagTone,
    reason,
    kwhText: excluded ? 'excl.' : fmtKwh(p.flex.kwh, 0),
    flexText: fmtMoney(p.flex.totalPence),
    agileText: p.agile ? fmtMoney(p.agile.totalPence) : 'n/a',
    // Any period on the current tariff is drillable to day/slot maths — including a
    // mismatch, whose total is suppressed from the headline but still worth opening.
    expandable:
      status === 'complete' ||
      status === 'mismatch' ||
      status === 'partial' ||
      status === 'incomplete',
    status,
  };
}

export function computeResultsViewModel(run: ComparisonRun, headline: Headline): ResultsViewModel {
  const currentTariff = run.context.currentAgreement?.tariff_code ?? null;
  const notice = headline.previousTariffOnly;
  // null when we can't safely name the previous tariff — use neutral wording then.
  const previousLabel = notice?.previousTariffLabel ?? null;
  const onPrev = previousLabel ? `on ${previousLabel}` : 'before your switch';
  const periods = run.periods.map((p) => classifyPeriod(run, p, currentTariff, notice !== null));

  const comp = headline.comparison;
  const useActual = headline.summaryHasActual && headline.actualComparable;
  // "You paid" when comparable; otherwise YOUR tariff's calculated cost (the
  // notice/old-usage case has no current tariff, so it falls back to Flexible).
  const paidPence = useActual
    ? headline.summaryActual
    : notice
      ? headline.summaryFlex
      : (comp.currentCalc ?? headline.summaryFlex);
  const paid: FigureVM = {
    label: useActual
      ? 'You paid'
      : notice
        ? 'Flexible (calc.)'
        : `${headline.currentTariffLabel} (calc.)`,
    amount: pence(paidPence),
    prefix: '£',
    // Caption the paid figure after the tariff it actually reflects: the previous
    // tariff in the notice case, otherwise YOUR current tariff (never a hardcoded
    // "Flexible" — an Agile user paid on Agile).
    period: notice
      ? useActual
        ? (previousLabel ?? 'Pre-switch')
        : 'Flexible'
      : headline.currentTariffLabel,
    caption: notice ? 'Earlier usage' : 'Complete periods',
    tone: 'neutral',
  };

  // The comparison tile: the standard tariff you're NOT on (Agile for most;
  // Flexible if you're already on Agile).
  let agile: FigureVM | null = null;
  let difference: FigureVM | null = null;
  if (comp.altTotal !== null) {
    agile = {
      label: `${comp.altLabel} estimate`,
      amount: pence(comp.altTotal),
      prefix: '£',
      period: 'same usage',
      caption: 'Would have cost',
      tone: 'neutral',
    };
    const delta = paidPence - comp.altTotal; // +ve → the alternative is cheaper
    const altCheaper = delta > 0;
    difference = {
      label: 'Difference',
      amount: pence(Math.abs(delta)),
      prefix: '£',
      period: altCheaper ? `lower on ${comp.altLabel}` : `higher on ${comp.altLabel}`,
      caption: notice ? 'Over earlier usage' : 'On these periods',
      tone: altCheaper ? 'saving' : 'risk',
      sign: altCheaper ? '−' : '+',
    };
  }

  // Verdict copy — framed against the alternative tariff, never mislabelling your
  // own tariff or the actual bill.
  let verdictText: string | null = null;
  if (headline.verdict) {
    const money = fmtMoney(headline.verdict.differencePence);
    const alt = headline.verdict.alternativeLabel;
    const altCheaper = headline.verdict.alternativeCheaper;
    if (!notice) {
      verdictText = altCheaper
        ? `${alt} would have been cheaper by ${money} across complete periods.`
        : `You're already on the cheaper tariff — ${alt} would have cost ${money} more across complete periods.`;
    } else if (useActual) {
      verdictText = altCheaper
        ? `${alt} would have cost ${money} less than you actually paid ${onPrev}, on that earlier usage.`
        : `You paid ${money} less ${onPrev} than ${alt} would have, on that earlier usage.`;
    } else {
      verdictText = altCheaper
        ? `${alt} would have cost ${money} less than Flexible, over your earlier usage ${onPrev}.`
        : `Flexible would have cost ${money} less than ${alt}, over your earlier usage ${onPrev}.`;
    }
  }

  // Confidence: count ACTUALLY-confident periods — never call non-confident periods
  // "confident". In the all-pre-switch case the figures cover the whole window, so
  // base the count on the confident subset, not the empty current-tariff subset.
  const confidentCount = run.periods.filter((p) => p.confident).length;
  // Confidence is a LEVEL that already folds in coverage, so the bar, the badge,
  // and the caption all agree. A confident-but-thin slice (e.g. 2 of 13) reads as
  // "medium" — never a near-full "high" bar that overstates how much we checked.
  const trustedCount = notice ? confidentCount : headline.consistentCount;
  const coverage = trustedCount / Math.max(1, headline.totalCount);
  const confidenceLevel: 'high' | 'medium' | 'low' = !headline.trustworthy
    ? 'low'
    : coverage >= 0.6
      ? 'high'
      : 'medium';
  const confidencePct = confidenceLevel === 'high' ? 90 : confidenceLevel === 'medium' ? 62 : 28;
  const confidenceCaption = notice
    ? headline.trustworthy
      ? `Based on ${confidentCount} confident period(s) of your earlier usage ${onPrev}, with matched rates and standing charges.`
      : `Based on ${confidentCount} of ${headline.totalCount} period(s) of your earlier usage ${onPrev} — some readings are incomplete.`
    : `Based on ${headline.consistentCount} of ${headline.totalCount} complete period(s), with matched rates and standing charges.`;

  const switchClause = notice && notice.switchDate ? ` on ${fmtDateShort(notice.switchDate)}` : '';
  const previousTariffNotice = notice
    ? {
        previousLabel: previousLabel ?? '',
        heading: 'No data on your current tariff yet',
        body:
          `All the half-hourly data we could read is from before you moved to your current tariff` +
          ` (${notice.currentTariffLabel})${switchClause}. The figures below are over your earlier` +
          ` usage ${onPrev}, not your current tariff.`,
      }
    : null;

  return {
    windowLabel: `${fmtDateShort(run.context.periodFrom)} to ${fmtDateShort(run.context.periodTo)}`,
    completeLabel: `${headline.consistentCount} of ${headline.totalCount}`,
    kwhLabel: fmtKwh(headline.summaryKwh, 0),
    trustworthy: headline.trustworthy,
    notEnoughData: headline.notEnoughData,
    hasActual: headline.summaryHasActual,
    paid,
    agile,
    difference,
    verdictText,
    periods,
    scopeTitle: notice
      ? previousLabel
        ? `Earlier usage on ${previousLabel} ·`
        : 'Earlier usage ·'
      : 'Complete periods on your current tariff:',
    scopeCount: notice
      ? `${headline.totalCount} period${headline.totalCount === 1 ? '' : 's'}`
      : `${headline.consistentCount} of ${headline.totalCount}`,
    confidenceLevel,
    confidencePct,
    confidenceCaption,
    previousTariffNotice,
  };
}
