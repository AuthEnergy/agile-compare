import { describe, it, expect } from 'vitest';
import {
  classifyTariffCode,
  findCurrentAgreement,
  makeTariffAtDateFn,
  tariffCodesInRange,
} from '../../src/domain/tariff';
import type { Agreement } from '../../src/types/domain';

describe('classifyTariffCode', () => {
  it('classifies export before agile/var', () => {
    expect(classifyTariffCode('E-1R-AGILE-OUTGOING-19-05-13-C')).toEqual({
      kind: 'export',
      label: 'Outgoing (export)',
    });
  });
  it('classifies the common families', () => {
    expect(classifyTariffCode('E-1R-AGILE-24-10-01-C').kind).toBe('agile');
    expect(classifyTariffCode('E-1R-VAR-22-11-01-C').kind).toBe('flexible');
    expect(classifyTariffCode('E-1R-OE-FIX-12M-25-04-05-B').kind).toBe('fixed');
    expect(classifyTariffCode('E-1R-INTELLI-VAR-22-10-14-C').label).toBe('Intelligent Go');
    expect(classifyTariffCode('E-1R-GO-VAR-22-10-14-C').label).toBe('Go');
    expect(classifyTariffCode('E-1R-COSY-22-12-08-C').kind).toBe('cosy');
  });
  it('classifies named time-of-use families', () => {
    expect(classifyTariffCode('E-1R-FLUX-IMPORT-23-02-14-A').label).toBe('Flux');
    expect(classifyTariffCode('E-1R-FLUX-EXPORT-23-02-14-A').label).toBe('Flux');
    expect(classifyTariffCode('E-1R-POWLP-IMPORT-21-08-11-A').label).toBe('Power Loop');
  });
  it('returns the raw code for an unknown family and a sentinel for empty', () => {
    expect(classifyTariffCode('E-1R-UNKNWN-24-01-01-A')).toEqual({
      kind: 'other',
      label: 'E-1R-UNKNWN-24-01-01-A',
    });
    expect(classifyTariffCode('').kind).toBe('unknown');
    expect(classifyTariffCode(null).kind).toBe('unknown');
  });
});

const agreements: Agreement[] = [
  {
    tariff_code: 'E-1R-OLD-A',
    valid_from: '2025-01-01T00:00:00Z',
    valid_to: '2025-03-15T00:00:00Z',
  },
  { tariff_code: 'E-1R-CUR-A', valid_from: '2025-03-15T00:00:00Z', valid_to: null },
];

describe('makeTariffAtDateFn', () => {
  it('returns the agreement covering a date, or null', () => {
    const at = makeTariffAtDateFn(agreements);
    expect(at(new Date('2025-02-01T00:00:00Z'))).toBe('E-1R-OLD-A');
    expect(at(new Date('2025-04-01T00:00:00Z'))).toBe('E-1R-CUR-A');
    expect(at(new Date('2025-03-15T00:00:00Z'))).toBe('E-1R-CUR-A'); // valid_from inclusive
    expect(at(new Date('2024-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('findCurrentAgreement', () => {
  it('picks the agreement actually in force — not a future one with validTo=null', () => {
    // Scenario: user is on Agile, but Octopus has pre-announced a return to VAR
    // starting in two days. The open-ended VAR must NOT be chosen on the run date.
    const agile: Agreement = {
      tariff_code: 'E-1R-AGILE-24-10-01-A',
      valid_from: '2025-06-24T00:00:00Z',
      valid_to: '2026-06-24T00:00:00Z',
    };
    const futureVar: Agreement = {
      tariff_code: 'E-1R-VAR-22-11-01-A',
      valid_from: '2026-06-24T00:00:00Z',
      valid_to: null,
    };
    const agreeList = [agile, futureVar];
    // Two days before the VAR switch: Agile is current.
    expect(findCurrentAgreement(agreeList, new Date('2026-06-22T12:00:00Z'))?.tariff_code).toBe(
      'E-1R-AGILE-24-10-01-A',
    );
    // After the VAR switch: VAR is current.
    expect(findCurrentAgreement(agreeList, new Date('2026-06-25T12:00:00Z'))?.tariff_code).toBe(
      'E-1R-VAR-22-11-01-A',
    );
  });

  it('returns the open-ended agreement when there is only one', () => {
    const single: Agreement = {
      tariff_code: 'E-1R-CUR-A',
      valid_from: '2024-01-01T00:00:00Z',
      valid_to: null,
    };
    expect(findCurrentAgreement([single], new Date('2025-06-01T00:00:00Z'))?.tariff_code).toBe(
      'E-1R-CUR-A',
    );
  });

  it('falls back to the last agreement when none covers the reference date', () => {
    // reference date is before any agreement
    expect(findCurrentAgreement(agreements, new Date('2020-01-01T00:00:00Z'))?.tariff_code).toBe(
      agreements[agreements.length - 1]?.tariff_code,
    );
  });
});

describe('tariffCodesInRange', () => {
  it('detects a period straddling a switch as mixed (>1 code)', () => {
    const codes = tariffCodesInRange(
      agreements,
      new Date('2025-03-01T00:00:00Z'),
      new Date('2025-04-01T00:00:00Z'),
    );
    expect(codes.size).toBe(2);
  });
  it('a clean single-tariff period has one code', () => {
    const codes = tariffCodesInRange(
      agreements,
      new Date('2025-04-01T00:00:00Z'),
      new Date('2025-05-01T00:00:00Z'),
    );
    expect([...codes]).toEqual(['E-1R-CUR-A']);
  });
});
