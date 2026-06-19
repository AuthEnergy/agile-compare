import { describe, it, expect } from 'vitest';
import { OctopusApiError } from '../../src/api/client';
import { captureFailureDiag, type FailureContext } from '../../src/diagnostics/failure';
import type { PiiIdentifiers } from '../../src/domain/redact';

const GEN = '2026-01-15T12:00:00.000Z';

const FAKE: Required<PiiIdentifiers> = {
  mpan: '1999999999999',
  serial: 'Z9Z9999999',
  serials: ['Z9Z9999999'],
  apiKey: 'sk_test_FAKEKEYzzzz',
  accountNumber: 'A-FAKE1234',
};

const ctx = (): FailureContext => ({
  accountNumber: FAKE.accountNumber,
  serialCount: 1,
  isExport: false,
  postcodeArea: 'AB',
  agreements: [{ tariff_code: 'E-1R-CUR-A', valid_from: '2024-01-01', valid_to: null }],
  metersOnAccount: [{ serialCount: 1, isExport: false, currentTariff: 'E-1R-CUR-A' }],
  progressLog: [`Verifying account ${FAKE.accountNumber}…`, `Reading meter ${FAKE.serial}`],
});

describe('captureFailureDiag', () => {
  it('omits the account number by default and redacts identifiers from free text', () => {
    const err = new Error(`Boom for MPAN ${FAKE.mpan} on ${FAKE.accountNumber}`);
    const d = captureFailureDiag(err, ctx(), FAKE, { generatedAt: GEN });

    expect(d.account.number).toBeNull();
    expect(d.error.message).not.toContain(FAKE.mpan);
    expect(d.error.message).not.toContain(FAKE.accountNumber);
    expect(d.error.message).toContain('[MPAN redacted]');
    for (const line of d.progressLog) {
      expect(line).not.toContain(FAKE.accountNumber);
      expect(line).not.toContain(FAKE.serial);
    }
    // serials/MPAN themselves are never in the structured shape
    expect(JSON.stringify(d)).not.toContain(FAKE.serial);
  });

  it('keeps the account number only under the explicit debug policy', () => {
    const d = captureFailureDiag(new Error('x'), ctx(), FAKE, {
      generatedAt: GEN,
      includeAccountNumber: true,
    });
    expect(d.account.number).toBe(FAKE.accountNumber);
  });

  it('classifies an OctopusApiError with its status and CORS flag', () => {
    const err = new OctopusApiError('HTTP 503: down', { status: 503, corsLikely: false });
    const d = captureFailureDiag(err, ctx(), FAKE, { generatedAt: GEN });
    expect(d.error.type).toBe('OctopusApiError');
    expect(d.error.status).toBe(503);
    expect(d.error.corsLikely).toBe(false);
  });

  it('handles a non-Error throw value', () => {
    const d = captureFailureDiag('a bare string', ctx(), FAKE, { generatedAt: GEN });
    expect(d.error.type).toBe('Error');
    expect(d.error.message).toBe('a bare string');
    expect(d.error.status).toBeNull();
  });
});
