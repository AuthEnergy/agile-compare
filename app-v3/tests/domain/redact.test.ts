import { describe, it, expect } from 'vitest';
import { redactPII } from '../../src/domain/redact';

describe('redactPII', () => {
  const ids = { mpan: '1234567890123', serials: ['Z99Z999999'], apiKey: 'sk_test_secret' };

  it('strips MPAN, serial and API key, preserving surrounding text', () => {
    const out = redactPII('No data for MPAN 1234567890123 on Z99Z999999 (sk_test_secret)', ids);
    expect(out).not.toContain('1234567890123');
    expect(out).not.toContain('Z99Z999999');
    expect(out).not.toContain('sk_test_secret');
    expect(out).toContain('[MPAN redacted]');
    expect(out).toMatch(/No data for MPAN/);
  });

  it('passes null/undefined through', () => {
    expect(redactPII(null, ids)).toBeNull();
    expect(redactPII(undefined, ids)).toBeUndefined();
  });

  it('redacts the account number ONLY when policy supplies it', () => {
    const text = 'account A-ABCD1234';
    expect(redactPII(text, { mpan: null })).toBe('account A-ABCD1234'); // kept by default
    expect(redactPII(text, { accountNumber: 'A-ABCD1234' })).toBe('account [account redacted]');
  });
});
