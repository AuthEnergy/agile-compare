// Serialised diagnostics shapes — the on-disk JSON contract.
//
// These mirror, key-for-key, what v2 wrote into `state.diagnostics` /
// `state.failureDiag` so a file produced by hardened l-wip v2 still replays in
// v3 (backward compatibility), with ONE deliberate change: the account number is
// omitted by default (policy-controlled) from BOTH the success and the failure
// bundle. Numeric fields are stored as fixed-precision STRINGS exactly as v2
// did (e.g. pence via `.toFixed(0)`, kWh via `.toFixed(2)`), or the literal
// "n/a" / "skipped" sentinels — replay parses them back.
import type { FlexColumnSource } from './result';

export interface DiagAgreement {
  tariffCode: string;
  validFrom: string;
  validTo: string | null;
}

export interface DiagRawReading {
  t: string; // ISO interval start
  kwh: number;
}

export interface DiagRawWindow {
  from: string; // ISO
  to: string | null; // ISO or null (open-ended)
  p: number; // value in pence
}

export interface DiagPerGap {
  from: string;
  to: string;
  slots: number;
  kwh: number;
}

// One period as the diagnostic records it. Pence/kWh are fixed-precision
// strings; "n/a" appears where a value was unavailable (e.g. Agile skipped).
export interface DiagBillingPeriod {
  displayPeriod: string; // "YYYY-MM-DD to YYYY-MM-DD"
  calculationPeriod: string;
  actualTariffCode: string;
  preSwitch: boolean;
  mixedTariff: boolean;
  clamped: boolean;
  confident: boolean;
  kwh: string;
  actualPence: string; // integer pence or "n/a"
  suspectActual: boolean;
  flexEnergyPence: string;
  flexStandingPence: string;
  flexTotalPence: string;
  flexUnmatched: number;
  flexUnmatchedStanding: number;
  agileEnergyPence: string; // or "n/a"
  agileStandingPence: string; // or "n/a"
  agileTotalPence: string; // or "n/a"
  agileUnmatched: number | string; // or "n/a"
  agileUnmatchedStanding: number | string; // or "n/a"
}

export interface DiagStatementValidation {
  period: string;
  billedKwh: string; // or "n/a"
  observedKwh: string;
  mismatch: boolean;
  transactionsAvailable: boolean;
  transactionsComplete: boolean;
  electricityChargePence: string; // or "n/a"
  creditsPence: string;
  clamped: boolean;
}

export interface DiagConsistentTotals {
  periodCount: number;
  actualPence: number;
  flexTotalPence: number;
  agileTotalPence: number;
}

export interface ImportDiagnostics {
  generatedAt: string;
  appVersion: string;
  comparisonWindow: { from: string; to: string };
  region: string;
  currentTariffCode: string;
  tariffOverride?: boolean;
  flexColumnSource?: FlexColumnSource;
  postcodeArea: string;
  agreements: DiagAgreement[];
  readings: {
    count: number;
    earliest: string;
    latest: string;
    totalKwh: string;
    raw: DiagRawReading[];
  };
  gaps: {
    rangeCount: number;
    duplicateCount: number;
    missingSlots: number;
    ranges: string[];
    medianProfileKwhEstimate: string;
    medianProfilePerGap: DiagPerGap[];
  };
  products: {
    flexProductCode: string;
    flexTariffCode: string;
    agileProductCode: string;
    agileTariffCode: string;
  };
  rateWindows: {
    flexUnitRates: string;
    flexStandingCharges: string;
    agileUnitRates: string;
    agileStandingCharges: string;
    rawFlexUnitRates: DiagRawWindow[];
    rawFlexStandingCharges: DiagRawWindow[];
    rawAgileUnitRates: DiagRawWindow[];
    rawAgileStandingCharges: DiagRawWindow[];
  };
  billingPeriods: DiagBillingPeriod[];
  statementsIncomplete: boolean;
  statementAttribution?: {
    mode: 'safe-statements' | 'estimate-only-unsafe-multi-mpan';
    accountsWithMeter: number;
    accountsUsedForStatements: number;
    unsafeAccountsWithMeter: number;
  };
  statementValidation: DiagStatementValidation[];
  totals: {
    allPeriods: {
      flexUnmatchedReadings: number;
      agileUnmatchedReadings: number;
      flexUnmatchedStandingDays: number;
      agileUnmatchedStandingDays: number;
      clampedPeriods: number;
    };
    consistentOnlyDiag: DiagConsistentTotals;
  };
}

// Export diagnostic. Aggregate-only by default — half-hourly export timestamps
// reveal a household's solar/generation pattern, so `readings.raw` is present
// ONLY when the user gave explicit "include detailed export slots" consent.
export interface ExportDiagTariff {
  products: string[];
  valuePence: string; // integer pence
  unmatchedReadings: number;
}

export interface ExportDiagnostics {
  generatedAt: string;
  appVersion: string;
  mode: 'export';
  region: string;
  comparisonWindow: { from: string; to: string };
  exportKwh: string;
  outgoingFlat: ExportDiagTariff | 'unavailable';
  agileOutgoing: ExportDiagTariff | 'unavailable';
  readings: {
    count: number;
    totalKwh: string;
    raw?: DiagRawReading[]; // present only with explicit consent
  };
}

// Failure diagnostic — everything known at the point of failure. PII-light: NO
// MPAN, meter serial, or address; the account number is omitted by default
// (policy-controlled) and `message`/`progressLog` are run through redactPII.
export interface FailureDiagnostics {
  generatedAt: string;
  appVersion: string;
  error: {
    message: string | null | undefined;
    type: string;
    status: number | null;
    corsLikely: boolean;
  };
  account: {
    number: string | null; // null unless an explicit debug policy keeps it
    serialCount: number;
    isExport: boolean;
    postcodeArea: string | null;
    agreements: DiagAgreement[];
    metersOnAccount: {
      serialCount: number;
      isExport: boolean;
      currentTariff: string | null;
    }[];
  };
  progressLog: (string | null | undefined)[];
}

export type AnyDiagnostics = ImportDiagnostics | ExportDiagnostics | FailureDiagnostics;

// Policy controlling what a bundle is allowed to include. Both flags default to
// the privacy-preserving choice (false).
export interface BundlePolicy {
  // Keep the account number in the failure bundle (a debug-only escape hatch).
  includeAccountNumber?: boolean;
  // Include raw half-hourly export slots in the export bundle (reveals the
  // household generation pattern — privacy-sensitive consent).
  includeDetailedExportSlots?: boolean;
}

export interface DiagnosticsBundle {
  filename: string;
  mimeType: 'application/json';
  content: string;
  byteLength: number;
}
