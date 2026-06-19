import { describe, it, expect } from 'vitest';
import { OctopusApiError, type OctopusClient } from '../../src/api/client';
import { collectMeters, discoverMeters } from '../../src/api/meters';
import type { AccountData } from '../../src/types/octopus';

function must<T>(v: T | undefined, msg: string): T {
  if (v == null) throw new Error(msg);
  return v;
}

// Entirely fake meter identifiers.
const ACCOUNT: AccountData = {
  number: 'A-FAKE0001',
  properties: [
    {
      address_line_1: '1 Test Street',
      town: 'Testville',
      postcode: 'AB1 2CD',
      electricity_meter_points: [
        {
          mpan: '1900000000001',
          is_export: false,
          meters: [{ serial_number: 'OLD1110001' }, { serial_number: 'NEW2220002' }],
          agreements: [
            { tariff_code: 'E-1R-VAR-22-11-01-A', valid_from: '2024-01-01', valid_to: null },
          ],
        },
        {
          mpan: '1900000000002',
          is_export: true,
          meters: [{ serial_number: 'EXP3330003' }],
          agreements: [
            {
              tariff_code: 'E-1R-OUTGOING-FIX-12M-19-05-13-A',
              valid_from: '2024-01-01',
              valid_to: null,
            },
          ],
        },
        {
          // is_export NOT set, but the tariff pattern marks it export
          mpan: '1900000000003',
          meters: [{ serial_number: 'GEN4440004' }],
          agreements: [
            {
              tariff_code: 'E-1R-AGILE-OUTGOING-19-05-13-A',
              valid_from: '2024-01-01',
              valid_to: null,
            },
          ],
        },
      ],
    },
  ],
};

describe('collectMeters', () => {
  it('collects import + export meters, newest serial first, with swap serials kept', () => {
    const meters = collectMeters(ACCOUNT);
    expect(meters).toHaveLength(3);

    const imp = must(meters[0], 'import');
    expect(imp.isExport).toBe(false);
    expect(imp.serial).toBe('NEW2220002');
    expect(imp.serials).toEqual(['NEW2220002', 'OLD1110001']);
    expect(imp.accountNumber).toBe('A-FAKE0001');
    expect(imp.address).toContain('AB1 2CD');

    expect(must(meters[1], 'export').isExport).toBe(true);
    // export detected by tariff pattern even with is_export unset
    expect(must(meters[2], 'gen').isExport).toBe(true);
  });

  it('skips meter points with no serials', () => {
    const data: AccountData = {
      number: 'A-FAKE0001',
      properties: [{ electricity_meter_points: [{ mpan: '1900000000009', meters: [] }] }],
    };
    expect(collectMeters(data)).toHaveLength(0);
  });
});

describe('discoverMeters', () => {
  it('discovers meters across accounts and skips ones the key cannot read (403)', async () => {
    const client = {
      graphqlRequest: async () => ({
        viewer: { accounts: [{ number: 'A-FAKE0001' }, { number: 'A-FAKE0002' }] },
      }),
      restGet: async (path: string) => {
        if (path.includes('A-FAKE0002')) throw new OctopusApiError('HTTP 403', { status: 403 });
        return ACCOUNT;
      },
    } as unknown as OctopusClient;

    const meters = await discoverMeters(client, 'tok');
    expect(meters).toHaveLength(3); // only the readable account's meters
  });

  it('throws when the key has no accounts', async () => {
    const client = {
      graphqlRequest: async () => ({ viewer: { accounts: [] } }),
    } as unknown as OctopusClient;
    await expect(discoverMeters(client, 'tok')).rejects.toThrow('No accounts found');
  });
});
