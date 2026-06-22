import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '../../src/api/client';
import { fetchStatements, fetchStatementsForMpan } from '../../src/api/statements';
import type { AccountData } from '../../src/types/octopus';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function jsonResp(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stmt(id: number) {
  return {
    node: {
      id,
      startAt: '2025-01-01T00:00:00Z',
      endAt: '2025-02-01T00:00:00Z',
      totalCharges: { grossTotal: 1000 },
      transactions: { totalCount: 0, pageInfo: { hasNextPage: false }, edges: [] },
    },
  };
}

function ledger(edges: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { statements: { pageInfo: { hasNextPage, endCursor }, edges } };
}

describe('fetchStatements', () => {
  it('pages a single statement-bearing ledger safely to completion', async () => {
    globalThis.fetch = (async (_url: string | URL, opts?: { body?: string }) => {
      const body = JSON.parse(opts?.body ?? '{}');
      const after = body.variables?.after ?? null;
      if (after === null) {
        return jsonResp({ data: { account: { ledgers: [ledger([stmt(1)], true, 'CUR1')] } } });
      }
      return jsonResp({ data: { account: { ledgers: [ledger([stmt(2)], false)] } } });
    }) as unknown as typeof fetch;

    const res = await fetchStatements(createClient('k'), 'tok', 'A-X');
    expect(res.statements).toHaveLength(2);
    expect(res.incomplete).toBe(false);
  });

  it('flags incomplete when more than one ledger has statements (cursor unsafe)', async () => {
    globalThis.fetch = (async () =>
      jsonResp({
        data: {
          account: {
            ledgers: [ledger([stmt(1)], true, 'A1'), ledger([stmt(2)], true, 'B1')],
          },
        },
      })) as unknown as typeof fetch;

    const res = await fetchStatements(createClient('k'), 'tok', 'A-X');
    expect(res.incomplete).toBe(true);
  });
});

const MPAN = '1111111111111';
const acctWith = (mpan: string | null): AccountData =>
  ({
    number: 'n',
    properties: mpan
      ? [{ electricity_meter_points: [{ mpan, meters: [{ serial_number: 'S' }], agreements: [] }] }]
      : [],
  }) as unknown as AccountData;

describe('fetchStatementsForMpan', () => {
  it('merges statements from every account on the key that lists the same meter', async () => {
    globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
      const u = new URL(url.toString());
      if (u.pathname.includes('/graphql/')) {
        const body = JSON.parse(opts?.body ?? '{}');
        const q: string = body.query ?? '';
        if (q.includes('viewer')) {
          return jsonResp({
            data: {
              viewer: {
                accounts: [{ number: 'A-OLD' }, { number: 'A-NEW' }, { number: 'A-OTHER' }],
              },
            },
          });
        }
        if (q.includes('Statements')) {
          const acc = body.variables?.accountNumber;
          const id = acc === 'A-OLD' ? 1 : acc === 'A-NEW' ? 2 : 3;
          return jsonResp({ data: { account: { ledgers: [ledger([stmt(id)], false)] } } });
        }
      }
      if (u.pathname.includes('/accounts/')) {
        const num = u.pathname.split('/').filter(Boolean).slice(-1)[0];
        return jsonResp(acctWith(num === 'A-OTHER' ? null : MPAN)); // A-OTHER lacks the meter
      }
      throw new Error('unhandled ' + u.pathname);
    }) as unknown as typeof fetch;

    const res = await fetchStatementsForMpan(
      createClient('k'),
      'tok',
      MPAN,
      'A-OLD',
      acctWith(MPAN),
    );
    // A-OLD (primary) + A-NEW both list the meter; A-OTHER does not.
    expect(res.accountsWithMeter).toBe(2);
    expect(res.accountsUsedForStatements).toBe(2);
    expect(res.unsafeAccountsWithMeter).toBe(0);
    expect(res.statements.map((s) => s.id).sort()).toEqual([1, 2]);
  });

  it('uses only the primary account when account discovery fails (no regression)', async () => {
    globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
      const u = new URL(url.toString());
      if (u.pathname.includes('/graphql/')) {
        const body = JSON.parse(opts?.body ?? '{}');
        const q: string = body.query ?? '';
        if (q.includes('viewer')) throw new Error('viewer not permitted');
        if (q.includes('Statements')) {
          return jsonResp({ data: { account: { ledgers: [ledger([stmt(1)], false)] } } });
        }
      }
      throw new Error('unhandled ' + u.pathname);
    }) as unknown as typeof fetch;

    const res = await fetchStatementsForMpan(
      createClient('k'),
      'tok',
      MPAN,
      'A-OLD',
      acctWith(MPAN),
    );
    expect(res.accountsWithMeter).toBe(1);
    expect(res.accountsUsedForStatements).toBe(1);
    expect(res.unsafeAccountsWithMeter).toBe(0);
    expect(res.statements.map((s) => s.id)).toEqual([1]);
  });

  it('does NOT merge an additional account that also bills another meter (no mixing)', async () => {
    const acctWithMeters = (mpans: string[]): AccountData =>
      ({
        number: 'n',
        properties: [
          {
            electricity_meter_points: mpans.map((m) => ({
              mpan: m,
              meters: [{ serial_number: 'S' }],
              agreements: [],
            })),
          },
        ],
      }) as unknown as AccountData;

    globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
      const u = new URL(url.toString());
      if (u.pathname.includes('/graphql/')) {
        const body = JSON.parse(opts?.body ?? '{}');
        const q: string = body.query ?? '';
        if (q.includes('viewer')) {
          return jsonResp({
            data: { viewer: { accounts: [{ number: 'A-OLD' }, { number: 'A-MULTI' }] } },
          });
        }
        if (q.includes('Statements')) {
          const id = body.variables?.accountNumber === 'A-OLD' ? 1 : 2;
          return jsonResp({ data: { account: { ledgers: [ledger([stmt(id)], false)] } } });
        }
      }
      if (u.pathname.includes('/accounts/')) {
        return jsonResp(acctWithMeters([MPAN, '9999999999999'])); // target + a second meter
      }
      throw new Error('unhandled ' + u.pathname);
    }) as unknown as typeof fetch;

    const res = await fetchStatementsForMpan(
      createClient('k'),
      'tok',
      MPAN,
      'A-OLD',
      acctWith(MPAN),
    );
    expect(res.accountsWithMeter).toBe(2); // A-MULTI lists the MPAN but is unsafe to use
    expect(res.accountsUsedForStatements).toBe(1);
    expect(res.unsafeAccountsWithMeter).toBe(1);
    expect(res.statements.map((s) => s.id)).toEqual([1]);
  });

  it('does not use primary account statements when the primary also bills another meter', async () => {
    const primary: AccountData = {
      number: 'A-MULTI',
      properties: [
        {
          postcode: 'AB1 2CD',
          electricity_meter_points: [
            { mpan: MPAN, meters: [{ serial_number: 'S1' }], agreements: [] },
            { mpan: '9999999999999', meters: [{ serial_number: 'S2' }], agreements: [] },
          ],
        },
      ],
    } as unknown as AccountData;
    let statementFetches = 0;
    globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
      const u = new URL(url.toString());
      if (u.pathname.includes('/graphql/')) {
        const body = JSON.parse(opts?.body ?? '{}');
        const q: string = body.query ?? '';
        if (q.includes('viewer')) {
          return jsonResp({ data: { viewer: { accounts: [{ number: 'A-MULTI' }] } } });
        }
        if (q.includes('Statements')) {
          statementFetches++;
          return jsonResp({ data: { account: { ledgers: [ledger([stmt(1)], false)] } } });
        }
      }
      throw new Error('unhandled ' + u.pathname);
    }) as unknown as typeof fetch;

    const res = await fetchStatementsForMpan(createClient('k'), 'tok', MPAN, 'A-MULTI', primary);

    expect(statementFetches).toBe(0);
    expect(res.accountsWithMeter).toBe(1);
    expect(res.accountsUsedForStatements).toBe(0);
    expect(res.unsafeAccountsWithMeter).toBe(1);
    expect(res.statements).toEqual([]);
  });
});
