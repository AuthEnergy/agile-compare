import { describe, expect, it } from 'vitest';
import { applyTariffComparison } from '../../src/flows/applyTariffComparison';
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

const win = (value: number): RateWindow => ({ validFrom: start, validTo: null, value });

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

describe('applyTariffComparison', () => {
  it('returns the run unchanged when both columns are null', () => {
    const base = run([period()]);
    expect(applyTariffComparison(base, null, null)).toBe(base);
  });

  it('replaces only the flex column when agileColumn is null', () => {
    const base = run([period()]);
    const originalAgile = base.periods[0]?.agile;
    const updated = applyTariffComparison(
      base,
      { unitWindows: [win(25)], standingWindows: [win(50)], label: 'Fixed Rate' },
      null,
    );

    expect(updated.context.tariffOverride).toBe(true);
    expect(updated.context.flexColumnSource).toEqual({
      kind: 'user-override',
      label: 'Fixed Rate',
    });
    expect(updated.context.currentAgreement?.tariff_code).toBe('Fixed Rate');
    expect(updated.context.agileColumnLabel).toBeUndefined();
    expect(updated.periods[0]?.actualTariffCode).toBe('Fixed Rate');
    expect(updated.periods[0]?.agile).toBe(originalAgile);
    expect(updated.detail.flexUnitSorted[0]?.value).toBe(25);
  });

  it('replaces only the agile column when flexColumn is null', () => {
    const base = run([period()]);
    const originalFlex = base.periods[0]?.flex;
    const updated = applyTariffComparison(base, null, {
      unitWindows: [win(30)],
      standingWindows: [win(55)],
      label: 'Cosy Octopus',
    });

    expect(updated.context.tariffOverride).toBe(true);
    expect(updated.context.agileColumnLabel).toBe('Cosy Octopus');
    expect(updated.context.flexColumnSource.kind).toBe('flexible-current'); // unchanged
    expect(updated.periods[0]?.flex).toBe(originalFlex);
    expect(updated.detail.agileUnitSorted[0]?.value).toBe(30);
  });

  it('replaces both columns simultaneously', () => {
    const base = run([period()]);
    const updated = applyTariffComparison(
      base,
      { unitWindows: [win(25)], standingWindows: [win(50)], label: 'Fixed Rate' },
      { unitWindows: [win(30)], standingWindows: [win(55)], label: 'Cosy Octopus' },
    );

    expect(updated.context.flexColumnSource).toEqual({
      kind: 'user-override',
      label: 'Fixed Rate',
    });
    expect(updated.context.agileColumnLabel).toBe('Cosy Octopus');
    expect(updated.periods[0]?.actualTariffCode).toBe('Fixed Rate');
  });

  it('does not make clamped or suspect periods confident', () => {
    const updated = applyTariffComparison(
      run([
        period({ wasClamped: true, confident: false }),
        period({ suspectActual: true, confident: false }),
      ]),
      { unitWindows: [win(25)], standingWindows: [win(50)], label: 'Fixed Rate' },
      null,
    );

    expect(updated.periods.map((p) => p.confident)).toEqual([false, false]);
  });

  it('sets agileAvailable true when an agile column is provided', () => {
    const base = run([period()]);
    const noAgile = { ...base, context: { ...base.context, agileAvailable: false } };
    const updated = applyTariffComparison(noAgile, null, {
      unitWindows: [win(30)],
      standingWindows: [win(55)],
      label: 'Go Octopus',
    });

    expect(updated.context.agileAvailable).toBe(true);
    expect(updated.detail.agileAvailable).toBe(true);
  });
});
