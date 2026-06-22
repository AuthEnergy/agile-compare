import { REPLAY_CAPS } from '../config';
import { calculateCost } from '../domain/cost';
import { splitLongPeriods } from '../domain/periods';
import { classifyTariffCode, findCurrentAgreement } from '../domain/tariff';
import type { Agreement, CostResult, MissingEstimate, RateWindow, Reading } from '../types/domain';
import type {
  ComparisonRun,
  ExportRun,
  ExportTariffValue,
  FlexColumnSource,
  PeriodComparison,
  RunContext,
  RunDetail,
  StatementValidationEntry,
} from '../types/result';

const HALF_HOUR_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReplayErrorReason =
  | 'invalid-json'
  | 'not-diagnostics'
  | 'too-large'
  | 'invalid-window'
  | 'replay-error';

interface ReplayMeta {
  appVersion: string;
  generatedAt: string | null;
}
export type ReplaySuccess =
  | { ok: true; kind: 'import'; run: ComparisonRun; meta: ReplayMeta }
  | { ok: true; kind: 'export'; exportRun: ExportRun; meta: ReplayMeta };
export interface ReplayFailure {
  ok: false;
  reason: ReplayErrorReason;
  message: string;
}
export type ReplayResult = ReplaySuccess | ReplayFailure;

// --- untrusted-input accessors (the file may be hand-edited or hostile) ---
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asNum = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};
// v2's `num`: integer pence, or null for the "n/a" sentinel / missing.
const numOrNull = (v: unknown): number | null => {
  if (v === 'n/a' || v == null) return null;
  const n = typeof v === 'number' ? Math.trunc(v) : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};
