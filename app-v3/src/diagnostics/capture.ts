import { APP_VERSION } from '../config';
import type { RateWindow } from '../types/domain';
import type { ComparisonRun, ExportRun, PeriodComparison } from '../types/result';
import type {
  DiagBillingPeriod,
  DiagRawWindow,
  ExportDiagnostics,
  ImportDiagnostics,
} from '../types/diagnostics';

export interface CaptureOptions {
  // ISO timestamp the bundle was generated. Injected (not read from a clock) so
  // capture stays pure and tests are deterministic; the UI passes
  // `new Date().toISOString()`.
  generatedAt: string;
  appVersion?: string;
}

const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);
const HALF_HOUR_MS = 30 * 60 * 1000;

// Human-readable one-line summary of a set of rate windows (ported verbatim from
// v2's inline `rateWindowSummary`). Reports count, span, value range and any
// gaps between windows.
function rateWindowSummary(windows: readonly RateWindow[], label: string): string {
  if (!windows || windows.length === 0) return `${label}: none fetched`;
  const sorted = [...windows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  const first = sorted[0];
  const lastWindow = sorted[sorted.length - 1];
  if (!first || !lastWindow) return `${label}: none fetched`;
  const earliest = first.validFrom;
  const latestStr = lastWindow.validTo ? lastWindow.validTo.toISOString().slice(0, 10) : 'open';
  const gaps: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    const prevEnd = prev.validTo;
    if (prevEnd && cur.validFrom.getTime() - prevEnd.getTime() > 60000) {
      gaps.push(
        `${prevEnd.toISOString().slice(0, 16)} to ${cur.validFrom.toISOString().slice(0, 16)}`,
      );
    }
  }
  const values = sorted.map((w) => w.value);
  const minVal = Math.min(...values)
    .toFixed(4)
    .replace(/\.?0+$/, '');
  const maxVal = Math.max(...values)
    .toFixed(4)
    .replace(/\.?0+$/, '');
  return `${label}: ${windows.length} window(s), ${earliest.toISOString().slice(0, 10)} to ${latestStr}, values ${minVal}p to ${maxVal}p${gaps.length ? `, GAPS: ${gaps.join('; ')}` : ', no gaps'}`;
}

const rawWindows = (windows: readonly RateWindow[]): DiagRawWindow[] =>
  windows.map((w) => ({
    from: w.validFrom.toISOString(),
    to: w.validTo ? w.validTo.toISOString() : null,
    p: w.value,
  }));

// Build the per-period diagnostic rows, mirroring v2's `diagBillingPeriods`.
// `preSwitch`/`mixedTariff` are derived from the period's already-computed
// `actualTariffCode` (midpoint tariff) and `tariffCodes` (range set) — the same
// values v2 recomputed inline.
function buildBillingPeriods(
  periods: readonly PeriodComparison[],
  currentTariffCode: string | null,
): DiagBillingPeriod[] {
  return periods.map((r): DiagBillingPeriod => {
    const at = r.actualTariffCode;
    const preSwitch = !!(at && at !== currentTariffCode);
    const mixedTariff = r.tariffCodes.length > 1;
    return {
      displayPeriod: `${fmtDate(r.displayStart)} to ${fmtDate(r.displayEnd)}`,
      calculationPeriod: `${fmtDate(r.start)} to ${fmtDate(r.end)}`,
      actualTariffCode: at || 'unknown',
      preSwitch,
      mixedTariff,
      clamped: r.wasClamped,
      confident: !!r.confident,
      kwh: r.flex.kwh.toFixed(2),
      actualPence: r.actualChargePence != null ? r.actualChargePence.toFixed(0) : 'n/a',
      suspectActual: r.suspectActual || false,
      flexEnergyPence: r.flex.energyCostPence.toFixed(0),
      flexStandingPence: r.flex.standingChargePence.toFixed(0),
      flexTotalPence: r.flex.totalPence.toFixed(0),
      flexUnmatched: r.flex.unmatchedReadings,
      flexUnmatchedStanding: r.flex.unmatchedStandingDays || 0,
      agileEnergyPence: r.agile ? r.agile.energyCostPence.toFixed(0) : 'n/a',
      agileStandingPence: r.agile ? r.agile.standingChargePence.toFixed(0) : 'n/a',
      agileTotalPence: r.agile ? r.agile.totalPence.toFixed(0) : 'n/a',
      agileUnmatched: r.agile ? r.agile.unmatchedReadings : 'n/a',
      agileUnmatchedStanding: r.agile ? r.agile.unmatchedStandingDays || 0 : 'n/a',
    };
  });
}

