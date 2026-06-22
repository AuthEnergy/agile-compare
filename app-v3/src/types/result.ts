import type {
  Agreement,
  CostResult,
  DateRange,
  MissingEstimate,
  RateWindow,
  Reading,
} from './domain';
import type { StatementCharge, StatementCredit } from './api';

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
  // Individual electricity BillCharge line items (title + kWh) from the statement.
  // Captured so we can detect import-vs-export split accounts where the statement
  // sums both meters into billedKwh (making it appear inflated vs the import-only
  // half-hourly readings). Empty for synthetic/unbilled periods.
  statementCharges: StatementCharge[];
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

export type FlexColumnSource =
  | { kind: 'flexible-current'; label: string; tariffCode: string | null }
  | { kind: 'flexible-alternative'; label: 'Flexible' }
  | {
      kind: 'current-tariff-rates';
      label: string;
      tariffCode: string;
      rateShape: 'flat' | 'time-of-use';
    }
  | {
      kind: 'flexible-proxy';
      label: 'Flexible proxy';
      actualTariffLabel: string;
      actualTariffCode: string;
      reason: string;
    }
  | { kind: 'user-override'; label: 'User tariff' };

export interface RunContext {
  regionLetter: string;
  postcodeArea: string | null;
  currentAgreement: Agreement | null;
  agreements: Agreement[];
  tariffOverride?: boolean;
  flexColumnSource: FlexColumnSource;
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
  // Set when the user's actual tariff rates could not be fetched and Flexible is
  // used as the flex column proxy instead. Shown as a caveat in the results.
  flexNote?: string | null;
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
