import { describe, it, expect } from 'vitest';
import { computeHeadline } from '../../src/domain/headline';
import type { CostResult } from '../../src/types/domain';
import type {
  ComparisonRun,
  PeriodComparison,
  StatementValidationEntry,
} from '../../src/types/result';

const cost = (kwh: number, total: number): CostResult => ({
  kwh,
  energyCostPence: total,
  standingChargePence: 0,
  totalPence: total,
  unmatchedReadings: 0,
  unmatchedStandingDays: 0,
});

const FLEXIBLE = 'E-1R-VAR-22-11-01-A';
const AGILE = 'E-1R-AGILE-24-10-01-A';
const FIXED = 'E-1R-FIX-12M-23-A';

function mkPeriod(p: {
  start: string;
  end: string;
  tariffCodes?: string[];
  confident?: boolean;
  actual?: number | null;
  flexTotal?: number;
  agileTotal?: number | null;
}): PeriodComparison {
  const start = new Date(p.start);
  const end = new Date(p.end);
  const codes = p.tariffCodes ?? ['E-1R-CUR-A'];
  return {
    displayStart: start,
    displayEnd: end,
    start,
    end,
    isSplit: false,
    actualChargePence: p.actual ?? null,
    billedKwh: null,
    creditsPence: 0,
    credits: [],
    transactionsAvailable: true,
    transactionsComplete: true,
    flex: cost(100, p.flexTotal ?? 2135),
    agile: p.agileTotal === null ? null : cost(100, p.agileTotal ?? 1950),
    wasClamped: false,
    suspectActual: false,
    confident: p.confident ?? true,
    tariffCodes: codes,
    actualTariffCode: codes[0] ?? null,
  };
}

function mkRun(
  periods: PeriodComparison[],
  opts: {
    statementValidation?: StatementValidationEntry[];
    agileAvailable?: boolean;
    statementsIncomplete?: boolean;
  } = {},
): ComparisonRun {
  const agreements = [{ tariff_code: 'E-1R-CUR-A', valid_from: '2025-01-01', valid_to: null }];
  const agileAvailable = opts.agileAvailable ?? true;
  return {
    periods,
    detail: {
      readings: [],
      flexUnitSorted: [],
      agileUnitSorted: [],
      flexStanding: [],
      agileStanding: [],
      agileAvailable,
      duplicateIntervals: new Set(),
    },
    context: {
      regionLetter: 'A',
      postcodeArea: 'AB',
      currentAgreement: agreements[0] ?? null,
      agreements,
      periodFrom: new Date('2025-01-01'),
      periodTo: new Date('2025-12-31'),
      agileAvailable,
      statementValidation: opts.statementValidation ?? [],
      missingEstimate: { totalKwh: 0, slots: 0, perGap: [] },
      statementsIncomplete: opts.statementsIncomplete ?? false,
      gapInfo: { gaps: [], duplicates: [], earliest: null, latest: null },
      products: {
        flexProductCode: '',
        flexTariffCode: '',
        agileProductCode: '',
        agileTariffCode: '',
      },
    },
  };
}

function mkCurrentTariffRun(tariffCode: string, tariffOverride = false): ComparisonRun {
  const run = mkRun([
    mkPeriod({
      start: '2025-04-01',
      end: '2025-05-01',
      actual: 5000,
      tariffCodes: [tariffCode],
    }),
  ]);
  const currentAgreement = {
    tariff_code: tariffCode,
    valid_from: '2025-01-01T00:00:00.000Z',
    valid_to: null,
  };
  run.context.currentAgreement = currentAgreement;
  run.context.agreements = [currentAgreement];
  if (tariffOverride) run.context.tariffOverride = true;
  return run;
}

const sv = (
  start: string,
  end: string,
  mismatch: boolean,
  billedKwh: number,
  observedKwh: number,
): StatementValidationEntry => ({
  displayStart: new Date(start),
  displayEnd: new Date(end),
  billedKwh,
  observedKwh,
  electricityChargePence: 5000,
  creditsPence: 0,
  credits: [],
  transactionsAvailable: true,
  transactionsComplete: true,
  wasClamped: false,
  mismatch,
  statementCharges: [],
});

