import { describe, it, expect } from 'vitest';
import { computeHeadline } from '../../src/domain/headline';
import { computeResultsViewModel } from '../../src/ui/viewModel';
import { makeRun } from '../diagnostics/runFactory';

function must<T>(v: T | null | undefined, msg: string): T {
  if (v == null) throw new Error(msg);
  return v;
}

describe('computeResultsViewModel', () => {
  it('classifies periods and computes the headline figures', () => {
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
      {
        start: '2024-12-01',
        end: '2025-01-01',
        tariff: 'old',
        actual: 4800,
        flexEnergy: 4100,
        flexStanding: 800,
        agileEnergy: 3500,
        agileStanding: 800,
      },
      {
        start: '2025-02-01',
        end: '2025-03-01',
        tariff: 'mixed',
        actual: 5200,
        flexEnergy: 4300,
        flexStanding: 800,
        agileEnergy: 3700,
        agileStanding: 800,
      },
    ]);
    const vm = computeResultsViewModel(run, computeHeadline(run));

    expect(vm.completeLabel).toBe('1 of 3');
    expect(vm.paid.amount).toBe('50.00');
    expect(must(vm.agile, 'agile').amount).toBe('44.00');
    const diff = must(vm.difference, 'difference');
    expect(diff.amount).toBe('6.00');
    expect(diff.tone).toBe('saving');
    expect(diff.sign).toBe('−');
    expect(vm.verdictText).toContain('Agile would have been cheaper');

    const complete = must(vm.periods[0], 'p0');
    expect(complete.status).toBe('complete');
    expect(complete.expandable).toBe(true);

    const preSwitch = must(vm.periods[1], 'p1');
    expect(preSwitch.status).toBe('preSwitch');
    expect(preSwitch.expandable).toBe(false);
    expect(preSwitch.kwhText).toBe('excl.');

    const mixed = must(vm.periods[2], 'p2');
    expect(mixed.status).toBe('mixed');
    expect(mixed.expandable).toBe(false);
  });

  it('keeps a statement-mismatch period drillable even though its total is suppressed', () => {
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
    run.context.statementValidation = [
      {
        displayStart: new Date('2025-01-01'),
        displayEnd: new Date('2025-02-01'),
        billedKwh: 318,
        observedKwh: 312,
        electricityChargePence: 5000,
        creditsPence: 0,
        credits: [],
        transactionsAvailable: true,
        transactionsComplete: true,
        wasClamped: false,
        mismatch: true,
      },
    ];
    const vm = computeResultsViewModel(run, computeHeadline(run));
    const row = must(vm.periods[0], 'p0');
    expect(row.status).toBe('mismatch');
    expect(row.expandable).toBe(true); // drill into the days/slots even when suppressed
    // Per-month £ on each tariff (no one cares about kWh alone).
    expect(row.flexText).toBe('£50.00'); // 4200 + 800
    expect(row.agileText).toBe('£44.00'); // 3600 + 800
  });

  it('does not present apportioned split actuals as literal paid totals', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        tariff: 'current',
        actual: 7000,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: 3600,
        agileStanding: 800,
      },
    ]);
    must(run.periods[0], 'p0').isSplit = true;

    const vm = computeResultsViewModel(run, computeHeadline(run));

    expect(vm.paid.label).toBe('Flexible (calc.)');
    expect(vm.paid.amount).toBe('50.00');
    const diff = must(vm.difference, 'difference');
    expect(diff.amount).toBe('6.00');
    expect(diff.period).toBe('lower on Agile');
  });

  it('frames the all-pre-switch case as earlier usage, not "0 of N current"', () => {
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

    const vm = computeResultsViewModel(run, computeHeadline(run));

    const notice = must(vm.previousTariffNotice, 'notice');
    expect(notice.previousLabel).toBe('Fixed');
    expect(notice.heading).toBe('No data on your current tariff yet');
    expect(notice.body).toContain('Flexible'); // names the current tariff
    expect(notice.body).toContain('not your current tariff');

    expect(vm.scopeTitle).toContain('Earlier usage on Fixed');
    expect(vm.scopeCount).toBe('2 periods');
    expect(vm.confidencePct).toBe(90); // bar tracks confidence level, not coverage
    expect(vm.confidenceCaption).toContain('earlier usage on Fixed');

    // The "You paid" tile shows the actual OLD (Fixed) bill — caption it as Fixed,
    // never as Flexible. Agile wins here, framed against the actual Fixed bill.
    expect(vm.paid.period).toBe('Fixed');
    expect(vm.verdictText).toContain('Agile would have cost');
    expect(vm.verdictText).toContain('on Fixed');
    expect(vm.verdictText).not.toContain('Flexible');

    // Pre-switch rows are now part of the figures: show their kWh + an honest reason.
    const row = must(vm.periods[0], 'p0');
    expect(row.status).toBe('preSwitch');
    expect(row.kwhText).not.toBe('excl.');
    expect(row.reason).toContain('before you switched');
  });

  it('never frames the actual OLD-tariff bill as a "Flexible" win (honesty)', () => {
    // The old Fixed bill is CHEAPER than Agile would have been — verdict.cheaper is
    // 'Flexible' internally, but Flexible was never in play. Copy must say "You paid".
    const run = makeRun([
      {
        start: '2025-06-01',
        end: '2025-07-01',
        tariff: 'old',
        actual: 3000, // cheap actual Fixed bill
        flexEnergy: 7000,
        flexStanding: 1000,
        agileEnergy: 7000,
        agileStanding: 1000, // Agile dearer than the Fixed bill
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
    const h = computeHeadline(run);
    expect(h.verdict?.alternativeCheaper).toBe(false); // the old bill beat Agile
    const vm = computeResultsViewModel(run, h);
    expect(vm.verdictText).not.toContain('Flexible');
    expect(vm.verdictText).toContain('You paid');
    expect(vm.verdictText).toContain('on Fixed');
  });

  it('never claims more "confident" periods than exist when a pre-switch period is incomplete', () => {
    const run = makeRun([
      {
        start: '2025-06-01',
        end: '2025-07-01',
        tariff: 'old',
        confident: false, // makes the headline not trustworthy
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
    const vm = computeResultsViewModel(run, computeHeadline(run));
    expect(vm.previousTariffNotice).not.toBeNull(); // notice still explains the switch
    expect(vm.notEnoughData).toBe(true);
    expect(vm.confidencePct).toBe(28); // low-confidence fallback
    // The caption must not call a non-confident period "confident".
    expect(vm.confidenceCaption).not.toContain('confident period');
    expect(vm.confidenceCaption).toContain('some readings are incomplete');
  });

  it('keeps the normal current-tariff header when current-tariff data exists', () => {
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
    const vm = computeResultsViewModel(run, computeHeadline(run));
    expect(vm.previousTariffNotice).toBeNull();
    expect(vm.scopeTitle).toBe('Complete periods on your current tariff:');
  });

  it('compares an Agile user against Flexible — never captions "you paid" as Flexible', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        tariff: 'current',
        actual: 4000, // paid on Agile
        flexEnergy: 5000,
        flexStanding: 1000, // Flexible would have been 6000
        agileEnergy: 3200,
        agileStanding: 800, // Agile-calc 4000 ≈ what they paid
      },
    ]);
    const AGILE = 'E-1R-AGILE-24-10-01-A';
    run.periods.forEach((p) => {
      p.tariffCodes = [AGILE];
      p.actualTariffCode = AGILE;
    });
    run.context.currentAgreement = {
      tariff_code: AGILE,
      valid_from: '2024-01-01T00:00:00.000Z',
      valid_to: null,
    };
    const vm = computeResultsViewModel(run, computeHeadline(run));

    // "You paid" on Agile — captioned Agile, NOT Flexible.
    expect(vm.paid.label).toBe('You paid');
    expect(vm.paid.period).toBe('Agile');
    // The comparison tile is the tariff they're NOT on: Flexible.
    expect(must(vm.agile, 'alt').label).toBe('Flexible estimate');
    expect(must(vm.agile, 'alt').amount).toBe('60.00');
    // Paid £40 on Agile vs Flexible £60 → already on the cheaper tariff (no false win).
    expect(vm.verdictText).toContain('already on the cheaper tariff');
    expect(vm.verdictText).toContain('Flexible would have cost');
  });
});
