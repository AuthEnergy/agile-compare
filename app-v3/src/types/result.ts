import type {
  Agreement,
  CostResult,
  DateRange,
  MissingEstimate,
  RateWindow,
  Reading,
} from './domain';
import type { StatementCredit } from './api';

// One displayed billing/month period with its costs and confidence. Drill-down
// `days` (Phase 4) is computed lazily and left undefined until expanded.
export interface PeriodComparison {
  displayStart: Date;
  displayEnd: Date;
  start: Date;
  end: Date;
  isSplit: boolean;
  actualChargePence: number | null;
  billedKwh: number | null;
  creditsPence: number;
  credits: StatementCredit[];
  transactionsAvailable: boolean;
  transactionsComplete: boolean;
  flex: CostResult;
  agile: CostResult | null;
  wasClamped: boolean;
  suspectActual: boolean;
  confident: boolean;
  tariffCodes: string[];
  actualTariffCode: string | null;
}

export interface StatementValidationEntry {
  displayStart: Date;
  displayEnd: Date;
  billedKwh: number | null;
  observedKwh: number;
  electricityChargePence: number | null;
  creditsPence: number;
  credits: StatementCredit[];
  transactionsAvailable: boolean;
  transactionsComplete: boolean;
  wasClamped: boolean;
  mismatch: boolean;
}

// The raw inputs kept in memory so the drill-down can recompute day/slot detail
// on expand without re-fetching.
export interface RunDetail {
  readings: Reading[];
  flexUnitSorted: RateWindow[];
  agileUnitSorted: RateWindow[];
  flexStanding: RateWindow[];
  agileStanding: RateWindow[];
  agileAvailable: boolean;
  duplicateIntervals: Set<number>;
}

export interface RunContext {
  regionLetter: string;
  postcodeArea: string | null;
  currentAgreement: Agreement | null;
  agreements: Agreement[];
  periodFrom: Date;
  periodTo: Date;
  agileAvailable: boolean;
  statementValidation: StatementValidationEntry[];
  missingEstimate: MissingEstimate;
  statementsIncomplete: boolean;
  // Honest "your bills end here" signal: the end of the most recent statement in
  // the window, and whether usage readings extend past it. When true, the recent
  // months get a Flexible/Agile estimate but no "actual paid" (no bill covers them).
  latestStatementEnd?: Date | null;
  readingsBeyondStatements?: boolean;
  // Why the Agile comparison was dropped (status only, no response body), for
  // diagnostics — null when Agile is available.
  agileSkipReason?: string | null;
  gapInfo: { gaps: DateRange[]; duplicates: Date[]; earliest: Date | null; latest: Date | null };
  products: {
    flexProductCode: string;
    flexTariffCode: string;
    agileProductCode: string;
    agileTariffCode: string;
  };
}

export interface ComparisonRun {
  periods: PeriodComparison[];
  detail: RunDetail;
  context: RunContext;
}

// Export ("Outgoing") comparison: income per kWh exported, NO standing charge —
// a deliberately separate model from the import ComparisonRun.
export interface ExportTariffValue {
  valuePence: number;
  unmatchedReadings: number;
  products: string[];
}

export interface ExportRun {
  regionLetter: string;
  postcodeArea: string | null;
  currentAgreement: Agreement | null;
  agreements: Agreement[];
  periodFrom: Date;
  periodTo: Date;
  exportKwh: number;
  flat: ExportTariffValue | null;
  agile: ExportTariffValue | null;
  gapInfo: { gaps: DateRange[]; duplicates: Date[]; earliest: Date | null; latest: Date | null };
  detail: {
    readings: Reading[];
    flatWindows: RateWindow[];
    agileWindows: RateWindow[];
    duplicateIntervals: Set<number>;
  };
}

// Progress callback so flows stay DOM-free; the UI subscribes.
export type ProgressFn = (message: string, status?: 'active' | 'ok' | 'err', pct?: number) => void;
