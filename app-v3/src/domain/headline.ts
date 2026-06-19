import type { Agreement } from '../types/domain';
import type { ComparisonRun, PeriodComparison, StatementValidationEntry } from '../types/result';
import { classifyTariffCode } from './tariff';

export interface HeadlineVerdict {
  // The tariff we compare what you paid against — the standard tariff you are NOT
  // already on (Agile for most; Flexible if you are already on Agile).
  alternativeLabel: string;
  alternativeCheaper: boolean; // would that alternative have cost less than you paid?
  differencePence: number;
}

// Set when EVERY priced period predates the move to the user's current tariff, so
// there is no current-tariff data to summarise. The figures are still honest over
// the earlier usage — this just lets the UI say so plainly instead of "0 of N".
export interface PreviousTariffNotice {
  // null when we can't safely name ONE previous tariff (no code on the periods, a
  // multi-tariff history, or one that classifies the same as the current tariff).
  // The UI then uses neutral "earlier usage" wording instead of a wrong name.
  previousTariffCode: string | null;
  previousTariffLabel: string | null;
  currentTariffCode: string;
  currentTariffLabel: string;
  switchDate: Date | null;
}

export interface Headline {
  scope: 'consistent' | 'all';
  label: string;
  summaryHasActual: boolean;
  summaryActual: number;
  summaryFlex: number;
  summaryAgile: number | null;
  summaryKwh: number;
  consistentCount: number;
  totalCount: number;
  trustworthy: boolean;
  actualComparable: boolean;
  anyMismatch: boolean; // scoped to the summary periods
  anyTxnIncomplete: boolean; // scoped
  scopedBilledKwh: number;
  scopedObservedKwh: number;
  verdict: HeadlineVerdict | null;
  notEnoughData: boolean;
  previousTariffOnly: PreviousTariffNotice | null;
  // The comparison framing, oriented around YOUR tariff vs the one you're not on.
  currentTariffLabel: string;
  comparison: {
    altLabel: string; // 'Agile' | 'Flexible' — the tariff being compared against
    altTotal: number | null; // its total over the summary scope
    currentCalc: number | null; // your own tariff's calculated total (Flexible or Agile)
    onAgile: boolean;
  };
  // Whole-window figures + whole-window mismatch, for the email summary.
  wholeWindow: {
    totalKwh: number;
    totalFlex: number;
    totalAgile: number | null;
    billedKwhTotal: number;
    anyMismatchAllPeriods: boolean;
  };
}

// The current-tariff AND confident subset, plus whether to scope the summary to
// it. A period qualifies only if a single code (today's) was in force across the
// WHOLE period AND it's confident.
function consistentSubset(run: ComparisonRun): {
  consistentResults: PeriodComparison[];
  useConsistentOnly: boolean;
} {
  const { periods, context } = run;
  const currentTariff = context.currentAgreement ? context.currentAgreement.tariff_code : null;
  const consistentResults = currentTariff
    ? periods.filter(
        (p) => p.tariffCodes.length === 1 && p.tariffCodes[0] === currentTariff && p.confident,
      )
    : periods.filter((p) => p.confident);
  const useConsistentOnly =
    consistentResults.length > 0 && consistentResults.length < periods.length;
  return { consistentResults, useConsistentOnly };
}

// True when the current tariff is known, there are priced periods, and NONE of
// them was ever on the current tariff — i.e. all the available data is from
// before the user switched. (A period that straddles the switch includes the
// current code, so this stays false: that's the existing "mixed" handling.)
function allPeriodsPredateCurrentTariff(
  periods: PeriodComparison[],
  currentTariff: string | null,
): currentTariff is string {
  return (
    currentTariff !== null &&
    periods.length > 0 &&
    periods.every((p) => !p.tariffCodes.includes(currentTariff))
  );
}

