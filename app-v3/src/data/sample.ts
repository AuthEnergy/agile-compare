import { calculateCost } from '../domain/cost';
import type { RateWindow, Reading } from '../types/domain';
import type { ComparisonRun, PeriodComparison } from '../types/result';

// A synthetic but faithful sample household — entirely fake data, no secrets.
// Built the same way a real run is (readings + rate windows priced via
// calculateCost), so the headline, drill-down invariants and Stage-2 signals all
// behave exactly as on live data. Used by "Use a sample household".

const HALF_HOUR_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 1, 1); // 1 Feb 2026
const DAYS = 120;
const CUR = 'E-1R-VAR-22-11-01-C';
const OLD = 'E-1R-FIX-12M-22-01-01-C';

// Deterministic (no Math.random — keeps the committed build reproducible).
function dailyUsageKwh(slot: number): number {
  const h = slot / 2;
  let kwh = 0.09 + 0.04 * Math.sin(slot / 3);
  if (h >= 17 && h <= 20) kwh += 0.34;
  if (h >= 6 && h <= 8) kwh += 0.12;
  kwh += ((slot * 7) % 5) * 0.004;
  return Math.round(kwh * 100) / 100;
}

function agilePrice(slot: number): number {
  const h = slot / 2;
  let p = 14 + 6 * Math.sin((slot - 9) / 4.5);
  if (h >= 16 && h <= 19) p = 30 + (h - 16) * 2.5;
  if (h <= 4) p = 8.5 + ((slot * 3) % 4) * 0.4;
  return Math.round(p * 100) / 100;
}

function buildData(): {
  readings: Reading[];
  agileUnit: RateWindow[];
} {
  const readings: Reading[] = [];
  const agileUnit: RateWindow[] = [];
  for (let d = 0; d < DAYS; d++) {
    for (let i = 0; i < 48; i++) {
      const t = START + (d * 48 + i) * HALF_HOUR_MS;
      const start = new Date(t);
      readings.push({ start, end: new Date(t + HALF_HOUR_MS), kwh: dailyUsageKwh(i) });
      agileUnit.push({
        validFrom: start,
        validTo: new Date(t + HALF_HOUR_MS),
        value: agilePrice(i),
      });
    }
  }
  return { readings, agileUnit };
}

interface PeriodSpec {
  startDay: number;
  endDay: number;
  tariff: string;
  clamped: boolean;
}

export function buildSampleRun(): ComparisonRun {
  const { readings, agileUnit } = buildData();
  const flexUnit: RateWindow[] = [{ validFrom: new Date(START), validTo: null, value: 24.5 }];
  const flexStanding: RateWindow[] = [{ validFrom: new Date(START), validTo: null, value: 45 }];
  const agileStanding: RateWindow[] = [{ validFrom: new Date(START), validTo: null, value: 40 }];

  const specs: PeriodSpec[] = [
    { startDay: 0, endDay: 30, tariff: OLD, clamped: false }, // pre-switch
    { startDay: 30, endDay: 60, tariff: CUR, clamped: false }, // complete
    { startDay: 60, endDay: 90, tariff: CUR, clamped: false }, // complete
    { startDay: 90, endDay: 120, tariff: CUR, clamped: true }, // partial (statement open)
  ];

  const periods: PeriodComparison[] = specs.map((s) => {
    const start = new Date(START + s.startDay * DAY_MS);
    const end = new Date(START + s.endDay * DAY_MS);
    const displayEnd = s.clamped ? new Date(end.getTime() + 5 * DAY_MS) : end;
    const flex = calculateCost(readings, start, end, flexUnit, flexStanding, true);
    const agile = calculateCost(readings, start, end, agileUnit, agileStanding, true);
    const wasClamped = s.clamped;
    return {
      displayStart: start,
      displayEnd,
      start,
      end,
      isSplit: false,
      actualChargePence: Math.round(flex.totalPence),
      billedKwh: Math.round(flex.kwh),
      creditsPence: 0,
      credits: [],
      transactionsAvailable: true,
      transactionsComplete: true,
      flex,
      agile,
      wasClamped,
      suspectActual: false,
      confident: !wasClamped,
      tariffCodes: [s.tariff],
      actualTariffCode: s.tariff,
    };
  });

  const lastReading = readings[readings.length - 1];
  return {
    periods,
    detail: {
      readings,
      flexUnitSorted: flexUnit,
      agileUnitSorted: agileUnit,
      flexStanding,
      agileStanding,
      agileAvailable: true,
      duplicateIntervals: new Set<number>(),
    },
    context: {
      regionLetter: 'C',
      postcodeArea: 'BS1',
      currentAgreement: { tariff_code: CUR, valid_from: '2026-03-01', valid_to: null },
      agreements: [
        { tariff_code: OLD, valid_from: '2025-01-01', valid_to: '2026-03-01' },
        { tariff_code: CUR, valid_from: '2026-03-01', valid_to: null },
      ],
      periodFrom: new Date(START),
      periodTo: new Date(START + DAYS * DAY_MS),
      agileAvailable: true,
      statementValidation: [],
      missingEstimate: { totalKwh: 0, slots: 0, perGap: [] },
      statementsIncomplete: false,
      gapInfo: {
        gaps: [],
        duplicates: [],
        earliest: readings[0]?.start ?? new Date(START),
        latest: lastReading?.start ?? new Date(START),
      },
      products: {
        flexProductCode: 'VAR-22-11-01',
        flexTariffCode: CUR,
        agileProductCode: 'AGILE-24-10-01',
        agileTariffCode: 'E-1R-AGILE-24-10-01-C',
      },
    },
  };
}
