import { describe, expect, it } from 'vitest';
import { applyUserTariff } from '../../src/flows/applyUserTariff';
import type { CostResult, RateWindow, Reading } from '../../src/types/domain';
import type { ComparisonRun, PeriodComparison } from '../../src/types/result';

const start = new Date('2025-01-01T00:00:00Z');
const end = new Date('2025-01-02T00:00:00Z');

const cost = (kwh: number, total: number): CostResult => ({
  kwh,
  energyCostPence: total,
  standingChargePence: 0,
  totalPence: total,
  unmatchedReadings: 0,
  unmatchedStandingDays: 0,
});

const win = (value: number): RateWindow => ({
  validFrom: start,
  validTo: null,
  value,
});

const reading = (kwh: number): Reading => ({
  start,
  end: new Date(start.getTime() + 30 * 60 * 1000),
  kwh,
});

function period(overrides: Partial<PeriodComparison> = {}): PeriodComparison {
  return {
    displayStart: start,
    displayEnd: end,
    start,
    end,
    isSplit: false,
    actualChargePence: 1000,
    billedKwh: 2,
    creditsPence: 0,
    credits: [],
    transactionsAvailable: true,
    transactionsComplete: true,
    flex: cost(2, 200),
    agile: cost(2, 180),
    wasClamped: false,
    suspectActual: false,
    confident: true,
    tariffCodes: ['E-1R-VAR-22-11-01-A'],
    actualTariffCode: 'E-1R-VAR-22-11-01-A',
    ...overrides,
  };
}

function run(periods: PeriodComparison[]): ComparisonRun {
  const currentAgreement = {
    tariff_code: 'E-1R-VAR-22-11-01-A',
    valid_from: start.toISOString(),
    valid_to: null,
  };
  return {
    periods,
    detail: {
      readings: [reading(2)],
      flexUnitSorted: [win(10)],
      agileUnitSorted: [win(9)],
      flexStanding: [win(20)],
      agileStanding: [win(20)],
      agileAvailable: true,
      duplicateIntervals: new Set(),
    },
    context: {
      regionLetter: 'A',
      postcodeArea: 'AB',
      currentAgreement,
      agreements: [currentAgreement],
      flexColumnSource: {
        kind: 'flexible-current',
        label: 'Flexible',
        tariffCode: currentAgreement.tariff_code,
      },
      periodFrom: start,
      periodTo: end,
      agileAvailable: true,
      statementValidation: [],
      missingEstimate: { totalKwh: 0, slots: 0, perGap: [] },
      statementsIncomplete: false,
      gapInfo: { gaps: [], duplicates: [], earliest: null, latest: null },
      products: {
        flexProductCode: 'VAR-22-11-01',
        flexTariffCode: 'E-1R-VAR-22-11-01-A',
        agileProductCode: 'AGILE-24-10-01',
        agileTariffCode: 'E-1R-AGILE-24-10-01-A',
      },
    },
  };
}

describe('applyUserTariff', () => {
  it('replaces the flexible side and marks the run as a user tariff override', () => {
    const base = run([period()]);
    const agile = base.periods[0]?.agile;
    const updated = applyUserTariff(base, 25, 50);

    expect(updated.context.tariffOverride).toBe(true);
    expect(updated.context.currentAgreement?.tariff_code).toBe('User tariff');
    expect(updated.context.flexColumnSource).toEqual({
      kind: 'user-override',
      label: 'User tariff',
    });
    expect(updated.periods[0]?.actualTariffCode).toBe('User tariff');
    expect(updated.periods[0]?.tariffCodes).toEqual(['User tariff']);
    expect(updated.periods[0]?.flex.totalPence).toBe(100);
    expect(updated.periods[0]?.flex.kwh).toBe(2);
    expect(updated.periods[0]?.agile).toBe(agile);
    expect(updated.detail.readings).toBe(base.detail.readings);
  });

  it('does not make clamped or suspect periods confident after an override', () => {
    const updated = applyUserTariff(
      run([
        period({ wasClamped: true, confident: false }),
        period({ suspectActual: true, confident: false }),
      ]),
      25,
      50,
    );

    expect(updated.periods.map((p) => p.confident)).toEqual([false, false]);
  });
});
