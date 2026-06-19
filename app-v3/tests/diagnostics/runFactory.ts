import type { CostResult, RateWindow } from '../../src/types/domain';
import type { ComparisonRun, ExportRun, PeriodComparison } from '../../src/types/result';

export const CURRENT_TARIFF = 'E-1R-VAR-22-11-01-A'; // classifies as Flexible
const OLD_TARIFF = 'E-1R-OLD-A';

const win = (fromISO: string, p: number): RateWindow => ({
  validFrom: new Date(fromISO),
  validTo: null,
  value: p,
});

const cost = (
  kwh: number,
  energy: number,
  standing: number,
  unmatched = 0,
  unmatchedStanding = 0,
): CostResult => ({
  kwh,
  energyCostPence: energy,
  standingChargePence: standing,
  totalPence: energy + standing,
  unmatchedReadings: unmatched,
  unmatchedStandingDays: unmatchedStanding,
});

export interface PeriodSpec {
  start: string;
  end: string;
  // Tariff attribution: 'current' (in the consistent subset), 'old' (pre-switch),
  // or 'mixed' (straddles a switch — excluded).
  tariff?: 'current' | 'old' | 'mixed';
  confident?: boolean;
  actual?: number | null;
  flexEnergy: number;
  flexStanding: number;
  agileEnergy?: number | null;
  agileStanding?: number;
  kwh?: number;
}

function mkPeriod(spec: PeriodSpec): PeriodComparison {
  const start = new Date(spec.start);
  const end = new Date(spec.end);
  const tariff = spec.tariff ?? 'current';
  const kwh = spec.kwh ?? 300;
  const agile =
    spec.agileEnergy === null || spec.agileEnergy === undefined
      ? null
      : cost(kwh, spec.agileEnergy, spec.agileStanding ?? 0);
  const tariffCodes =
    tariff === 'current'
      ? [CURRENT_TARIFF]
      : tariff === 'old'
        ? [OLD_TARIFF]
        : [OLD_TARIFF, CURRENT_TARIFF];
  return {
    displayStart: start,
    displayEnd: end,
    start,
    end,
    isSplit: false,
    actualChargePence: spec.actual ?? null,
    billedKwh: null,
    creditsPence: 0,
    credits: [],
    transactionsAvailable: true,
    transactionsComplete: true,
    flex: cost(kwh, spec.flexEnergy, spec.flexStanding),
    agile,
    wasClamped: false,
    suspectActual: false,
    confident: spec.confident ?? true,
    tariffCodes,
    actualTariffCode: tariff === 'current' ? CURRENT_TARIFF : OLD_TARIFF,
  };
}

export function makeRun(specs: PeriodSpec[]): ComparisonRun {
  const periods = specs.map(mkPeriod);
  const agreements = [
    { tariff_code: CURRENT_TARIFF, valid_from: '2024-01-01T00:00:00.000Z', valid_to: null },
  ];
  return {
    periods,
    detail: {
      readings: [
        {
          start: new Date('2025-01-01T00:00:00Z'),
          end: new Date('2025-01-01T00:30:00Z'),
          kwh: 0.5,
        },
        {
          start: new Date('2025-01-01T00:30:00Z'),
          end: new Date('2025-01-01T01:00:00Z'),
          kwh: 0.4,
        },
      ],
      flexUnitSorted: [win('2024-01-01T00:00:00Z', 24.5)],
      agileUnitSorted: [win('2024-01-01T00:00:00Z', 18.2)],
      flexStanding: [win('2024-01-01T00:00:00Z', 50)],
      agileStanding: [win('2024-01-01T00:00:00Z', 50)],
      agileAvailable: true,
      duplicateIntervals: new Set<number>(),
    },
    context: {
      regionLetter: 'A',
      postcodeArea: 'AB',
      currentAgreement: agreements[0] ?? null,
      agreements,
      periodFrom: new Date('2024-12-01T00:00:00Z'),
      periodTo: new Date('2025-03-01T00:00:00Z'),
      agileAvailable: true,
      statementValidation: [],
      missingEstimate: { totalKwh: 0, slots: 0, perGap: [] },
      statementsIncomplete: false,
      gapInfo: { gaps: [], duplicates: [], earliest: null, latest: null },
      products: {
        flexProductCode: 'VAR-22-11-01',
        flexTariffCode: CURRENT_TARIFF,
        agileProductCode: 'AGILE-24-10-01',
        agileTariffCode: 'E-1R-AGILE-24-10-01-A',
      },
    },
  };
}

export function makeExportRun(opts: { detailedSlots?: boolean } = {}): ExportRun {
  void opts;
  return {
    regionLetter: 'A',
    postcodeArea: 'AB',
    currentAgreement: null,
    agreements: [],
    periodFrom: new Date('2024-06-01T00:00:00Z'),
    periodTo: new Date('2025-06-01T00:00:00Z'),
    exportKwh: 1234.5,
    flat: { valuePence: 6789, unmatchedReadings: 0, products: ['OUTGOING-FIX-12M'] },
    agile: { valuePence: 7200, unmatchedReadings: 0, products: ['AGILE-OUTGOING-19-05-13'] },
    gapInfo: { gaps: [], duplicates: [], earliest: null, latest: null },
    detail: {
      readings: [
        {
          start: new Date('2025-05-01T11:00:00Z'),
          end: new Date('2025-05-01T11:30:00Z'),
          kwh: 0.9,
        },
        {
          start: new Date('2025-05-01T11:30:00Z'),
          end: new Date('2025-05-01T12:00:00Z'),
          kwh: 1.1,
        },
      ],
      flatWindows: [win('2024-01-01T00:00:00Z', 15)],
      agileWindows: [win('2024-01-01T00:00:00Z', 16)],
      duplicateIntervals: new Set<number>(),
    },
  };
}
