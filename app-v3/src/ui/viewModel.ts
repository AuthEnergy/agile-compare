import type { Headline } from '../domain/headline';
import { calculatedBaselineLabel, flexColumnLabel } from '../domain/flexSource';
import { classifyTariffCode } from '../domain/tariff';
import type { ComparisonRun, PeriodComparison, StatementValidationEntry } from '../types/result';
import type { Tone } from './components';
import { fmtDateShort, fmtKwh, fmtMoney } from './format';

// Pure ComparisonRun + Headline → view model for the import results screen. Keeps
// all the formatting/classification out of the paint layer so it's unit-testable.

export type PeriodStatus =
  | 'complete'
  | 'preSwitch'
  | 'mixed'
  | 'mismatch'
  | 'mismatchMinor'
  | 'partial'
  | 'incomplete';

export interface PeriodRowVM {
  period: PeriodComparison;
  title: string;
  tag: string;
  tagTone: Tone;
  reason: string;
  includedInHeadline: 'yes' | 'caution' | 'no';
  kwhText: string;
  flexText: string; // this month on Flexible (£)
  agileText: string; // this month on Agile (£), or 'n/a'
  flexAvgPence: number | null; // effective unit rate p/kWh for the yours/flex side
  agileAvgPence: number | null; // avg Agile unit rate p/kWh (energy only, excl. standing)
  // Per-period flex column label: the current tariff name + "(calc.)" for on-current
  // periods when actual rates are available, "Flexible" for pre-switch/mixed
  // periods where the Flexible calculation is a genuine alternative, not a proxy.
  flexLabel: string;
  readingCoveragePct: number; // 0–100: what fraction of expected half-hour slots have readings
  status: PeriodStatus;
  expandable: boolean;
}

