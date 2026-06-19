import { describe, it, expect } from 'vitest';
import { buildImportDiagnostics } from '../../src/diagnostics/capture';
import { replayDiagnostics } from '../../src/diagnostics/replay';
import { computeHeadline } from '../../src/domain/headline';
import { makeRun } from './runFactory';

const GEN = '2026-01-15T12:00:00.000Z';

describe('diagnostics round-trip (capture -> serialise -> replay)', () => {
  it('replays to identical per-period money, totals and headline', () => {
    const run = makeRun([
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
      // current tariff, confident, but NO actual — in the headline subset, out of the diag totals
      {
        start: '2025-02-01',
        end: '2025-03-01',
        tariff: 'current',
        actual: null,
        flexEnergy: 4300,
        flexStanding: 800,
        agileEnergy: 3700,
        agileStanding: 800,
      },
    ]);

    const d1 = buildImportDiagnostics(run, { generatedAt: GEN });
    const replayed = replayDiagnostics(JSON.stringify(d1));
    expect(replayed.ok).toBe(true);
    if (!replayed.ok || replayed.kind !== 'import') throw new Error('expected import replay');

    run.periods.forEach((p, i) => {
      const q = replayed.run.periods[i];
      expect(q?.flex.totalPence).toBe(p.flex.totalPence);
      expect(q?.agile?.totalPence ?? null).toBe(p.agile?.totalPence ?? null);
      expect(q?.actualChargePence).toBe(p.actualChargePence);
      expect(q?.confident).toBe(p.confident);
    });

    // Re-capturing the replayed run reproduces the recorded totals exactly.
    const d2 = buildImportDiagnostics(replayed.run, { generatedAt: GEN });
    expect(d2.totals.consistentOnlyDiag).toEqual(d1.totals.consistentOnlyDiag);
    expect(d2.totals.allPeriods).toEqual(d1.totals.allPeriods);

    // The headline is identical across the original and replayed runs.
    const h1 = computeHeadline(run);
    const h2 = computeHeadline(replayed.run);
    expect(h2.scope).toBe(h1.scope);
    expect(h2.summaryFlex).toBe(h1.summaryFlex);
    expect(h2.summaryAgile).toBe(h1.summaryAgile);
    expect(h2.summaryActual).toBe(h1.summaryActual);
    expect(h2.consistentCount).toBe(h1.consistentCount);
  });
});