function buildPreviousTariffNotice(
  periods: PeriodComparison[],
  currentTariff: string,
  currentAgreement: Agreement | null,
): PreviousTariffNotice {
  // Distinct prior tariff codes actually present (never the current code, never
  // empty). Name a specific tariff ONLY when there is exactly one — otherwise stay
  // generic so a multi-tariff or unknown history is never mislabelled. (This also
  // avoids ever falling through to the current code, which would name the previous
  // tariff identically to the current one.)
  const priorCodes = new Set<string>();
  for (const p of periods) {
    for (const c of p.tariffCodes) if (c && c !== currentTariff) priorCodes.add(c);
    if (p.actualTariffCode && p.actualTariffCode !== currentTariff)
      priorCodes.add(p.actualTariffCode);
  }
  const distinct = [...priorCodes];
  const currentTariffLabel = classifyTariffCode(currentTariff).label;
  let previousTariffCode: string | null = distinct.length === 1 ? (distinct[0] ?? null) : null;
  let previousTariffLabel: string | null = previousTariffCode
    ? classifyTariffCode(previousTariffCode).label
    : null;
  // Never present the previous tariff under the SAME name as the current one.
  if (previousTariffLabel !== null && previousTariffLabel === currentTariffLabel) {
    previousTariffCode = null;
    previousTariffLabel = null;
  }
  let switchDate: Date | null = null;
  if (currentAgreement) {
    const d = new Date(currentAgreement.valid_from);
    if (!Number.isNaN(d.getTime())) switchDate = d;
  }
  return {
    previousTariffCode,
    previousTariffLabel,
    currentTariffCode: currentTariff,
    currentTariffLabel,
    switchDate,
  };
}

// The exact set of periods the headline summarises (the current-tariff confident
// subset, or all periods when there's no partial split). Exposed so other
// read-only views (e.g. Stage-2 timing prompts) can scope to the SAME data the
// headline trusts, rather than the whole — possibly excluded — window.
export function summaryScopePeriods(run: ComparisonRun): PeriodComparison[] {
  const { consistentResults, useConsistentOnly } = consistentSubset(run);
  return useConsistentOnly ? consistentResults : run.periods;
}