describe('computeHeadline', () => {
  it('labels the fixed drill-down columns for flexible, agile, override and other tariffs', () => {
    expect(computeHeadline(mkCurrentTariffRun(FLEXIBLE)).columns).toEqual({
      flexLabel: 'Flexible',
      agileLabel: 'Agile',
      yoursColumn: 'flex',
    });
    expect(computeHeadline(mkCurrentTariffRun(AGILE)).columns).toEqual({
      flexLabel: 'Flexible',
      agileLabel: 'Agile',
      yoursColumn: 'agile',
    });
    expect(computeHeadline(mkCurrentTariffRun('User tariff', true)).columns).toEqual({
      flexLabel: 'User tariff',
      agileLabel: 'Agile',
      yoursColumn: 'flex',
    });
    expect(computeHeadline(mkCurrentTariffRun(FIXED)).columns).toEqual({
      flexLabel: 'Flexible',
      agileLabel: 'Agile',
      yoursColumn: null,
    });
  });

  it('sums the complete current-tariff subset and labels "N of M"', () => {
    const h = computeHeadline(
      mkRun([
        mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: 5000 }),
        mkPeriod({ start: '2025-05-01', end: '2025-06-01', actual: 5200 }),
        mkPeriod({
          start: '2025-01-01',
          end: '2025-02-01',
          actual: 5000,
          tariffCodes: ['E-1R-OLD-A'],
        }),
      ]),
    );
    expect(h.scope).toBe('consistent');
    expect(h.label).toBe('Complete periods on your current tariff (2 of 3)');
    expect(h.summaryFlex).toBe(2 * 2135);
    expect(h.trustworthy).toBe(true);
    expect(h.verdict?.alternativeCheaper).toBe(true);
  });

  it('shows n/a (not £0.00) when the current-tariff scope has no actual', () => {
    const h = computeHeadline(
      mkRun([
        mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: null }),
        mkPeriod({
          start: '2025-01-01',
          end: '2025-02-01',
          actual: 5000,
          tariffCodes: ['E-1R-OLD-A'],
        }),
      ]),
    );
    expect(h.scope).toBe('consistent');
    expect(h.summaryHasActual).toBe(false);
  });

  it('excludes a mixed-tariff period from the current-tariff subset', () => {
    const h = computeHeadline(
      mkRun([
        mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: 5000 }),
        mkPeriod({
          start: '2025-03-01',
          end: '2025-04-01',
          actual: 5000,
          tariffCodes: ['E-1R-OLD-A', 'E-1R-CUR-A'],
        }),
      ]),
    );
    expect(h.consistentCount).toBe(1);
  });

  it('scopes the mismatch flag to the summary, but keeps a whole-window flag', () => {
    const h = computeHeadline(
      mkRun(
        [
          mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: 5200 }),
          mkPeriod({
            start: '2025-01-01',
            end: '2025-02-01',
            actual: 5000,
            tariffCodes: ['E-1R-OLD-A'],
          }),
        ],
        {
          statementValidation: [
            sv('2025-01-01', '2025-02-01', true, 400, 200), // pre-switch mismatch, out of scope
            sv('2025-04-01', '2025-05-01', false, 100, 100),
          ],
        },
      ),
    );
    expect(h.anyMismatch).toBe(false);
    expect(h.wholeWindow.anyMismatchAllPeriods).toBe(true);
  });

  it('suppresses the verdict when Agile is unavailable (no null->0 coercion)', () => {
    const h = computeHeadline(
      mkRun(
        [
          mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: 5000, agileTotal: null }),
          mkPeriod({ start: '2025-05-01', end: '2025-06-01', actual: 5000, agileTotal: null }),
          mkPeriod({
            start: '2025-01-01',
            end: '2025-02-01',
            actual: 5000,
            tariffCodes: ['E-1R-OLD-A'],
            agileTotal: null,
          }),
        ],
        { agileAvailable: false },
      ),
    );
    expect(h.summaryAgile).toBeNull();
    expect(h.verdict).toBeNull();
  });

  it('flags not-enough-data when statement history is incomplete', () => {
    const h = computeHeadline(
      mkRun([mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: 5000 })], {
        statementsIncomplete: true,
      }),
    );
    expect(h.trustworthy).toBe(false);
    expect(h.notEnoughData).toBe(true);
    expect(h.verdict).toBeNull();
  });

  it('bases the verdict on the actual paid (not Flexible-calc) when the actual is comparable', () => {
    // actual 9000, Flexible-calc 2135, Agile 1950 — the verdict must use the same
    // 9000 baseline as the "Difference" tile, so they agree.
    const h = computeHeadline(
      mkRun([mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: 9000 })]),
    );
    expect(h.actualComparable).toBe(true);
    expect(h.verdict?.alternativeLabel).toBe('Agile');
    expect(h.verdict?.alternativeCheaper).toBe(true);
    expect(h.verdict?.differencePence).toBe(7050); // |9000 − 1950|, not |2135 − 1950|
  });

  it('is NOT actual-comparable when an unbilled period shares the summary scope', () => {
    // A real bill plus an unbilled (synthetic-tail-style) current-tariff period:
    // summaryActual covers only the bill, but flex/agile cover both → the "You paid"
    // baseline must not be compared against a wider span.
    const h = computeHeadline(
      mkRun([
        mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: 5000 }), // billed
        mkPeriod({ start: '2025-05-01', end: '2025-06-01', actual: null }), // unbilled, same tariff
      ]),
    );
    expect(h.summaryHasActual).toBe(true); // the bill has an actual
    expect(h.actualComparable).toBe(false); // ...but the scope mixes billed + unbilled spans
  });

  it('flags previousTariffOnly when every period predates the current-tariff switch', () => {
    const run = mkRun([
      mkPeriod({
        start: '2025-06-01',
        end: '2025-07-01',
        actual: 9000,
        tariffCodes: ['E-1R-FIX-12M-23-A'],
      }),
      mkPeriod({
        start: '2025-07-01',
        end: '2025-08-01',
        actual: 9000,
        tariffCodes: ['E-1R-FIX-12M-23-A'],
      }),
    ]);
    // The data is on a now-ended Fixed tariff; the current tariff began later.
    run.context.currentAgreement = {
      tariff_code: 'E-1R-VAR-99-01-A',
      valid_from: '2026-04-09T00:00:00.000Z',
      valid_to: null,
    };
    run.context.agreements = [
      {
        tariff_code: 'E-1R-FIX-12M-23-A',
        valid_from: '2025-04-09T00:00:00.000Z',
        valid_to: '2026-04-09T00:00:00.000Z',
      },
      run.context.currentAgreement,
    ];
    const h = computeHeadline(run);

    expect(h.previousTariffOnly).not.toBeNull();
    expect(h.previousTariffOnly?.previousTariffLabel).toBe('Fixed');
    expect(h.previousTariffOnly?.currentTariffLabel).toBe('Flexible');
    expect(h.previousTariffOnly?.switchDate?.toISOString()).toBe('2026-04-09T00:00:00.000Z');
    expect(h.consistentCount).toBe(0);
    // The figures stay honest: all periods are confident, so the earlier-usage
    // comparison is still computed and trustworthy — just clearly not current.
    expect(h.trustworthy).toBe(true);
    expect(h.notEnoughData).toBe(false);
    expect(h.summaryFlex).toBe(2 * 2135);
    expect(h.verdict?.alternativeCheaper).toBe(true);
  });

  it('leaves previousTariffOnly null when some data is on the current tariff', () => {
    const h = computeHeadline(
      mkRun([
        mkPeriod({ start: '2025-04-01', end: '2025-05-01', actual: 5000 }), // current
        mkPeriod({
          start: '2025-01-01',
          end: '2025-02-01',
          actual: 5000,
          tariffCodes: ['E-1R-OLD-A'],
        }),
      ]),
    );
    expect(h.previousTariffOnly).toBeNull();
  });

  it('leaves previousTariffOnly null when a period straddles the switch (mixed)', () => {
    const run = mkRun([
      mkPeriod({
        start: '2025-03-01',
        end: '2025-04-01',
        actual: 5000,
        tariffCodes: ['E-1R-OLD-A', 'E-1R-CUR-A'],
      }),
    ]);
    expect(computeHeadline(run).previousTariffOnly).toBeNull();
  });

  it('leaves previousTariffOnly null when the current tariff is unknown', () => {
    const run = mkRun([
      mkPeriod({
        start: '2025-01-01',
        end: '2025-02-01',
        actual: 5000,
        tariffCodes: ['E-1R-OLD-A'],
      }),
    ]);
    run.context.currentAgreement = null;
    expect(computeHeadline(run).previousTariffOnly).toBeNull();
  });

  it('never names the previous tariff identically to the current one (empty codes → null label)', () => {
    // Readings outside every agreement window: tariffCodes [] and actualTariffCode
    // null. Detection still fires, but the label must NOT fall through to current.
    const run = mkRun([
      mkPeriod({ start: '2025-01-01', end: '2025-02-01', actual: 5000, tariffCodes: [] }),
    ]);
    const notice = computeHeadline(run).previousTariffOnly;
    expect(notice).not.toBeNull();
    expect(notice?.previousTariffLabel).toBeNull();
    expect(notice?.previousTariffLabel).not.toBe(notice?.currentTariffLabel);
  });

  it('stays generic (null label) when the earlier usage spans more than one tariff', () => {
    const run = mkRun([
      mkPeriod({
        start: '2025-01-01',
        end: '2025-02-01',
        actual: 5000,
        tariffCodes: ['E-1R-FIX-12M-23-A'],
      }),
      mkPeriod({
        start: '2025-02-01',
        end: '2025-03-01',
        actual: 5000,
        tariffCodes: ['E-1R-COSY-22-12-08-A'],
      }),
    ]);
    run.context.currentAgreement = {
      tariff_code: 'E-1R-VAR-99-01-A',
      valid_from: '2026-04-09T00:00:00.000Z',
      valid_to: null,
    };
    const notice = computeHeadline(run).previousTariffOnly;
    expect(notice).not.toBeNull();
    expect(notice?.previousTariffLabel).toBeNull(); // two old tariffs → don't name one
  });
});
