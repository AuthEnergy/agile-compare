import {
  getAgreementsForMpan,
  getPostcodeAreaForMpan,
  getRegionLetterFromAccount,
  obtainKrakenToken,
} from '../api/account';
import { fetchConsumptionMerged } from '../api/consumption';
import {
  fetchCurrentTariffRates,
  fetchMergedRateWindows,
  findProductsByDisplayNameOverlapping,
  type CurrentTariffRates,
} from '../api/products';
import { fetchStatementsForMpan } from '../api/statements';
import { OctopusApiError, type OctopusClient } from '../api/client';
import { calculateCost } from '../domain/cost';
import { detectGaps, estimateMissingKwh } from '../domain/gaps';
import { splitLongPeriods } from '../domain/periods';
import { billedKwhMismatch, summariseStatementTransactions } from '../domain/statements';
import {
  classifyTariffCode,
  findCurrentAgreement,
  makeTariffAtDateFn,
  tariffCodesInRange,
} from '../domain/tariff';
import type { StatementCharge, StatementCredit } from '../types/api';
import type { RateWindow, RawPeriod } from '../types/domain';
import type { AccountData, Page, RawConsumptionRow } from '../types/octopus';
import type {
  ComparisonRun,
  FlexColumnSource,
  PeriodComparison,
  ProgressFn,
  StatementValidationEntry,
} from '../types/result';

export interface RunInput {
  apiKey: string;
  accountNumber: string;
  mpan: string;
  serial: string;
  serials: string[];
  accountData: AccountData;
}

