import { describe, it, expect } from 'vitest';
import { buildImportDiagnostics } from '../../src/diagnostics/capture';
import { replayDiagnostics } from '../../src/diagnostics/replay';
import { computeHeadline } from '../../src/domain/headline';
import fixture from '../fixtures/diagnostics-l-wip-v2.json';

// Backward compatibility: a diagnostics JSON produced by hardened l-wip v2 must
// still replay in v3 to identical totals. The committed fixture is v2's exact
// serialised shape (with its v2 appVersion string) and entirely fake data.
describe('backward compatibility with l-wip v2 diagnostics', () => {
  it('replays the committed v2 fixture to identical totals', () => {
    const r = replayDiagnostics(JSON.stringify(fixture));
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'import') throw new Error('expected import replay');

    expect(r.meta.appVersion).toContain('v0.2.0-rc12');

    // Re-capturing reproduces the totals the v2 file recorded.
    const recap = buildImportDiagnostics(r.run, { generatedAt: '2026-06-18T00:00:00.000Z' });
    expect(recap.totals.consistentOnlyDiag).toEqual(fixture.totals.consistentOnlyDiag);
    expect(recap.totals.allPeriods).toEqual(fixture.totals.allPeriods);

    // Full round-trip fidelity: the re-captured readings summary, per-period rows
    // and statement validation match the v2 file field-for-field.
    expect(recap.readings).toEqual(fixture.readings);
    expect(recap.billingPeriods).toEqual(fixture.billingPeriods);
    expect(recap.statementValidation).toEqual(fixture.statementValidation);

    // The headline derived from the replayed run matches the recorded subtotal.
    const h = computeHeadline(r.run);
    expect(h.scope).toBe('consistent');
    expect(h.consistentCount).toBe(2);
    expect(h.summaryFlex).toBe(10100);
    expect(h.summaryAgile).toBe(8900);
    expect(h.summaryActual).toBe(10200);
    expect(h.verdict?.alternativeLabel).toBe('Agile');
    expect(h.verdict?.alternativeCheaper).toBe(true);
  });
});
