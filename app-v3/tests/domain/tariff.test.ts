import { describe, it, expect } from 'vitest';
import {
  classifyTariffCode,
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
  it('returns the raw code for an unknown family and a sentinel for empty', () => {
    expect(classifyTariffCode('E-1R-SILVER-2017-1-C')).toEqual({
      kind: 'other',
      label: 'E-1R-SILVER-2017-1-C',
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