interface RichPeriod extends RawPeriod {
  billedKwh: number | null;
  creditsPence: number;
  credits: StatementCredit[];
  transactionsAvailable: boolean;
  transactionsComplete: boolean;
  statementCharges: StatementCharge[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const readNum = (v: unknown): number | null => (typeof v === 'number' ? v : null);

// Orchestrates an import comparison and returns a typed ComparisonRun — NO DOM.
// Progress is reported via the optional callback so the UI can render it.
export async function runComparison(
  client: OctopusClient,
  input: RunInput,
  onProgress: ProgressFn = () => {},
): Promise<ComparisonRun> {
  // --- account / region / agreements (accountData already fetched in picker) ---
  onProgress('Verifying account details…', 'active', 2);
  const accountData = input.accountData;
  const regionLetter = getRegionLetterFromAccount(accountData, input.mpan);
  if (regionLetter === null) {
    throw new Error(`Could not find MPAN ${input.mpan} on account ${input.accountNumber}.`);
  }
  if (regionLetter === 'MPAN_FOUND_NO_REGION') {
    throw new Error(
      `Found MPAN ${input.mpan} on this account, but could not determine its region from the tariff codes.`,
    );
  }
  const agreements = getAgreementsForMpan(accountData, input.mpan);
  const currentAgreement = findCurrentAgreement(agreements, new Date());
  const postcodeArea = getPostcodeAreaForMpan(accountData, input.mpan);
  onProgress(`Account verified. Region ${regionLetter}.`, 'ok', 8);

  // --- statements (real bill periods + amounts) ---
  onProgress('Authenticating to fetch your real billing periods…', 'active', 15);
  const token = await obtainKrakenToken(client, input.apiKey);
  onProgress('Fetching statements…', 'active', 18);
  const statementFetch = await fetchStatementsForMpan(
    client,
    token,
    input.mpan,
    input.accountNumber,
    accountData,
  );
  const {
    statements: allStatements,
    incomplete: statementsIncomplete,
    accountsWithMeter,
    accountsUsedForStatements,
    unsafeAccountsWithMeter,
  } = statementFetch;
  const estimateOnlyUnsafeStatements =
    allStatements.length === 0 && accountsUsedForStatements === 0 && unsafeAccountsWithMeter > 0;
  const partialUnsafeStatements = accountsUsedForStatements > 0 && unsafeAccountsWithMeter > 0;
  if (allStatements.length === 0 && !estimateOnlyUnsafeStatements) {
    throw new Error(
      'No statements found on this account. Your account may not have statement history available via the API.',
    );
  }
  const statementAttribution = {
    mode: estimateOnlyUnsafeStatements
      ? ('estimate-only-unsafe-multi-mpan' as const)
      : partialUnsafeStatements
        ? ('partial-statements-unsafe-multi-mpan' as const)
        : ('safe-statements' as const),
    accountsWithMeter,
    accountsUsedForStatements,
    unsafeAccountsWithMeter,
  };
  const validStatements = allStatements.filter((s) => s.startAt && s.endAt);
  onProgress(
    estimateOnlyUnsafeStatements
      ? 'No safely attributable statements — using estimates only.'
      : `Found ${allStatements.length} statement(s).`,
    statementsIncomplete ? 'err' : 'ok',
    20,
  );

  // --- comparison window, aligned to real statement boundaries ---
  const dataAvailableTo = new Date();
  dataAvailableTo.setDate(dataAvailableTo.getDate() - 7);
  dataAvailableTo.setUTCHours(0, 0, 0, 0);
  const earliestApprox = new Date(dataAvailableTo);
  earliestApprox.setMonth(earliestApprox.getMonth() - 13);
  const starts = validStatements.map((s) => new Date(s.startAt as string).getTime());
  const earliestStatement = starts.length ? new Date(Math.min(...starts)) : null;
  // Upper bound is the consumption horizon (~7 days ago), NOT the last bill. The
  // Flexible/Agile calc needs only readings + rates, so recent usage past the most
  // recent statement still gets compared (a synthetic trailing period below carries
  // it, with no "actual paid"). Capping at the last statement silently dropped any
  // usage a user had beyond their latest bill.
  const periodTo = dataAvailableTo;
  const periodFrom =
    earliestStatement && earliestStatement > earliestApprox ? earliestStatement : earliestApprox;
  onProgress(`Comparison window: ${isoDate(periodFrom)} to ${isoDate(periodTo)}.`, 'ok', 25);

  // --- consumption (merged + deduped across serials) ---
  onProgress('Fetching half-hourly consumption (the slow part)…', 'active', 30);
  const serials = input.serials.length ? input.serials : [input.serial];
  const merged = await fetchConsumptionMerged(client, input.mpan, serials, periodFrom, periodTo);
  const readings = merged.readings;
  if (readings.length === 0) {
    const testPath = `/electricity-meter-points/${input.mpan}/meters/${input.serial}/consumption/`;
    const testPage = await client.restGet<Page<RawConsumptionRow>>(testPath, { page_size: 1 });
    const testData = testPage.results ?? [];
    if (testData.length === 0) {
      throw new Error(
        `No half-hourly consumption data found for MPAN ${input.mpan}. This meter may not be a smart meter, or data may not have started flowing yet.`,
      );
    }
    const earliest = testData[0]?.interval_start ?? '';
    throw new Error(
      `No consumption data in the comparison window (${isoDate(periodFrom)} to ${isoDate(periodTo)}). This meter has data from ${earliest.slice(0, 10)} — the comparison window may predate your smart meter readings.`,
    );
  }
  onProgress(`Fetched ${readings.length} half-hourly readings.`, 'ok', 40);

  // --- gaps + missing-kWh sensitivity ---
  const gapInfo = detectGaps(readings);
  const missingEstimate = estimateMissingKwh(readings, gapInfo.gaps);
  onProgress(`${gapInfo.gaps.length} gap range(s).`, gapInfo.gaps.length ? 'err' : 'ok', 45);

  // --- statements -> billing periods + billed-vs-observed validation ---
  const richPeriods: RichPeriod[] = validStatements
    .filter(
      (s) =>
        new Date(s.startAt as string) >= periodFrom || new Date(s.endAt as string) > periodFrom,
    )
    .map((s): RichPeriod => {
      const rawStart = new Date(s.startAt as string);
      const rawEnd = new Date(s.endAt as string);
      const totalChargesPence = s.totalCharges?.grossTotal ?? null;
      const txn = summariseStatementTransactions(s);
      const txnUsable = txn.available && txn.complete;
      const electricityChargePence =
        txnUsable && txn.electricityChargePence != null
          ? txn.electricityChargePence
          : txn.available
            ? null
            : totalChargesPence;
      return {
        displayStart: rawStart,
        displayEnd: rawEnd,
        start: rawStart < periodFrom ? periodFrom : rawStart,
        end: rawEnd > periodTo ? periodTo : rawEnd,
        actualChargePence: electricityChargePence,
        billedKwh: txnUsable ? txn.billedKwh : null,
        creditsPence: txnUsable ? txn.creditsPence : 0,
        credits: txnUsable ? txn.credits : [],
        transactionsAvailable: txn.available,
        transactionsComplete: txn.complete,
        statementCharges: txnUsable ? txn.charges : [],
      };
    })
    .filter((p) => p.end > periodFrom && p.start < periodTo && p.end > p.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const statementValidation: StatementValidationEntry[] = richPeriods.map((p) => {
    const observedKwh = readings.reduce(
      (sum, r) => (r.start >= p.start && r.start < p.end ? sum + r.kwh : sum),
      0,
    );
    const wasClamped =
      p.start.getTime() !== p.displayStart.getTime() || p.end.getTime() !== p.displayEnd.getTime();
    return {
      displayStart: p.displayStart,
      displayEnd: p.displayEnd,
      billedKwh: p.billedKwh,
      observedKwh,
      electricityChargePence: p.actualChargePence,
      creditsPence: p.creditsPence,
      credits: p.credits,
      transactionsAvailable: p.transactionsAvailable,
      transactionsComplete: p.transactionsComplete,
      wasClamped,
      mismatch: !wasClamped && billedKwhMismatch(p.billedKwh, observedKwh),
      statementCharges: p.statementCharges,
    };
  });

  // Carry EVERY reading-bearing span the statements don't cover — before the first
  // bill, between non-adjacent bills, and after the last bill — as a synthetic
  // period with no "actual paid" (statementValidation above stays statement-only).
  // Without this, usage in any coverage hole (a missing/estimated bill, or usage
  // newer than the last bill) is silently dropped from the Flexible/Agile comparison.
  const synthPeriod = (from: Date, to: Date): RichPeriod => ({
    displayStart: from,
    displayEnd: to,
    start: from,
    end: to,
    actualChargePence: null,
    billedKwh: null,
    creditsPence: 0,
    credits: [],
    transactionsAvailable: false,
    transactionsComplete: true,
    statementCharges: [],
  });
  const hasReadingsIn = (from: Date, to: Date): boolean =>
    to.getTime() - from.getTime() > DAY_MS &&
    readings.some((r) => r.start.getTime() >= from.getTime() && r.start.getTime() < to.getTime());

  const sortedRich = [...richPeriods].sort((a, b) => a.start.getTime() - b.start.getTime());
  const periodsForSplit: RichPeriod[] = [...richPeriods];
  let latestStatementEnd: Date | null = null;
  let cursor = periodFrom;
  for (const p of sortedRich) {
    if (p.start.getTime() > cursor.getTime() && hasReadingsIn(cursor, p.start)) {
      periodsForSplit.push(synthPeriod(cursor, p.start)); // leading / inter-statement gap
    }
    if (p.end.getTime() > cursor.getTime()) cursor = p.end;
    if (latestStatementEnd === null || p.displayEnd.getTime() > latestStatementEnd.getTime()) {
      latestStatementEnd = p.displayEnd;
    }
  }
  // Trailing span past the last bill — tracked specifically so the honest UI note
  // ("most recent usage isn't billed yet") fires exactly when this period exists.
  const readingsBeyondStatements = hasReadingsIn(cursor, periodTo);
  if (readingsBeyondStatements) {
    periodsForSplit.push(synthPeriod(cursor, periodTo));
  }

  const split = splitLongPeriods(periodsForSplit);
  if (split.length === 0) {
    throw new Error('No statements found covering this window.');
  }
  onProgress(`Found ${split.length} billing period(s).`, 'ok', 50);

  // --- Flexible rates (always fetched — used for pre-switch periods and as fallback) ---
  onProgress('Discovering Flexible Octopus product version(s)…', 'active', 55);
  const flexProducts = await findProductsByDisplayNameOverlapping(
    client,
    'Flexible Octopus',
    periodFrom,
    periodTo,
  );
  if (flexProducts.length === 0) {
    throw new Error('Could not find a Flexible Octopus product via the API.');
  }
  const flexUnitMerged = await fetchMergedRateWindows(
    client,
    flexProducts,
    regionLetter,
    'standard-unit-rates',
    periodFrom,
    periodTo,
  );
  const flexStandingMerged = await fetchMergedRateWindows(
    client,
    flexProducts,
    regionLetter,
    'standing-charges',
    periodFrom,
    periodTo,
  );
  const flexUnitRates = flexUnitMerged.windows;
  const flexStanding = flexStandingMerged.windows;
  const flexProductCode = flexUnitMerged.used.join(', ') || flexProducts[0]?.code || 'not found';
  if (flexUnitRates.length === 0 && flexUnitMerged.rawCount === 0) {
    throw new Error(`Could not find Flexible Octopus rates for region ${regionLetter}.`);
  }
  onProgress(`Flexible Octopus: ${flexUnitRates.length} unit rate window(s).`, 'ok', 60);

  // --- Actual current-tariff rates (non-Flexible, non-Agile users) ---
  // Flexible users: the flex column IS already their tariff (fetched above via product search).
  // Agile users: compare against Flexible by design — skip.
  // Supported current tariffs (flat-rate or Go-like day/night) use their actual
  // rates; unsupported ToU shapes fall back to Flexible proxy with a caveat.
  const currentTariffKind = classifyTariffCode(currentAgreement?.tariff_code).kind;
  const onFlexible = currentTariffKind === 'flexible';
  const onAgile = currentTariffKind === 'agile';
  let currentTariffRates: CurrentTariffRates | null = null;
  let flexNote: string | null = null;
  if (!onFlexible && !onAgile && currentAgreement) {
    onProgress('Fetching your current tariff rates…', 'active', 62);
    try {
      const currentTariffRateResult = await fetchCurrentTariffRates(
        client,
        currentAgreement.tariff_code,
        periodFrom,
        periodTo,
      );
      if (currentTariffRateResult.status === 'available') {
        currentTariffRates = currentTariffRateResult;
        const label =
          currentTariffRateResult.rateShape === 'go-day-night' ? 'Go-style day/night' : 'flat-rate';
        onProgress(
          `Current tariff (${label}): ${currentTariffRates.unitWindows.length} rate window(s).`,
          'ok',
          64,
        );
      } else {
        flexNote =
          currentTariffRateResult.reason +
          ' Flexible Octopus is used as the comparison baseline for these periods.';
        onProgress(
          currentTariffRateResult.status === 'unsupported'
            ? 'Current tariff shape unsupported — using Flexible as proxy.'
            : 'Current tariff rates unavailable — using Flexible as proxy.',
          'ok',
          64,
        );
      }
    } catch {
      flexNote =
        'Could not fetch your current tariff rates. ' +
        'Flexible Octopus is used as the comparison baseline for these periods.';
      onProgress('Current tariff rate fetch failed — using Flexible as proxy.', 'ok', 64);
    }
  }
  const currentTariffCode = currentAgreement?.tariff_code ?? null;
  const currentTariffLabel = currentTariffCode
    ? classifyTariffCode(currentTariffCode).label
    : 'your tariff';
  const flexColumnSource: FlexColumnSource = onFlexible
    ? {
        kind: 'flexible-current',
        label: currentTariffLabel,
        tariffCode: currentTariffCode,
      }
    : onAgile
      ? { kind: 'flexible-alternative', label: 'Flexible' }
      : currentTariffRates && currentTariffCode
        ? {
            kind: 'current-tariff-rates',
            label: currentTariffLabel,
            tariffCode: currentTariffCode,
            rateShape: currentTariffRates.rateShape,
          }
        : currentTariffCode
          ? {
              kind: 'flexible-proxy',
              label: 'Flexible proxy',
              actualTariffLabel: currentTariffLabel,
              actualTariffCode: currentTariffCode,
              reason: flexNote ?? 'Current tariff rates are not available via the Octopus API.',
            }
          : { kind: 'flexible-alternative', label: 'Flexible' };

  // --- Agile rates (optional) ---
  onProgress('Discovering Agile Octopus product version(s)…', 'active', 65);
  const agileProducts = await findProductsByDisplayNameOverlapping(
    client,
    'Agile Octopus',
    periodFrom,
    periodTo,
  );
  let agileUnitRates: RateWindow[] = [];
  let agileStanding: RateWindow[] = [];
  let agileAvailable = true;
  let agileProductCode = agileProducts.map((p) => p.code).join(', ');
  // Record WHY Agile was dropped (status only, never a response body) so a stale
  // result can be told apart from a transient rate-limit vs a genuine no-rates case.
  let agileSkipReason: string | null = null;
  if (agileProducts.length === 0) {
    agileAvailable = false;
    agileSkipReason = 'no Agile product overlaps the window';
  } else {
    try {
      const agileUnitMerged = await fetchMergedRateWindows(
        client,
        agileProducts,
        regionLetter,
        'standard-unit-rates',
        periodFrom,
        periodTo,
      );
      const agileStandingMerged = await fetchMergedRateWindows(
        client,
        agileProducts,
        regionLetter,
        'standing-charges',
        periodFrom,
        periodTo,
      );
      agileUnitRates = agileUnitMerged.windows;
      agileStanding = agileStandingMerged.windows;
      agileProductCode = agileUnitMerged.used.join(', ') || agileProductCode;
      if (agileUnitRates.length === 0) {
        agileAvailable = false;
        agileSkipReason = `no Agile rates for region ${regionLetter} in the window`;
      }
    } catch (e) {
      agileAvailable = false;
      agileSkipReason =
        e instanceof OctopusApiError
          ? `Agile rate fetch HTTP ${e.status ?? 'network'}`
          : 'Agile rate fetch error';
    }
  }
  onProgress(
    agileAvailable ? `Agile: ${agileUnitRates.length} window(s).` : 'Agile skipped.',
    'ok',
    85,
  );

  // --- per-period costs ---
  onProgress('Calculating costs per billing period…', 'active', 90);
  const flexUnitSorted = [...flexUnitRates].sort(
    (a, b) => a.validFrom.getTime() - b.validFrom.getTime(),
  );
  const agileUnitSorted = agileAvailable
    ? [...agileUnitRates].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())
    : [];
  const tariffAt = makeTariffAtDateFn(agreements);
  const currentStandingSorted = currentTariffRates
    ? [...currentTariffRates.standingWindows].sort(
        (a, b) => a.validFrom.getTime() - b.validFrom.getTime(),
      )
    : null;

  const periods: PeriodComparison[] = split.map((sp): PeriodComparison => {
    // Use the user's actual tariff rates for on-current periods (Go, Fixed, Tracker…);
    // fall back to Flexible for pre-switch or mixed periods where we have no current rates.
    const mid = new Date((sp.start.getTime() + sp.end.getTime()) / 2);
    const midTariff = tariffAt(mid);
    const cr = currentTariffRates;
    const useCurrentRates =
      cr !== null && currentStandingSorted !== null && midTariff === currentTariffCode;
    const periodFlexUnit = useCurrentRates && cr ? cr.unitWindows : flexUnitSorted;
    const periodFlexStanding =
      useCurrentRates && currentStandingSorted ? currentStandingSorted : flexStanding;
    const flex = calculateCost(
      readings,
      sp.start,
      sp.end,
      periodFlexUnit,
      periodFlexStanding,
      true,
    );
    const agile = agileAvailable
      ? calculateCost(readings, sp.start, sp.end, agileUnitSorted, agileStanding, true)
      : null;
    const wasClamped =
      sp.start.getTime() !== sp.displayStart.getTime() ||
      sp.end.getTime() !== sp.displayEnd.getTime();
    let suspectActual = false;
    if (sp.actualChargePence != null && flex.kwh > 0) {
      const standingApprox = agile ? agile.standingChargePence : flex.standingChargePence;
      const implied = (sp.actualChargePence - standingApprox) / flex.kwh;
      if (implied > 150 || implied < -20) suspectActual = true;
    }
    const credits =
      !sp.isSplit && Array.isArray(sp['credits']) ? (sp['credits'] as StatementCredit[]) : [];
    return {
      displayStart: sp.displayStart,
      displayEnd: sp.displayEnd,
      start: sp.start,
      end: sp.end,
      isSplit: sp.isSplit,
      actualChargePence: sp.actualChargePence,
      billedKwh: sp.isSplit ? null : readNum(sp['billedKwh']),
      creditsPence: sp.isSplit ? 0 : (readNum(sp['creditsPence']) ?? 0),
      credits,
      transactionsAvailable: sp.isSplit ? false : sp['transactionsAvailable'] === true,
      transactionsComplete: sp.isSplit ? true : sp['transactionsComplete'] !== false,
      flex,
      agile,
      wasClamped,
      suspectActual,
      confident:
        !wasClamped &&
        !suspectActual &&
        flex.unmatchedReadings === 0 &&
        flex.unmatchedStandingDays === 0 &&
        (!agile || (agile.unmatchedReadings === 0 && agile.unmatchedStandingDays === 0)),
      tariffCodes: [...tariffCodesInRange(agreements, sp.start, sp.end)],
      actualTariffCode: tariffAt(mid),
    };
  });
  onProgress('Done.', 'ok', 100);

  // For the drill-down detail: use the user's actual tariff rates when available.
  // Pre-switch drill-downs get Go/Fixed/etc rates rather than Flexible — minor label
  // mismatch ("Flexible") but pre-switch drill-down is secondary and not in headline.
  const detailFlexUnit = currentTariffRates?.unitWindows ?? flexUnitSorted;
  const detailFlexStanding = currentStandingSorted ?? flexStanding;
  const effectiveFlexProductCode = currentTariffRates?.productCode ?? flexProductCode;

  return {
    periods,
    detail: {
      readings,
      flexUnitSorted: detailFlexUnit,
      agileUnitSorted,
      flexStanding: detailFlexStanding,
      agileStanding,
      agileAvailable,
      duplicateIntervals: merged.duplicateIntervals,
    },
    context: {
      regionLetter,
      postcodeArea,
      currentAgreement,
      agreements,
      flexColumnSource,
      periodFrom,
      periodTo,
      agileAvailable,
      statementValidation,
      missingEstimate,
      statementsIncomplete,
      statementAttribution,
      latestStatementEnd,
      readingsBeyondStatements,
      agileSkipReason,
      flexNote,
      gapInfo,
      products: {
        flexProductCode: effectiveFlexProductCode,
        flexTariffCode: effectiveFlexProductCode,
        agileProductCode,
        agileTariffCode: agileProductCode,
      },
    },
  };
}
