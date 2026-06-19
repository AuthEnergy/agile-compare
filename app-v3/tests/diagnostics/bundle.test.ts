import { describe, it, expect } from 'vitest';
import { buildDiagnosticsBundle } from '../../src/diagnostics/bundle';
import { buildExportDiagnostics, buildImportDiagnostics } from '../../src/diagnostics/capture';
import { captureFailureDiag } from '../../src/diagnostics/failure';
import type { PiiIdentifiers } from '../../src/domain/redact';
import { makeExportRun, makeRun } from './runFactory';

const GEN = '2026-01-15T12:00:00.000Z';

// Entirely fake identifiers — never real keys/accounts/MPANs/serials.
const FAKE: Required<PiiIdentifiers> = {
  mpan: '1999999999999',
  serial: 'Z9Z9999999',
  serials: ['Z9Z9999999'],
  apiKey: 'sk_test_FAKEKEYzzzz',
  accountNumber: 'A-FAKE1234',
};

function fakeFailure(includeAccountNumber = false) {
  const err = new Error(`HTTP 500 fetching MPAN ${FAKE.mpan} on account ${FAKE.accountNumber}`);
  return captureFailureDiag(
    err,
    {
      accountNumber: FAKE.accountNumber,
      serialCount: 1,
      isExport: false,
      postcodeArea: 'AB',
      agreements: [],
      metersOnAccount: [],
      progressLog: [`Verifying account ${FAKE.accountNumber}…`, `Reading meter ${FAKE.serial}`],
    },
    FAKE,
    { generatedAt: GEN, includeAccountNumber },
  );
}

describe('buildDiagnosticsBundle — redaction & filenames', () => {
  it('scrubs every identifier from the serialised output and omits the account number', () => {
    const bundle = buildDiagnosticsBundle({ diagnostics: fakeFailure(), ids: FAKE });
    expect(bundle.mimeType).toBe('application/json');
    expect(bundle.filename).toMatch(/^octopus-tariff-failure-diagnostics-.*\.json$/);
    expect(bundle.byteLength).toBeGreaterThan(0);

    expect(bundle.content).not.toContain(FAKE.mpan);
    expect(bundle.content).not.toContain(FAKE.serial);
    expect(bundle.content).not.toContain(FAKE.apiKey);
    expect(bundle.content).not.toContain(FAKE.accountNumber);
    expect(bundle.content).toContain('[MPAN redacted]');

    // structured account number is null by default
    const obj = JSON.parse(bundle.content) as { account: { number: string | null } };
    expect(obj.account.number).toBeNull();
    // still valid JSON after the string redaction pass
    expect(typeof obj.account).toBe('object');
  });

  it('keeps the account number only under the explicit debug policy', () => {
    const bundle = buildDiagnosticsBundle({
      diagnostics: fakeFailure(true),
      ids: FAKE,
      policy: { includeAccountNumber: true },
    });
    const obj = JSON.parse(bundle.content) as { account: { number: string | null } };
    expect(obj.account.number).toBe(FAKE.accountNumber);
    expect(bundle.content).toContain(FAKE.accountNumber);
  });
});

describe('buildDiagnosticsBundle — export privacy', () => {
  it('strips raw export slots without consent, even if present in the diag', () => {
    // capture WITH detailed slots, then bundle WITHOUT consent -> stripped
    const diag = buildExportDiagnostics(makeExportRun(), {
      generatedAt: GEN,
      includeDetailedExportSlots: true,
    });
    const bundle = buildDiagnosticsBundle({ diagnostics: diag, ids: FAKE });
    const obj = JSON.parse(bundle.content) as { readings: { raw?: unknown[] } };
    expect(obj.readings.raw).toBeUndefined();
    expect(bundle.filename).toMatch(/export-diagnostics/);
  });

  it('keeps raw export slots when consent is given', () => {
    const diag = buildExportDiagnostics(makeExportRun(), {
      generatedAt: GEN,
      includeDetailedExportSlots: true,
    });
    const bundle = buildDiagnosticsBundle({
      diagnostics: diag,
      ids: FAKE,
      policy: { includeDetailedExportSlots: true },
    });
    const obj = JSON.parse(bundle.content) as { readings: { raw?: unknown[] } };
    expect(obj.readings.raw).toHaveLength(2);
  });
});

describe('buildDiagnosticsBundle — import', () => {
  it('keeps raw readings + windows and stays valid JSON', () => {
    const diag = buildImportDiagnostics(
      makeRun([
        {
          start: '2025-01-01',
          end: '2025-02-01',
          actual: 5000,
          flexEnergy: 4200,
          flexStanding: 800,
          agileEnergy: 3600,
          agileStanding: 800,
        },
      ]),
      { generatedAt: GEN },
    );
    const bundle = buildDiagnosticsBundle({ diagnostics: diag, ids: FAKE });
    expect(bundle.filename).toMatch(/^octopus-tariff-diagnostics-.*\.json$/);
    const obj = JSON.parse(bundle.content) as { readings: { raw: unknown[] } };
    expect(obj.readings.raw.length).toBeGreaterThan(0);
  });
});