// Pure port of the renderResults headline logic. Headline = current-tariff AND
// complete subset; "vs statement" stays stricter than Agile-vs-Flexible; the
// mismatch/truncation signals are scoped to the summarised periods.
export function computeHeadline(run: ComparisonRun): Headline {
  const { periods, context } = run;
  const { statementValidation, statementsIncomplete, agileAvailable } = context;

  const { consistentResults, useConsistentOnly: hasConsistentResults } = consistentSubset(run);

  const sumActual = (ps: PeriodComparison[]): number =>
    ps.reduce(
      (s, p) => s + (p.actualChargePence != null && !p.suspectActual ? p.actualChargePence : 0),
      0,
    );
  const sumFlex = (ps: PeriodComparison[]): number => ps.reduce((s, p) => s + p.flex.totalPence, 0);
  const sumAgile = (ps: PeriodComparison[]): number | null =>
    agileAvailable ? ps.reduce((s, p) => s + (p.agile ? p.agile.totalPence : 0), 0) : null;
  const sumKwh = (ps: PeriodComparison[]): number => ps.reduce((s, p) => s + p.flex.kwh, 0);

  const totalFlex = sumFlex(periods);
  const totalAgile = sumAgile(periods);
  const totalKwh = sumKwh(periods);

  const useConsistentOnly = hasConsistentResults;
  const summaryScope = useConsistentOnly ? consistentResults : periods;
  const summaryActual = useConsistentOnly ? sumActual(consistentResults) : sumActual(periods);
  const summaryFlex = useConsistentOnly ? sumFlex(consistentResults) : totalFlex;
  const summaryAgile = useConsistentOnly ? sumAgile(consistentResults) : totalAgile;
  const summaryKwh = useConsistentOnly ? sumKwh(consistentResults) : totalKwh;
  const label = useConsistentOnly
    ? `Complete periods on your current tariff (${consistentResults.length} of ${periods.length})`
    : 'Full period';

  const billedStatements = statementValidation.filter((v) => v.billedKwh != null && !v.wasClamped);
  const billedKwhTotal = billedStatements.reduce((s, v) => s + (v.billedKwh ?? 0), 0);
  const validationInScope = (v: StatementValidationEntry): boolean =>
    summaryScope.some((p) => v.displayStart < p.end && v.displayEnd > p.start);
  const scopedBilled = billedStatements.filter(validationInScope);
  const scopedBilledKwh = scopedBilled.reduce((s, v) => s + (v.billedKwh ?? 0), 0);
  const scopedObservedKwh = scopedBilled.reduce((s, v) => s + v.observedKwh, 0);
  const anyMismatch = statementValidation.some((v) => v.mismatch && validationInScope(v));
  const anyTxnIncomplete = statementValidation.some(
    (v) => v.transactionsAvailable && !v.transactionsComplete && validationInScope(v),
  );
  const anyMismatchAllPeriods = statementValidation.some((v) => v.mismatch);

  const allConfident = periods.length > 0 && periods.every((p) => p.confident);
  const trustworthy = (useConsistentOnly || allConfident) && !statementsIncomplete;
  const summaryHasActual = summaryScope.some(
    (p) => p.actualChargePence != null && !p.suspectActual,
  );
  const anyActualEstimated = summaryScope.some((p) => p.isSplit && p.actualChargePence != null);
  // If any priced period in scope has NO actual (an unbilled/synthetic period that
  // still contributes kWh to flex/agile), the actual-paid total covers a shorter
  // span than the flex/agile it would be compared against — so it is NOT comparable.
  // Falling back to Flexible-calc keeps both sides over the identical span.
  const anyActualMissing = summaryScope.some((p) => p.actualChargePence == null && p.flex.kwh > 0);
  const actualComparable =
    summaryHasActual &&
    !anyActualMissing &&
    !anyMismatch &&
    !anyTxnIncomplete &&
    !anyActualEstimated;
  const hasActual = periods.some((p) => p.actualChargePence != null && !p.suspectActual);

  const notEnoughData = !trustworthy && (statementsIncomplete || periods.some((p) => !p.confident));

  const currentTariff = context.currentAgreement?.tariff_code ?? null;
  const previousTariffOnly = allPeriodsPredateCurrentTariff(periods, currentTariff)
    ? buildPreviousTariffNotice(periods, currentTariff, context.currentAgreement)
    : null;

  // Compare against the standard tariff you're NOT on: Agile by default, but
  // Flexible if you're already on Agile (so an Agile user isn't compared to Agile
  // and told "Flexible is cheaper" off rounding noise). The all-pre-switch case has
  // no current-tariff data, so it always compares the old usage against Agile.
  const onAgile = currentTariff ? classifyTariffCode(currentTariff).kind === 'agile' : false;
  const currentTariffLabel = currentTariff
    ? classifyTariffCode(currentTariff).label
    : 'your tariff';
  const compareFlexible = onAgile && previousTariffOnly === null;
  const altTotal = compareFlexible ? summaryFlex : summaryAgile;
  const altLabel = compareFlexible ? 'Flexible' : 'Agile';
  const currentCalc = onAgile ? summaryAgile : summaryFlex;

  let verdict: HeadlineVerdict | null = null;
  if (trustworthy && hasActual && altTotal !== null) {
    // Baseline = the actual paid when comparable, else your own tariff's calc — the
    // SAME figure the "You paid"/"(calc.)" tile shows, so they never disagree.
    const paidBaseline = actualComparable ? summaryActual : (currentCalc ?? summaryFlex);
    verdict = {
      alternativeLabel: altLabel,
      alternativeCheaper: altTotal < paidBaseline,
      differencePence: Math.abs(paidBaseline - altTotal),
    };
  }

  return {
    scope: useConsistentOnly ? 'consistent' : 'all',
    label,
    summaryHasActual,
    summaryActual,
    summaryFlex,
    summaryAgile,
    summaryKwh,
    consistentCount: consistentResults.length,
    totalCount: periods.length,
    trustworthy,
    actualComparable,
    anyMismatch,
    anyTxnIncomplete,
    scopedBilledKwh,
    scopedObservedKwh,
    verdict,
    notEnoughData,
    previousTariffOnly,
    currentTariffLabel,
    comparison: { altLabel, altTotal, currentCalc, onAgile },
    wholeWindow: { totalKwh, totalFlex, totalAgile, billedKwhTotal, anyMismatchAllPeriods },
  };
}