const floatOrNull = (v: unknown): number | null => {
  if (v === 'n/a' || v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const intOr0 = (v: unknown): number => numOrNull(v) ?? 0;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

const toWindows = (arr: unknown): RateWindow[] =>
  asArr(arr).map((w): RateWindow => {
    const o = isObj(w) ? w : {};
    return {
      validFrom: new Date(asStr(o['from'])),
      validTo: typeof o['to'] === 'string' ? new Date(o['to']) : null,
      value: asNum(o['p']),
    };
  });

function parseFlexColumnSource(
  value: unknown,
  tariffOverride: boolean,
  currentAgreement: Agreement | null,
): FlexColumnSource {
  const o = isObj(value) ? value : null;
  const kind = asStr(o?.['kind']);
  if (kind === 'flexible-current') {
    return {
      kind,
      label: asStr(o?.['label'], 'Flexible'),
      tariffCode: strOrNull(o?.['tariffCode']),
    };
  }
  if (kind === 'flexible-alternative') {
    return { kind, label: 'Flexible' };
  }
  if (kind === 'current-tariff-rates') {
    const tariffCode = asStr(o?.['tariffCode'], currentAgreement?.tariff_code ?? 'unknown');
    const shape = asStr(o?.['rateShape']);
    return {
      kind,
      label: asStr(o?.['label'], classifyTariffCode(tariffCode).label),
      tariffCode,
      rateShape: shape === 'go-day-night' || shape === 'time-of-use' ? 'go-day-night' : 'flat',
    };
  }
  if (kind === 'flexible-proxy') {
    const actualTariffCode = asStr(
      o?.['actualTariffCode'],
      currentAgreement?.tariff_code ?? 'unknown',
    );
    return {
      kind,
      label: 'Flexible proxy',
      actualTariffLabel: asStr(
        o?.['actualTariffLabel'],
        classifyTariffCode(actualTariffCode).label,
      ),
      actualTariffCode,
      reason: asStr(o?.['reason'], 'Legacy diagnostics did not record tariff baseline provenance.'),
    };
  }
  if (kind === 'user-override' || tariffOverride) {
    return { kind: 'user-override', label: 'User tariff' };
  }

  const currentTariffCode = currentAgreement?.tariff_code ?? null;
  const cls = classifyTariffCode(currentTariffCode);
  if (cls.kind === 'flexible') {
    return {
      kind: 'flexible-current',
      label: cls.label,
      tariffCode: currentTariffCode,
    };
  }
  if (cls.kind === 'agile') {
    return { kind: 'flexible-alternative', label: 'Flexible' };
  }
  return {
    kind: 'flexible-proxy',
    label: 'Flexible proxy',
    actualTariffLabel: cls.label,
    actualTariffCode: currentTariffCode ?? 'unknown',
    reason: 'Legacy diagnostics did not record tariff baseline provenance.',
  };
}

const fail = (reason: ReplayErrorReason, message: string): ReplayFailure => ({
  ok: false,
  reason,
  message,
});

// Replay a downloaded diagnostics file back into a ComparisonRun — the same
// model a live run produces — so the existing headline/UI render it with NO live
// API calls. Ports v2's `processDiagnosticFile` including its size/schema caps,
// returning structured errors instead of `alert()` so the UI maps them.
export function replayDiagnostics(text: string): ReplayResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(
      'invalid-json',
      'Could not parse this file as JSON. Upload a diagnostics file downloaded from this tool.',
    );
  }
  if (!isObj(parsed)) {
    return fail('not-diagnostics', 'This file does not contain a diagnostics object.');
  }
  const d = parsed;

  // Export ("Outgoing") diagnostics have a different shape (aggregate income, no
  // billing periods or rate windows). Reconstruct an ExportRun from the stored
  // totals — the per-slot detail isn't replayable because export bundles never
  // carry rate windows (kept aggregate-only for privacy), but the figures are.
  if (d['mode'] === 'export') {
    const cwx = isObj(d['comparisonWindow']) ? d['comparisonWindow'] : null;
    if (
      !cwx ||
      isNaN(new Date(asStr(cwx['from'])).getTime()) ||
      isNaN(new Date(asStr(cwx['to'])).getTime())
    ) {
      return fail(
        'invalid-window',
        "This export diagnostics file is missing a valid comparison window, so it can't be replayed.",
      );
    }
    if (len((isObj(d['readings']) ? d['readings'] : {})['raw']) > REPLAY_CAPS.readingsRaw) {
      return fail(
        'too-large',
        'This diagnostics file is unexpectedly large. Refusing to render it to avoid freezing the tab.',
      );
    }
    try {
      return {
        ok: true,
        kind: 'export',
        exportRun: reconstructExport(d, cwx),
        meta: {
          appVersion: asStr(d['appVersion'], 'unknown version'),
          generatedAt: strOrNull(d['generatedAt']),
        },
      };
    } catch (err) {
      return fail(
        'replay-error',
        `Error processing export diagnostics file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!d['billingPeriods'] || !d['readings'] || !d['rateWindows']) {
    return fail(
      'not-diagnostics',
      "This doesn't look like an Octopus Tariff Check diagnostics file. Use one downloaded via 'Download diagnostics' on the results screen.",
    );
  }

  const readingsObj = isObj(d['readings']) ? d['readings'] : {};
  const rateWindowsObj = isObj(d['rateWindows']) ? d['rateWindows'] : {};
  // Schema/size sanity caps: a real diagnostic is a few years of half-hourly
  // data at most. Refuse anything absurdly large or malformed.
  if (
    len(readingsObj['raw']) > REPLAY_CAPS.readingsRaw ||
    len(d['billingPeriods']) > REPLAY_CAPS.billingPeriods ||
    len(rateWindowsObj['rawAgileUnitRates']) > REPLAY_CAPS.rawUnitRates ||
    len(rateWindowsObj['rawFlexUnitRates']) > REPLAY_CAPS.rawUnitRates ||
    len(rateWindowsObj['rawAgileStandingCharges']) > REPLAY_CAPS.rawStandingCharges ||
    len(rateWindowsObj['rawFlexStandingCharges']) > REPLAY_CAPS.rawStandingCharges
  ) {
    return fail(
      'too-large',
      'This diagnostics file is unexpectedly large (too many readings, rate windows, or periods). Refusing to render it to avoid freezing the tab.',
    );
  }

  const cw = isObj(d['comparisonWindow']) ? d['comparisonWindow'] : null;
  if (
    !cw ||
    isNaN(new Date(asStr(cw['from'])).getTime()) ||
    isNaN(new Date(asStr(cw['to'])).getTime())
  ) {
    return fail(
      'invalid-window',
      "This diagnostics file is missing a valid comparison window, so it can't be replayed.",
    );
  }

  // Per-period span cap: the array-length caps above don't bound a single
  // period's date span. A hostile calculationPeriod like
  // "2000-01-01 to +275760-09-13" parses to a valid but astronomically distant
  // Date; splitLongPeriods would then loop millions of times and freeze the tab.
  // Reject such a file before reconstruction. (An unparseable date yields NaN and
  // is handled safely downstream — the split loop's comparisons are simply false.)
  for (const p of asArr(d['billingPeriods'])) {
    const o = isObj(p) ? p : {};
    const calc = asStr(o['calculationPeriod']).split(' to ');
    const start = new Date(calc[0] ?? '').getTime();
    const end = new Date(calc[1] ?? '').getTime();
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      (end - start) / DAY_MS > REPLAY_CAPS.maxPeriodDays
    ) {
      return fail(
        'too-large',
        'A billing period in this file spans an implausible date range; refusing to render it to avoid freezing the tab.',
      );
    }
  }

  try {
    const run = reconstruct(d, readingsObj, rateWindowsObj, cw);
    return {
      ok: true,
      kind: 'import',
      run,
      meta: {
        appVersion: asStr(d['appVersion'], 'unknown version'),
        generatedAt: strOrNull(d['generatedAt']),
      },
    };
  } catch (err) {
    return fail(
      'replay-error',
      `Error processing diagnostics file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function reconstruct(
  d: Record<string, unknown>,
  readingsObj: Record<string, unknown>,
  rateWindowsObj: Record<string, unknown>,
  cw: Record<string, unknown>,
): ComparisonRun {
  const flexUnitRates = toWindows(rateWindowsObj['rawFlexUnitRates']);
  const flexStanding = toWindows(rateWindowsObj['rawFlexStandingCharges']);
  const agileUnitRates = toWindows(rateWindowsObj['rawAgileUnitRates']);
  const agileStanding = toWindows(rateWindowsObj['rawAgileStandingCharges']);
  const agileAvailable = agileUnitRates.length > 0;
  const flexUnitSorted = [...flexUnitRates].sort(
    (a, b) => a.validFrom.getTime() - b.validFrom.getTime(),
  );
  const agileUnitSorted = [...agileUnitRates].sort(
    (a, b) => a.validFrom.getTime() - b.validFrom.getTime(),
  );

  const readings: Reading[] = asArr(readingsObj['raw']).map((r): Reading => {
    const o = isObj(r) ? r : {};
    const start = new Date(asStr(o['t']));
    return { start, end: new Date(start.getTime() + HALF_HOUR_MS), kwh: asNum(o['kwh']) };
  });

  const agreements: Agreement[] = asArr(d['agreements']).map((a): Agreement => {
    const o = isObj(a) ? a : {};
    return {
      tariff_code: asStr(o['tariffCode']),
      valid_from: asStr(o['validFrom']),
      valid_to: strOrNull(o['validTo']),
    };
  });
  const tariffOverride = d['tariffOverride'] === true;
  // Use generatedAt as the reference so a pre-announced future agreement (validTo=null,
  // validFrom in the future) is not mistaken for the one in force when the file was made.
  const generatedAtStr = asStr(d['generatedAt']);
  const generatedAtMs = generatedAtStr ? new Date(generatedAtStr).getTime() : NaN;
  const referenceDate = Number.isFinite(generatedAtMs) ? new Date(generatedAtMs) : new Date();
  const derivedCurrentAgreement = findCurrentAgreement(agreements, referenceDate);
  const currentAgreement = tariffOverride
    ? {
        tariff_code: 'User tariff',
        valid_from: asStr(cw['from']),
        valid_to: asStr(cw['to']),
      }
    : derivedCurrentAgreement;
  const currentTariffCode = currentAgreement?.tariff_code ?? null;

  // Pre-split from stored billing periods, then re-split long ones (an older file
  // with one long period is broken into months). `_orig` rides the index
  // signature so the non-split path can read back stored pences.
  const billingPeriodsRaw: Record<string, unknown>[] = asArr(d['billingPeriods']).map((p) =>
    isObj(p) ? p : {},
  );
  const rawDiagPeriods = billingPeriodsRaw.map((p) => {
    const disp = asStr(p['displayPeriod']).split(' to ');
    const calc = asStr(p['calculationPeriod']).split(' to ');
    return {
      displayStart: new Date(disp[0] ?? ''),
      displayEnd: new Date(disp[1] ?? ''),
      start: new Date(calc[0] ?? ''),
      end: new Date(calc[1] ?? ''),
      actualChargePence: numOrNull(p['actualPence']),
      _orig: p,
    };
  });
  const splitDiagPeriods = splitLongPeriods(rawDiagPeriods);

  const periods: PeriodComparison[] = splitDiagPeriods.map((sp): PeriodComparison => {
    const origRaw = sp['_orig'];
    const orig: Record<string, unknown> = isObj(origRaw)
      ? origRaw
      : (billingPeriodsRaw.find(
          (bp) =>
            new Date(asStr(bp['displayPeriod']).split(' to ')[0] ?? '').getTime() ===
            sp.displayStart.getTime(),
        ) ??
        billingPeriodsRaw[0] ??
        {});

    let flex: CostResult;
    let agile: CostResult | null;
    if (sp.isSplit && readings.length > 0) {
      flex = calculateCost(readings, sp.start, sp.end, flexUnitSorted, flexStanding, true);
      agile = agileAvailable
        ? calculateCost(readings, sp.start, sp.end, agileUnitSorted, agileStanding, true)
        : null;
    } else {
      const kwh = asNum(orig['kwh']);
      flex = {
        kwh,
        energyCostPence: numOrNull(orig['flexEnergyPence']) ?? 0,
        standingChargePence: numOrNull(orig['flexStandingPence']) ?? 0,
        totalPence: numOrNull(orig['flexTotalPence']) ?? 0,
        unmatchedReadings: asNum(orig['flexUnmatched']),
        unmatchedStandingDays: intOr0(orig['flexUnmatchedStanding']),
      };
      const agileMissing = orig['agileTotalPence'] === 'n/a' || orig['agileTotalPence'] == null;
      agile = agileMissing
        ? null
        : {
            kwh,
            energyCostPence: numOrNull(orig['agileEnergyPence']) ?? 0,
            standingChargePence: numOrNull(orig['agileStandingPence']) ?? 0,
            totalPence: numOrNull(orig['agileTotalPence']) ?? 0,
            unmatchedReadings: asNum(orig['agileUnmatched']),
            unmatchedStandingDays: intOr0(orig['agileUnmatchedStanding']),
          };
    }

    const wasClamped = !sp.isSplit && !!orig['clamped'];
    const suspectActual = !sp.isSplit && !!orig['suspectActual'];
    const confident =
      !wasClamped &&
      !suspectActual &&
      flex.unmatchedReadings === 0 &&
      flex.unmatchedStandingDays === 0 &&
      (!agile || (agile.unmatchedReadings === 0 && agile.unmatchedStandingDays === 0));

    // Reconstruct the tariff attribution so the headline's consistent-subset
    // filter (size 1 AND == current AND confident) reproduces v2's stored
    // `!preSwitch && !mixedTariff` membership. The full range set isn't stored,
    // so mixed periods are given a 2-element placeholder to force exclusion.
    const origActual = asStr(orig['actualTariffCode'], 'unknown') || 'unknown';
    const preSwitch = !!orig['preSwitch'];
    const mixedTariff = !!orig['mixedTariff'];
    let tariffCodes: string[];
    if (mixedTariff) {
      const other = currentTariffCode ?? '(current)';
      tariffCodes =
        origActual === other ? [origActual, `${origActual} (+other)`] : [origActual, other];
    } else if (preSwitch) {
      tariffCodes = [origActual];
    } else {
      tariffCodes = [currentTariffCode ?? origActual];
    }

    return {
      displayStart: sp.displayStart,
      displayEnd: sp.displayEnd,
      start: sp.start,
      end: sp.end,
      isSplit: sp.isSplit,
      actualChargePence: sp.actualChargePence,
      billedKwh: null,
      creditsPence: 0,
      credits: [],
      transactionsAvailable: true,
      transactionsComplete: true,
      flex,
      agile,
      wasClamped,
      suspectActual,
      confident,
      tariffCodes,
      actualTariffCode: origActual,
    };
  });

  const statementValidation: StatementValidationEntry[] = asArr(d['statementValidation']).map(
    (v): StatementValidationEntry => {
      const o = isObj(v) ? v : {};
      const parts = asStr(o['period'], ' to ').split(' to ');
      return {
        displayStart: new Date(parts[0] ?? ''),
        displayEnd: new Date(parts[1] ?? ''),
        billedKwh: o['billedKwh'] === 'n/a' ? null : floatOrNull(o['billedKwh']),
        observedKwh: asNum(o['observedKwh']),
        electricityChargePence:
          o['electricityChargePence'] === 'n/a' ? null : numOrNull(o['electricityChargePence']),
        creditsPence: intOr0(o['creditsPence']),
        credits: [],
        transactionsAvailable: !!o['transactionsAvailable'],
        transactionsComplete: !!o['transactionsComplete'],
        wasClamped: !!o['clamped'],
        mismatch: !!o['mismatch'],
        statementCharges: asArr(o['charges']).map((c) => {
          const co = isObj(c) ? c : {};
          return {
            title: asStr(co['title']),
            grossPence: intOr0(co['grossPence']),
            kwh: co['kwh'] === 'n/a' ? null : floatOrNull(co['kwh']),
          };
        }),
      };
    },
  );

  const gapsObj = isObj(d['gaps']) ? d['gaps'] : {};
  const missingEstimate: MissingEstimate = {
    totalKwh: asNum(gapsObj['medianProfileKwhEstimate']),
    slots: 0,
    perGap: asArr(gapsObj['medianProfilePerGap']).map((g) => {
      const o = isObj(g) ? g : {};
      return {
        from: new Date(asStr(o['from'])),
        to: new Date(asStr(o['to'])),
        slots: asNum(o['slots']),
        kwh: asNum(o['kwh']),
      };
    }),
  };

  const earliestStr = readingsObj['earliest'];
  const latestStr = readingsObj['latest'];
  const gapInfo: RunContext['gapInfo'] = {
    gaps: asArr(gapsObj['ranges']).map((r) => {
      const parts = asStr(r).split(' to ');
      return { start: new Date(parts[0] ?? ''), end: new Date(parts[1] ?? '') };
    }),
    duplicates: [],
    earliest:
      typeof earliestStr === 'string' && earliestStr !== 'none' ? new Date(earliestStr) : null,
    latest: typeof latestStr === 'string' && latestStr !== 'none' ? new Date(latestStr) : null,
  };

  const productsObj = isObj(d['products']) ? d['products'] : {};
  const detail: RunDetail = {
    readings,
    flexUnitSorted,
    agileUnitSorted,
    flexStanding,
    agileStanding,
    agileAvailable,
    duplicateIntervals: new Set<number>(),
  };
  const context: RunContext = {
    regionLetter: asStr(d['region']),
    postcodeArea: strOrNull(d['postcodeArea']),
    currentAgreement,
    agreements,
    tariffOverride,
    flexColumnSource: parseFlexColumnSource(
      d['flexColumnSource'],
      tariffOverride,
      currentAgreement,
    ),
    periodFrom: new Date(asStr(cw['from'])),
    periodTo: new Date(asStr(cw['to'])),
    agileAvailable,
    statementValidation,
    missingEstimate,
    statementsIncomplete: !!d['statementsIncomplete'],
    gapInfo,
    products: {
      flexProductCode: asStr(productsObj['flexProductCode']),
      flexTariffCode: asStr(productsObj['flexTariffCode']),
      agileProductCode: asStr(productsObj['agileProductCode']),
      agileTariffCode: asStr(productsObj['agileTariffCode']),
    },
  };

  return { periods, detail, context };
}

// Reconstruct an ExportRun from an export ("Outgoing") diagnostics file. The file
// is aggregate-only (income totals + kWh), so this restores the headline figures;
// it never carries rate windows, so the per-slot detail is not replayable and the
// detail readings are deliberately left empty (showing them at £0 would mislead).
function reconstructExport(d: Record<string, unknown>, cw: Record<string, unknown>): ExportRun {
  const toValue = (v: unknown): ExportTariffValue | null => {
    if (!isObj(v)) return null; // 'unavailable' / missing
    return {
      valuePence: asNum(v['valuePence']),
      unmatchedReadings: asNum(v['unmatchedReadings']),
      products: asArr(v['products']).filter((p): p is string => typeof p === 'string'),
    };
  };
  return {
    regionLetter: asStr(d['region']),
    postcodeArea: strOrNull(d['postcodeArea']),
    currentAgreement: null,
    agreements: [],
    periodFrom: new Date(asStr(cw['from'])),
    periodTo: new Date(asStr(cw['to'])),
    exportKwh: asNum(d['exportKwh']),
    flat: toValue(d['outgoingFlat']),
    agile: toValue(d['agileOutgoing']),
    gapInfo: { gaps: [], duplicates: [], earliest: null, latest: null },
    detail: { readings: [], flatWindows: [], agileWindows: [], duplicateIntervals: new Set() },
  };
}
