// Core domain types shared across pricing, gaps, tariff and statement logic.
// Ported 1:1 from the shapes the v2 single-file app used at runtime.

export interface RateWindow {
  validFrom: Date;
  validTo: Date | null;
  value: number;
}

export interface Reading {
  start: Date;
  end?: Date;
  kwh: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface CostResult {
  kwh: number;
  energyCostPence: number;
  standingChargePence: number;
  totalPence: number;
  unmatchedReadings: number;
  unmatchedStandingDays: number;
}

export interface ExportValue {
  kwh: number;
  valuePence: number;
  unmatchedReadings: number;
}

export interface GapInfo {
  gaps: DateRange[];
  duplicates: Date[];
  earliest: Date | null;
  latest: Date | null;
}

export interface PerGapEstimate {
  from: Date;
  to: Date;
  slots: number;
  kwh: number;
}

export interface MissingEstimate {
  totalKwh: number;
  slots: number;
  perGap: PerGapEstimate[];
}

export interface Agreement {
  tariff_code: string;
  valid_from: string;
  valid_to: string | null;
}

export type TariffKind =
  | 'export'
  | 'agile'
  | 'tracker'
  | 'cosy'
  | 'go'
  | 'fixed'
  | 'flexible'
  | 'other'
  | 'unknown';

export interface TariffClass {
  kind: TariffKind;
  label: string;
}

// A billing period as splitLongPeriods sees it. The index signature lets the
// non-split path spread the caller's richer period object through unchanged,
// matching v2 (split sub-periods deliberately carry only the fields below).
export interface RawPeriod {
  displayStart: Date;
  displayEnd: Date;
  start: Date;
  end: Date;
  actualChargePence: number | null;
  [key: string]: unknown;
}

export type SplitPeriod = RawPeriod & { isSplit: boolean };