export interface FigureVM {
  label: string;
  amount: string; // formatted "12.34" (no prefix)
  prefix: string;
  period?: string;
  caption?: string;
  tone: 'neutral' | 'saving' | 'caution' | 'risk' | 'info';
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

const HALF_HOUR_MS = 30 * 60 * 1000;

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

interface MismatchDetail {
  hasMismatch: boolean;
  isMinor: boolean; // true when gap < 5% of billed kWh
  meteredKwh: number | null;
  billedKwh: number | null;
  pct: number | null; // fraction, e.g. 0.019 for 1.9%
}

function mismatchDetailForPeriod(run: ComparisonRun, p: PeriodComparison): MismatchDetail {
  const v: StatementValidationEntry | undefined = run.context.statementValidation.find(
    (sv) => sv.mismatch && sv.displayStart < p.end && sv.displayEnd > p.start,
  );
  if (!v)
    return { hasMismatch: false, isMinor: false, meteredKwh: null, billedKwh: null, pct: null };
  const pct =
    v.billedKwh != null && v.billedKwh !== 0
      ? Math.abs(v.billedKwh - v.observedKwh) / Math.abs(v.billedKwh)
      : null;
  return {
    hasMismatch: true,
    isMinor: pct !== null && pct < 0.05,
    meteredKwh: v.observedKwh,
    billedKwh: v.billedKwh,
    pct,
  };
}

function classifyPeriod(
  run: ComparisonRun,
  p: PeriodComparison,
  currentTariff: string | null,
  allPredate: boolean,
  proxyFlexLabel: string,
): PeriodRowVM {
  const title = MONTH_FMT(p.displayStart);
  const mixed = p.tariffCodes.length > 1;
  const preSwitch = !mixed && !!p.actualTariffCode && p.actualTariffCode !== currentTariff;
  const mismatchInfo = mismatchDetailForPeriod(run, p);
  const onCurrent =
    !mixed && !preSwitch && (currentTariff === null || p.tariffCodes[0] === currentTariff);
  const flexLabel = onCurrent ? proxyFlexLabel : 'Flexible';

  const expectedSlots = Math.round((p.end.getTime() - p.start.getTime()) / HALF_HOUR_MS);
  const actualSlots = run.detail.readings.filter(
    (r) => r.start >= p.start && r.start < p.end,
  ).length;
  const readingCoveragePct =
    expectedSlots > 0 ? Math.min(100, Math.round((actualSlots / expectedSlots) * 100)) : 100;

  let status: PeriodStatus;
  let tag: string;
  let tagTone: Tone;
  let reason: string;
  let includedInHeadline: 'yes' | 'caution' | 'no';

  if (mixed) {
    status = 'mixed';
    tag = 'Mixed';
    tagTone = 'caution';
    reason = 'The switch landed mid-statement, mixing two tariffs.';
    includedInHeadline = 'no';
  } else if (preSwitch) {
    status = 'preSwitch';
    tag = 'Pre-tariff';
    tagTone = 'caution';
    const oldLabel = p.actualTariffCode ? classifyTariffCode(p.actualTariffCode).label : null;
    if (allPredate) {
      reason = oldLabel
        ? `From before you switched tariff — ${oldLabel} rates aren't available from the API, so Flexible is used as the baseline.`
        : 'From before you switched tariff — the figures above are based on this usage.';
      includedInHeadline = 'caution';
    } else {
      reason = oldLabel
        ? `Your ${oldLabel} rates for this period aren't available from the API — Flexible and Agile are shown as alternatives.`
        : 'Before your current tariff — excluded from the headline.';
      includedInHeadline = 'no';
    }
  } else if (mismatchInfo.hasMismatch && !mismatchInfo.isMinor) {
    status = 'mismatch';
    tag = 'Statement mismatch';
    tagTone = 'risk';
    const metered = mismatchInfo.meteredKwh !== null ? fmtKwh(mismatchInfo.meteredKwh, 0) : '?';
    const billed = mismatchInfo.billedKwh !== null ? fmtKwh(mismatchInfo.billedKwh, 0) : '?';
    const pctStr =
      mismatchInfo.pct !== null ? `${(mismatchInfo.pct * 100).toFixed(1)}%` : 'unknown';
    reason = `${metered} metered, ${billed} billed — ${pctStr} gap, too large to include reliably.`;
    includedInHeadline = 'no';
  } else if (mismatchInfo.hasMismatch && mismatchInfo.isMinor) {
    status = 'mismatchMinor';
    tag = 'Small kWh gap';
    tagTone = 'caution';
    const metered = mismatchInfo.meteredKwh !== null ? fmtKwh(mismatchInfo.meteredKwh, 0) : '?';
    const billed = mismatchInfo.billedKwh !== null ? fmtKwh(mismatchInfo.billedKwh, 0) : '?';
    const pctStr = mismatchInfo.pct !== null ? `${(mismatchInfo.pct * 100).toFixed(1)}%` : 'small';
    reason = `${metered} metered, ${billed} billed — ${pctStr} gap, small enough to include.`;
    includedInHeadline = onCurrent && p.confident ? 'caution' : 'no';
  } else if (onCurrent && p.confident) {
    status = 'complete';
    tag = 'Complete';
    tagTone = 'saving';
    reason = 'On your current tariff, complete and confident.';
    includedInHeadline = 'yes';
  } else if (p.wasClamped || p.isSplit) {
    status = 'partial';
    tag = 'Partial';
    tagTone = 'caution';
    reason = 'Statement still open or the window was clamped — figures incomplete.';
    includedInHeadline = 'no';
  } else {
    status = 'incomplete';
    tag = 'Incomplete';
    tagTone = 'caution';
    reason = 'Some half-hour readings are missing.';
    includedInHeadline = 'no';
  }

  // In the all-pre-switch case the figures sum over EVERY period (pre-switch AND
  // any old-vs-old mixed period), so none is “excl.” — show its kWh. In the normal
  // case pre-switch and mixed periods are left out of the headline, so mark them.
  const excluded = !allPredate && (status === 'preSwitch' || status === 'mixed');
  return {
    period: p,
    title,
    tag,
    tagTone,
    reason,
    includedInHeadline,
    flexLabel,
    kwhText: excluded ? 'excl.' : fmtKwh(p.flex.kwh, 0),
    flexText: fmtMoney(p.flex.totalPence),
    agileText: p.agile ? fmtMoney(p.agile.totalPence) : 'n/a',
    flexAvgPence: p.flex.kwh > 0 ? p.flex.energyCostPence / p.flex.kwh : null,
    agileAvgPence: p.agile && p.agile.kwh > 0 ? p.agile.energyCostPence / p.agile.kwh : null,
    readingCoveragePct,
    expandable: p.flex.kwh > 0,
    status,
  };
}

export function computeResultsViewModel(run: ComparisonRun, headline: Headline): ResultsViewModel {
  const currentTariff = run.context.currentAgreement?.tariff_code ?? null;
  const notice = headline.previousTariffOnly;
  // null when we can't safely name the previous tariff — use neutral wording then.
  const previousLabel = notice?.previousTariffLabel ?? null;
  const onPrev = previousLabel ? `on ${previousLabel}` : 'before your switch';
  const flexLabel = flexColumnLabel(run.context.flexColumnSource);
  const periods = run.periods.map((p) =>
    classifyPeriod(run, p, currentTariff, notice !== null, flexLabel),
  );

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
        : comp.onAgile
          ? `${headline.currentTariffLabel} (calc.)`
          : calculatedBaselineLabel(run.context.flexColumnSource),
    amount: pence(paidPence),
    prefix: '£',
    // Caption the paid figure after the tariff it actually reflects: the previous
    // tariff in the notice case, otherwise YOUR current tariff (never a hardcoded
    // "Flexible" — an Agile user paid on Agile).
    period: notice
      ? useActual
        ? (previousLabel ?? 'Pre-switch')
        : 'Flexible'
      : comp.onAgile
        ? headline.currentTariffLabel
        : flexLabel.replace(/ \(calc\.\)$/, ''),
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
      tone: altCheaper ? 'saving' : 'info',
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