// Build the success (import) diagnostic from a ComparisonRun. Key-for-key
// equivalent to v2's `state.diagnostics`. NO account number, MPAN, serial or
// address is present in this shape by construction.
export function buildImportDiagnostics(
  run: ComparisonRun,
  opts: CaptureOptions,
): ImportDiagnostics {
  const { periods, detail, context } = run;
  const agileAvailable = detail.agileAvailable;
  const currentTariffCode = context.currentAgreement?.tariff_code ?? null;

  const billingPeriods = buildBillingPeriods(periods, currentTariffCode);

  // Agile-only subtotals: periods billed on the current tariff, not mixed, with
  // an actual charge (v2's `consistentOnlyDiag` filter, verbatim).
  const consistentOnlyDiag = billingPeriods.filter(
    (p) => !p.preSwitch && !p.mixedTariff && p.confident && p.actualPence !== 'n/a',
  );
  const sumInt = (rows: DiagBillingPeriod[], pick: (p: DiagBillingPeriod) => string): number =>
    rows.reduce((s, p) => s + parseInt(pick(p), 10), 0);
  const agileOnlyTotals = {
    periodCount: consistentOnlyDiag.length,
    actualPence: sumInt(consistentOnlyDiag, (p) => p.actualPence),
    flexTotalPence: sumInt(consistentOnlyDiag, (p) => p.flexTotalPence),
    agileTotalPence: sumInt(
      consistentOnlyDiag.filter((p) => p.agileTotalPence !== 'n/a'),
      (p) => p.agileTotalPence,
    ),
  };

  const totalKwhDiag = periods.reduce((s, r) => s + r.flex.kwh, 0);
  const totalFlexUnmatched = periods.reduce((s, r) => s + r.flex.unmatchedReadings, 0);
  const totalAgileUnmatched = agileAvailable
    ? periods.reduce((s, r) => s + (r.agile ? r.agile.unmatchedReadings : 0), 0)
    : 0;
  const totalFlexStandingUnmatched = periods.reduce(
    (s, r) => s + (r.flex.unmatchedStandingDays || 0),
    0,
  );
  const totalAgileStandingUnmatched = agileAvailable
    ? periods.reduce((s, r) => s + (r.agile ? r.agile.unmatchedStandingDays || 0 : 0), 0)
    : 0;
  const clampedPeriods = periods.filter((r) => r.wasClamped).length;

  const gapInfo = context.gapInfo;
  const missingEstimate = context.missingEstimate;

  return {
    generatedAt: opts.generatedAt,
    appVersion: opts.appVersion ?? APP_VERSION,
    comparisonWindow: {
      from: context.periodFrom.toISOString(),
      to: context.periodTo.toISOString(),
    },
    region: context.regionLetter,
    currentTariffCode: currentTariffCode ?? 'unknown',
    tariffOverride: context.tariffOverride ?? false,
    flexColumnSource: context.flexColumnSource,
    postcodeArea: context.postcodeArea || 'not available',
    agreements: (context.agreements || []).map((a) => ({
      tariffCode: a.tariff_code,
      validFrom: a.valid_from,
      validTo: a.valid_to || null,
    })),
    readings: {
      count: detail.readings.length,
      earliest: gapInfo.earliest ? gapInfo.earliest.toISOString() : 'none',
      latest: gapInfo.latest ? gapInfo.latest.toISOString() : 'none',
      totalKwh: totalKwhDiag.toFixed(2),
      raw: detail.readings.map((r) => ({ t: r.start.toISOString(), kwh: r.kwh })),
    },
    gaps: {
      rangeCount: gapInfo.gaps.length,
      duplicateCount: gapInfo.duplicates.length,
      missingSlots: gapInfo.gaps.reduce(
        (s, g) => s + Math.round((g.end.getTime() - g.start.getTime()) / HALF_HOUR_MS) + 1,
        0,
      ),
      ranges: gapInfo.gaps.map(
        (g) => `${g.start.toISOString().slice(0, 16)} to ${g.end.toISOString().slice(0, 16)}`,
      ),
      medianProfileKwhEstimate: missingEstimate.totalKwh.toFixed(2),
      medianProfilePerGap: missingEstimate.perGap.map((g) => ({
        from: g.from.toISOString(),
        to: g.to.toISOString(),
        slots: g.slots,
        kwh: g.kwh,
      })),
    },
    products: {
      flexProductCode: context.products.flexProductCode || 'not found',
      flexTariffCode: context.products.flexTariffCode || 'not found',
      agileProductCode: agileAvailable
        ? context.products.agileProductCode || 'not found'
        : `skipped (${context.agileSkipReason ?? 'unknown'})`,
      agileTariffCode: agileAvailable ? context.products.agileTariffCode || 'not found' : 'skipped',
    },
    rateWindows: {
      flexUnitRates: rateWindowSummary(detail.flexUnitSorted, 'Flexible unit rates'),
      flexStandingCharges: rateWindowSummary(detail.flexStanding, 'Flexible standing charges'),
      agileUnitRates: agileAvailable
        ? rateWindowSummary(detail.agileUnitSorted, 'Agile unit rates')
        : 'Agile skipped',
      agileStandingCharges: agileAvailable
        ? rateWindowSummary(detail.agileStanding, 'Agile standing charges')
        : 'Agile skipped',
      rawFlexUnitRates: rawWindows(detail.flexUnitSorted),
      rawFlexStandingCharges: rawWindows(detail.flexStanding),
      rawAgileUnitRates: agileAvailable ? rawWindows(detail.agileUnitSorted) : [],
      rawAgileStandingCharges: agileAvailable ? rawWindows(detail.agileStanding) : [],
    },
    billingPeriods,
    statementsIncomplete: !!context.statementsIncomplete,
    ...(context.statementAttribution ? { statementAttribution: context.statementAttribution } : {}),
    statementValidation: context.statementValidation.map((v) => ({
      period: `${fmtDate(v.displayStart)} to ${fmtDate(v.displayEnd)}`,
      billedKwh: v.billedKwh != null ? v.billedKwh.toFixed(2) : 'n/a',
      observedKwh: v.observedKwh.toFixed(2),
      mismatch: !!v.mismatch,
      transactionsAvailable: v.transactionsAvailable,
      transactionsComplete: v.transactionsComplete,
      electricityChargePence:
        v.electricityChargePence != null ? v.electricityChargePence.toFixed(0) : 'n/a',
      creditsPence: (v.creditsPence || 0).toFixed(0),
      clamped: v.wasClamped,
      // Individual BillCharge line items — title, kWh, and sign of grossPence lets
      // us distinguish import (positive, customer pays) from export (negative,
      // Octopus pays customer) when both appear as 'Electricity' charges.
      charges: v.statementCharges.map((c) => ({
        title: c.title,
        kwh: c.kwh != null ? c.kwh.toFixed(2) : 'n/a',
        grossPence: c.grossPence.toFixed(0),
      })),
    })),
    totals: {
      allPeriods: {
        flexUnmatchedReadings: totalFlexUnmatched,
        agileUnmatchedReadings: totalAgileUnmatched,
        flexUnmatchedStandingDays: totalFlexStandingUnmatched,
        agileUnmatchedStandingDays: totalAgileStandingUnmatched,
        clampedPeriods,
      },
      consistentOnlyDiag: agileOnlyTotals,
    },
  };
}

