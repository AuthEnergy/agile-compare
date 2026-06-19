import { describe, it, expect } from 'vitest';
import { replayDiagnostics } from '../../src/diagnostics/replay';
import { buildExportDiagnostics } from '../../src/diagnostics/capture';
import { makeExportRun } from './runFactory';
import fixture from '../fixtures/diagnostics-l-wip-v2.json';

// A minimal object that clears the structural gates (mode/required keys/window),
// so individual cap tests can push one field past its limit.
function baseValid(): Record<string, unknown> {
  return {
    comparisonWindow: { from: '2025-01-01T00:00:00Z', to: '2025-02-01T00:00:00Z' },
    readings: { raw: [] },
    billingPeriods: [],
    rateWindows: {
      rawFlexUnitRates: [],
      rawFlexStandingCharges: [],
      rawAgileUnitRates: [],
      rawAgileStandingCharges: [],
    },
  };
}

describe('replayDiagnostics — guards', () => {
  it('rejects non-JSON', () => {
    const r = replayDiagnostics('not json{{');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-json');
  });

  it('rejects a malformed export diagnostic (no comparison window)', () => {
    const r = replayDiagnostics(JSON.stringify({ mode: 'export' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-window');
  });

  it('replays an export diagnostic to its aggregate figures', () => {
    const run = makeExportRun();
    const diag = buildExportDiagnostics(run, { generatedAt: '2026-06-19T00:00:00.000Z' });
    const r = replayDiagnostics(JSON.stringify(diag));
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'export') throw new Error('expected export replay');
    expect(r.exportRun.exportKwh).toBeCloseTo(run.exportKwh, 1);
    expect(r.exportRun.flat?.valuePence).toBe(run.flat?.valuePence);
    expect(r.exportRun.agile?.valuePence).toBe(run.agile?.valuePence);
    expect(r.exportRun.regionLetter).toBe(run.regionLetter);
  });

  it('rejects a file missing the diagnostic keys', () => {
    const r = replayDiagnostics(JSON.stringify({ region: 'C' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-diagnostics');
  });

  it('refuses an absurdly large file (period cap)', () => {
    const d = baseValid();
    d['billingPeriods'] = new Array(5001).fill({
      displayPeriod: '2025-01-01 to 2025-02-01',
      calculationPeriod: '2025-01-01 to 2025-02-01',
    });
    const r = replayDiagnostics(JSON.stringify(d));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-large');
  });

  it('refuses an absurdly large file (raw unit-rate cap)', () => {
    const d = baseValid();
    (d['rateWindows'] as Record<string, unknown>)['rawFlexUnitRates'] = new Array(200001).fill({
      from: '2025-01-01T00:00:00Z',
      to: null,
      p: 10,
    });
    const r = replayDiagnostics(JSON.stringify(d));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-large');
  });

  it('rejects a missing/invalid comparison window', () => {
    const d = baseValid();
    d['comparisonWindow'] = { from: 'nonsense', to: 'also nonsense' };
    const r = replayDiagnostics(JSON.stringify(d));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-window');
  });

  it('refuses a hostile per-period span without freezing (parseable but astronomical date)', () => {
    const d = baseValid();
    // Valid Dates ~2.9M days apart — splitLongPeriods would loop ~96k times per
    // period. Must be rejected fast, before reconstruction.
    d['billingPeriods'] = [
      {
        calculationPeriod: '2000-01-01 to 9999-12-31',
        displayPeriod: '2000-01-01 to 9999-12-31',
      },
    ];
    const start = performance.now();
    const r = replayDiagnostics(JSON.stringify(d));
    const elapsedMs = performance.now() - start;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-large');
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('replayDiagnostics — reconstruction', () => {
  it('rebuilds a ComparisonRun from a valid diagnostics file', () => {
    const r = replayDiagnostics(JSON.stringify(fixture));
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'import') throw new Error('expected import replay');
    expect(r.meta.appVersion).toContain('v0.2.0-rc12');
    expect(r.run.periods).toHaveLength(3);
    expect(r.run.context.regionLetter).toBe('C');
    expect(r.run.context.agileAvailable).toBe(true);
    // Stored pences round back exactly for non-split periods.
    const p2 = r.run.periods[1];
    expect(p2?.flex.totalPence).toBe(5000);
    expect(p2?.agile?.totalPence).toBe(4400);
    expect(p2?.actualChargePence).toBe(5000);
    expect(p2?.confident).toBe(true);
  });
});
