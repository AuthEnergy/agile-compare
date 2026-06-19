import { describe, it, expect } from 'vitest';
import { buildExportDiagnostics, buildImportDiagnostics } from '../../src/diagnostics/capture';
import { makeExportRun, makeRun } from './runFactory';

const GEN = '2026-01-15T12:00:00.000Z';

describe('buildImportDiagnostics', () => {
  it('writes the v2 key shape and the consistent-tariff subtotal', () => {
    const run = makeRun([
      // pre-switch period — excluded from the consistent subset
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
        start: '2025-02-01',
        end: '2025-03-01',
        tariff: 'current',
        actual: 5200,
        flexEnergy: 4300,
        flexStanding: 800,
        agileEnergy: 3700,
        agileStanding: 800,
      },
    ]);

    const d = buildImportDiagnostics(run, { generatedAt: GEN });

    expect(d.generatedAt).toBe(GEN);
    expect(d.appVersion).toContain('agile-compare');
    expect(d.region).toBe('A');
    expect(d.currentTariffCode).toBe('E-1R-VAR-22-11-01-A');
    expect(d.billingPeriods).toHaveLength(3);
    expect(d.billingPeriods[0]?.preSwitch).toBe(true);
    expect(d.billingPeriods[1]?.preSwitch).toBe(false);
    expect(d.billingPeriods[1]?.flexTotalPence).toBe('5000');
    expect(d.billingPeriods[1]?.agileTotalPence).toBe('4400');

    // consistent subset = the two current-tariff confident periods with actuals
    expect(d.totals.consistentOnlyDiag).toEqual({
      periodCount: 2,
      actualPence: 10200,
      flexTotalPence: 10100,
      agileTotalPence: 8900,
    });
    // raw readings + raw rate windows ride along for drill-down replay
    expect(d.readings.raw.length).toBeGreaterThan(0);
    expect(d.rateWindows.rawFlexUnitRates).toHaveLength(1);
    expect(d.rateWindows.rawAgileUnitRates).toHaveLength(1);
  });

  it('contains no MPAN / serial / account / apiKey fields by construction', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        actual: 5000,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: 3600,
        agileStanding: 800,
      },
    ]);
    const json = JSON.stringify(buildImportDiagnostics(run, { generatedAt: GEN }));
    expect(json).not.toMatch(/mpan|serial|apiKey|accountNumber/i);
  });

  it('marks Agile skipped when unavailable (no null->0 coercion)', () => {
    const run = makeRun([
      {
        start: '2025-01-01',
        end: '2025-02-01',
        actual: 5000,
        flexEnergy: 4200,
        flexStanding: 800,
        agileEnergy: null,
      },
    ]);
    run.detail.agileAvailable = false;
    run.context.agileAvailable = false;
    run.context.agileSkipReason = 'no Agile rates for region A in the window';
    const d = buildImportDiagnostics(run, { generatedAt: GEN });
    expect(d.products.agileProductCode).toBe('skipped (no Agile rates for region A in the window)');
    expect(d.rateWindows.agileUnitRates).toBe('Agile skipped');
    expect(d.billingPeriods[0]?.agileTotalPence).toBe('n/a');
  });
});

describe('buildExportDiagnostics', () => {
  it('is aggregate-only by default (no raw half-hourly export slots)', () => {
    const d = buildExportDiagnostics(makeExportRun(), { generatedAt: GEN });
    expect(d.mode).toBe('export');
    expect(d.exportKwh).toBe('1234.50');
    expect(d.readings.count).toBe(2);
    expect(d.readings.raw).toBeUndefined();
  });

  it('includes raw export slots only with explicit consent', () => {
    const d = buildExportDiagnostics(makeExportRun(), {
      generatedAt: GEN,
      includeDetailedExportSlots: true,
    });
    expect(d.readings.raw).toHaveLength(2);
  });
});
