import { describe, it, expect, beforeEach } from 'vitest';
import { computeHeadline } from '../../src/domain/headline';
import { renderResults } from '../../src/ui/results';
import { makeRun } from '../diagnostics/runFactory';
import type { ComparisonRun } from '../../src/types/result';

// A run where every priced period is from a now-ended Fixed tariff and the user's
// current tariff (Flexible) only began afterwards — so there is no current-tariff
// data. This is the exact shape that used to render a confusing "0 of N on your
// current tariff" alongside a full comparison.
function predateRun(): ComparisonRun {
  const run = makeRun([
    {
      start: '2025-06-01',
      end: '2025-07-01',
      tariff: 'old',
      actual: 9000,
      flexEnergy: 7000,
      flexStanding: 1000,
      agileEnergy: 3000,
      agileStanding: 1000,
    },
    {
      start: '2025-07-01',
      end: '2025-08-01',
      tariff: 'old',
      actual: 9000,
      flexEnergy: 7000,
      flexStanding: 1000,
      agileEnergy: 3000,
      agileStanding: 1000,
    },
  ]);
  run.periods.forEach((p) => {
    p.tariffCodes = ['E-1R-FIX-12M-23-A'];
    p.actualTariffCode = 'E-1R-FIX-12M-23-A';
  });
  run.context.currentAgreement = {
    tariff_code: 'E-1R-VAR-99-01-A',
    valid_from: '2026-04-09T00:00:00.000Z',
    valid_to: null,
  };
  return run;
}

describe('renderResults — all data predates the current tariff', () => {
  let host: HTMLElement;
  const cb = {
    onTiming: () => {},
    onReset: () => {},
    onDiagnostics: () => {},
    onEditTariff: () => {},
    onResetTariff: null,
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.append(host);
  });

  it('shows the explanatory notice and never "0 of N on your current tariff"', () => {
    const run = predateRun();
    renderResults(host, run, computeHeadline(run), null, cb);
    const text = host.textContent ?? '';

    expect(text).toContain('No data on your current tariff yet');
    expect(text).toContain('Earlier usage on Fixed');
    // The contradictory header / count must be gone.
    expect(text).not.toContain('Complete periods on your current tariff');
    expect(text).not.toMatch(/\b0 of \d/);
  });

  it('labels the statement card "earlier usage", not "complete periods"', () => {
    const run = predateRun();
    run.context.statementValidation = [
      {
        displayStart: new Date('2025-06-01'),
        displayEnd: new Date('2025-07-01'),
        billedKwh: 500,
        observedKwh: 498,
        electricityChargePence: 9000,
        creditsPence: 0,
        credits: [],
        transactionsAvailable: true,
        transactionsComplete: true,
        wasClamped: false,
        mismatch: false,
        statementCharges: [],
      },
    ];
    renderResults(host, run, computeHeadline(run), null, cb);
    const text = host.textContent ?? '';
    expect(text).toContain('Billed kWh (earlier usage)');
    expect(text).not.toContain('Billed kWh (complete periods)');
  });

  it('shows an honest note when usage runs past the last bill', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        tariff: 'current',
        actual: 5000,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: 3600,
        agileStanding: 800,
      },
    ]);
    run.context.readingsBeyondStatements = true;
    run.context.latestStatementEnd = new Date('2026-01-01T00:00:00Z');
    renderResults(host, run, computeHeadline(run), null, cb);
    const text = host.textContent ?? '';
    expect(text).toContain('Your most recent usage isn’t billed yet');
    expect(text).toContain('not what you actually paid');
  });

  it('uses a whole-period note when NO statement covers the window', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        tariff: 'current',
        actual: 5000,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: 3600,
        agileStanding: 800,
      },
    ]);
    run.context.readingsBeyondStatements = true;
    run.context.latestStatementEnd = null; // no in-window statement
    renderResults(host, run, computeHeadline(run), null, cb);
    const text = host.textContent ?? '';
    expect(text).toContain('None of this usage is billed yet');
    expect(text).not.toContain('We found statements up to');
  });

  it('explains estimate-only mode when statements cannot be attributed to one MPAN', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        tariff: 'current',
        actual: null,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: 3600,
        agileStanding: 800,
      },
    ]);
    run.context.statementAttribution = {
      mode: 'estimate-only-unsafe-multi-mpan',
      accountsWithMeter: 1,
      accountsUsedForStatements: 0,
      unsafeAccountsWithMeter: 1,
    };

    renderResults(host, run, computeHeadline(run), null, cb);
    const text = host.textContent ?? '';
    expect(text).toContain('Bills not attributed safely');
    expect(text).toContain('left out the billed “you paid” total');
  });

  it('hides the statement-check card (no 0/0) when no bill covers the summarised periods', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        tariff: 'current',
        actual: 5000,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: 3600,
        agileStanding: 800,
      },
    ]);
    // A statement exists but is clamped (so it's excluded from billed checks) and
    // doesn't cover the summarised period → scopedBilledKwh is 0.
    run.context.statementValidation = [
      {
        displayStart: new Date('2024-06-01'),
        displayEnd: new Date('2024-12-01'),
        billedKwh: 1000,
        observedKwh: 950,
        electricityChargePence: 9000,
        creditsPence: 0,
        credits: [],
        transactionsAvailable: true,
        transactionsComplete: true,
        wasClamped: true,
        mismatch: false,
        statementCharges: [],
      },
    ];
    renderResults(host, run, computeHeadline(run), null, cb);
    const text = host.textContent ?? '';
    expect(text).not.toContain('Checked against your statements');
    expect(text).not.toContain('Observed kWh');
  });

  it('still renders the normal current-tariff header for an ordinary run', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        tariff: 'current',
        actual: 5000,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: 3600,
        agileStanding: 800,
      },
    ]);
    renderResults(host, run, computeHeadline(run), null, cb);
    const text = host.textContent ?? '';

    expect(text).toContain('Complete periods on your current tariff');
    expect(text).not.toContain('No data on your current tariff yet');
  });
});

describe('renderResults — drill-down tariff labels', () => {
  const cb = {
    onTiming: () => {},
    onReset: () => {},
    onDiagnostics: () => {},
    onEditTariff: () => {},
    onResetTariff: null,
  };

  it('marks the Agile column as yours for an Agile user', () => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.append(host);
    const agileTariff = 'E-1R-AGILE-24-10-01-A';
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        tariff: 'current',
        actual: 5000,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: 3600,
        agileStanding: 800,
      },
    ]);
    run.context.currentAgreement = {
      tariff_code: agileTariff,
      valid_from: '2025-01-01T00:00:00.000Z',
      valid_to: null,
    };
    run.context.agreements = [run.context.currentAgreement];
    run.periods.forEach((p) => {
      p.tariffCodes = [agileTariff];
      p.actualTariffCode = agileTariff;
    });

    renderResults(host, run, computeHeadline(run), null, cb);
    expect(host.textContent).toContain('Agile');
    expect(host.textContent).toContain('Flexible');

    host.querySelector<HTMLElement>('.row')?.click();
    host.querySelector<HTMLElement>('.cal-cell:not(.cal-cell-empty)')?.click();
    expect(host.textContent).toContain('Agile (Unit £)');
    expect(host.textContent).toContain('Flexible (Unit £)');
  });
});
