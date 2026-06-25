// Types for the solar "what-if" module (Phase A — solar only). Battery is a
// separate, later phase and deliberately not modelled here, so Phase A compiles
// and ships without any battery code.

export interface SolarConfig {
  arrayKwp: number; // installed DC capacity (kWp)
  tiltDeg: number; // panel tilt from horizontal (0 = flat, 90 = vertical)
  azimuthDegFromSouth: number; // 0 = due south, + = west, − = east
  systemLossFactor: number; // single 0..1 derate (the only PV derate)
  inverterAcKw?: number; // optional AC clip; undefined = uncapped
}

export const DEFAULT_SOLAR_CONFIG: SolarConfig = {
  arrayKwp: 4.0,
  tiltDeg: 35,
  azimuthDegFromSouth: 0,
  systemLossFactor: 0.8,
};

// Inclusive clamp ranges for user input (rejects NaN/negative; keeps the model
// inside the range the climatology + transposition stay sane over).
export const SOLAR_LIMITS = {
  arrayKwp: { min: 0.1, max: 30 },
  tiltDeg: { min: 0, max: 90 },
  azimuthDegFromSouth: { min: -180, max: 180 },
  systemLossFactor: { min: 0.5, max: 0.95 },
  inverterAcKw: { min: 0.5, max: 30 },
} as const;

export type ZoneResolvedBy = 'postcode-area' | 'dno-region' | 'default';
export type SolarTariffBasis = 'flexible' | 'agile';

export interface SolarGenerationSummary {
  modelledKwh: number; // full modelled total over the scope skeleton
  valuedKwh: number; // generation on slots with a real load reading AND an import rate
  coverage: number; // valuedKwh / modelledKwh, 0..1
  selfConsumedKwh: number; // valued slots only
  exportKwh: number; // valued slots only (surplus)
}

export interface SolarExportBasis {
  kind: 'agile-outgoing' | 'flat-outgoing' | 'seg-assumed';
  label: string;
  exportValuePence: number; // value of exported surplus under this export source
  totalPence: number; // importSavingPence + exportValuePence (the solar benefit)
}

export interface SolarMonthRow {
  key: string; // 'YYYY-MM'
  label: string; // 'Mar 2025'
  generatedKwh: number;
  selfConsumedKwh: number;
  exportKwh: number;
}

export interface SolarResult {
  config: SolarConfig;
  zoneId: string;
  zoneLabel: string;
  zoneResolvedBy: ZoneResolvedBy;
  tariffBasis: SolarTariffBasis;
  tariffBasisLabel: string; // 'Flexible' | 'Agile' (per-slot import price the saving is measured against)
  generation: SolarGenerationSummary;
  importSavingPence: number; // avoided import (self-consumption) on the chosen basis
  bases: SolarExportBasis[]; // one per export source priced (Agile Outgoing, Outgoing, or assumed SEG)
  segRatePence: number; // the flat SEG used when no Octopus export rate is available
  usedAssumedSeg: boolean;
  perMonth: SolarMonthRow[];
  windowDays: number;
  shortWindow: boolean; // scope shorter than ~28 days — seasonal-bias warning
  solarDataVersion: string;
  // Where the radiation data came from — shown on screen and attributable (e.g. the
  // OGL citation when sourced from MIDAS Open). Driven by SOLAR_DATA_PROVENANCE.
  provenance: { version: string; license: string; citation: string };
}

export interface SolarRun {
  result: SolarResult;
  caveats: string[];
}
