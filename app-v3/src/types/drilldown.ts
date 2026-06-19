// Lazy drill-down model: a month period expands to UTC days, a day to 48 UTC
// half-hour slots. These are a *view* of the headline aggregate — never a second
// source of truth — so Σ days === period and Σ slots === day must hold (tested).

export interface SlotFlags {
  // No reading for this in-period slot — priced as a gap, not zero.
  missingReading: boolean;
  // interval_start seen more than once across serials (collapsed to one reading).
  duplicate: boolean;
  // A reading exists but no Flexible/Agile unit rate covered the slot.
  flexUnmatched: boolean;
  agileUnmatched: boolean;
  // Slot lies outside the (clamped) billing period — shown, never priced.
  outOfPeriod: boolean;
}

export interface SlotCalculation {
  intervalStart: Date;
  intervalEnd: Date;
  kwh: number | null;
  flexRate: number | null; // p/kWh
  agileRate: number | null;
  flexCostPence: number | null;
  agileCostPence: number | null;
  flags: SlotFlags;
}

export interface DayStanding {
  flex: number;
  agile: number | null;
}

export interface DayUnmatched {
  flexReadings: number;
  agileReadings: number;
  flexStandingDays: number;
  agileStandingDays: number;
}

export interface DayFlags {
  hasUnmatched: boolean;
  // Day partly outside the clamped period (first/last day of a clamped window).
  partial: boolean;
}

export interface DayComparison {
  date: Date; // UTC midnight of the settlement day
  kwh: number;
  flexEnergyPence: number;
  agileEnergyPence: number | null;
  standingPence: DayStanding;
  flexTotalPence: number;
  agileTotalPence: number | null;
  flags: DayFlags;
  unmatched: DayUnmatched;
}

export interface PeriodWindow {
  start: Date;
  end: Date;
}
