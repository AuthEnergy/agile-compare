import { describe, it, expect } from 'vitest';
import {
  getAgreementsForMpan,
  getPostcodeAreaForMpan,
  getRegionLetterFromAccount,
} from '../../src/api/account';
import type { AccountData } from '../../src/types/octopus';

describe('getRegionLetterFromAccount', () => {
  it('derives region from the tariff_code suffix when gsp is absent', () => {
    const acct: AccountData = {
      number: 'A-1FC1B997',
      properties: [
        {
          electricity_meter_points: [
            {
              mpan: '1050001523469',
              is_export: false,
              agreements: [
                {
                  tariff_code: 'E-1R-VAR-22-11-01-A',
                  valid_from: '2025-05-31T00:00:00+01:00',
                  valid_to: '2025-06-24T00:00:00+01:00',
                },
                {
                  tariff_code: 'E-1R-AGILE-24-10-01-A',
                  valid_from: '2025-06-24T00:00:00+01:00',
                  valid_to: null,
                },
              ],
            },
          ],
        },
      ],
    };
    expect(getRegionLetterFromAccount(acct, '1050001523469')).toBe('A');
  });

  it('uses the gsp field when present', () => {
    const acct: AccountData = {
      properties: [
        { electricity_meter_points: [{ mpan: '9999999999999', gsp: '_M', agreements: [] }] },
      ],
    };
    expect(getRegionLetterFromAccount(acct, '9999999999999')).toBe('M');
  });

  it('returns null for a genuinely absent MPAN', () => {
    const acct: AccountData = {
      properties: [
        { electricity_meter_points: [{ mpan: '1111111111111', gsp: '_C', agreements: [] }] },
      ],
    };
    expect(getRegionLetterFromAccount(acct, '9999999999999')).toBeNull();
  });

  it('returns the sentinel when found but no region is derivable', () => {
    const acct: AccountData = {
      properties: [
        {
          electricity_meter_points: [
            {
              mpan: '123',
              agreements: [{ tariff_code: 'NO-REGION', valid_from: '2025-01-01', valid_to: null }],
            },
          ],
        },
      ],
    };
    expect(getRegionLetterFromAccount(acct, '123')).toBe('MPAN_FOUND_NO_REGION');
  });
});

describe('getPostcodeAreaForMpan', () => {
  it('returns only the outward code', () => {
    const acct: AccountData = {
      properties: [{ postcode: 'N15 4FZ', electricity_meter_points: [{ mpan: '1050001523469' }] }],
    };
    expect(getPostcodeAreaForMpan(acct, '1050001523469')).toBe('N15');
  });

  it('handles missing space, missing postcode, and a non-matching MPAN', () => {
    expect(
      getPostcodeAreaForMpan(
        { properties: [{ postcode: 'N154FZ', electricity_meter_points: [{ mpan: '123' }] }] },
        '123',
      ),
    ).toBe('N15');
    expect(
      getPostcodeAreaForMpan(
        { properties: [{ electricity_meter_points: [{ mpan: '123' }] }] },
        '123',
      ),
    ).toBeNull();
    expect(
      getPostcodeAreaForMpan(
        { properties: [{ postcode: 'N15 4FZ', electricity_meter_points: [{ mpan: 'other' }] }] },
        '123',
      ),
    ).toBeNull();
  });
});

describe('getAgreementsForMpan', () => {
  it('returns the agreements for the matching MPAN, else []', () => {
    const acct: AccountData = {
      properties: [
        {
          electricity_meter_points: [
            {
              mpan: '123',
              agreements: [
                { tariff_code: 'E-1R-VAR-22-11-01-C', valid_from: '2024-01-01', valid_to: null },
              ],
            },
          ],
        },
      ],
    };
    expect(getAgreementsForMpan(acct, '123')).toHaveLength(1);
    expect(getAgreementsForMpan(acct, 'nope')).toEqual([]);
  });
});