export interface ExportCaptureOptions extends CaptureOptions {
  // Privacy-sensitive: raw half-hourly export slots reveal a household's
  // generation pattern, so they are included ONLY with explicit consent.
  includeDetailedExportSlots?: boolean;
}

// Build the export diagnostic from an ExportRun. Aggregate-only by default (no
// raw per-slot export timestamps). v2's export diag carried no appVersion; v3
// adds it (replay ignores export files, so this is compat-safe).
export function buildExportDiagnostics(
  run: ExportRun,
  opts: ExportCaptureOptions,
): ExportDiagnostics {
  const diag: ExportDiagnostics = {
    generatedAt: opts.generatedAt,
    appVersion: opts.appVersion ?? APP_VERSION,
    mode: 'export',
    region: run.regionLetter,
    comparisonWindow: { from: run.periodFrom.toISOString(), to: run.periodTo.toISOString() },
    exportKwh: run.exportKwh.toFixed(2),
    outgoingFlat: run.flat
      ? {
          products: run.flat.products,
          valuePence: run.flat.valuePence.toFixed(0),
          unmatchedReadings: run.flat.unmatchedReadings,
        }
      : 'unavailable',
    agileOutgoing: run.agile
      ? {
          products: run.agile.products,
          valuePence: run.agile.valuePence.toFixed(0),
          unmatchedReadings: run.agile.unmatchedReadings,
        }
      : 'unavailable',
    readings: {
      count: run.detail.readings.length,
      totalKwh: run.exportKwh.toFixed(2),
    },
  };
  if (opts.includeDetailedExportSlots) {
    diag.readings.raw = run.detail.readings.map((r) => ({ t: r.start.toISOString(), kwh: r.kwh }));
  }
  return diag;
}
