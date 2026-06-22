import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient } from '../../src/api/client';
import { runComparison } from '../../src/flows/runComparison';
import { runExportComparison } from '../../src/flows/runExportComparison';
import type { AccountData } from '../../src/types/octopus';

const FLEX = 'VAR-22-11-01';
const AGILE = 'AGILE-24-10-01';
const STEP = 30 * 60 * 1000;

function jsonResp(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// A statement ending exactly at the flow's data horizon (now − 7 days, UTC
// midnight — computed the same way the flow does) so the period aligns with the
// window: no clamping and no trailing unbilled period.
const winEnd = new Date();
winEnd.setDate(winEnd.getDate() - 7);
winEnd.setUTCHours(0, 0, 0, 0);
const winStart = new Date(winEnd);
winStart.setUTCDate(winStart.getUTCDate() - 30);

function consumptionRows(pf: Date, pt: Date, kwh: number): unknown[] {
  const rows: unknown[] = [];
  for (let t = pf.getTime(); t < pt.getTime(); t += STEP) {
    rows.push({
      interval_start: new Date(t).toISOString(),
      interval_end: new Date(t + STEP).toISOString(),
      consumption: kwh,
    });
  }
  return rows;
}

function importFetch(
  displayNames: { flex: string; agile: string } = {
    flex: 'Flexible Octopus',
    agile: 'Agile Octopus',
  },
  stmts: { start: Date; end: Date }[] = [{ start: winStart, end: winEnd }],
) {
  return async (url: string | URL, opts?: { body?: string }): Promise<Response> => {
    const u = new URL(url.toString());
    if (u.pathname.includes('/graphql/')) {
      const b = JSON.parse(opts?.body ?? '{}');
      if (b.query.includes('obtainKrakenToken')) {
        return jsonResp({ data: { obtainKrakenToken: { token: 't' } } });
      }
      if (b.query.includes('Statements')) {
        return jsonResp({
          data: {
            account: {
              ledgers: [
                {
                  statements: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    edges: stmts.map((s, i) => ({
                      node: {
                        id: i + 1,
                        startAt: s.start.toISOString(),
                        endAt: s.end.toISOString(),
                        totalCharges: { grossTotal: 12000 },
                        transactions: {
                          totalCount: 1,
                          pageInfo: { hasNextPage: false },
                          edges: [
                            {
                              node: {
                                __typename: 'BillCharge',
                                title: 'Electricity',
                                amounts: { gross: 12000 },
                                consumption: { quantity: 432 },
                              },
                            },
                          ],
                        },
                      },
                    })),
                  },
                },
              ],
            },
          },
        });
      }
      throw new Error('unexpected gql');
    }
    if (u.pathname.includes('/consumption/')) {
      const pf = new Date(u.searchParams.get('period_from') ?? winStart.toISOString());
      const pt = new Date(u.searchParams.get('period_to') ?? winEnd.toISOString());
      const rows = consumptionRows(pf, pt, 0.3);
      return jsonResp({ count: rows.length, next: null, results: rows });
    }
    if (u.pathname === '/v1/products/') {
      return jsonResp({
        count: 2,
        next: null,
        results: [
          {
            code: FLEX,
            display_name: displayNames.flex,
            is_business: false,
            is_prepay: false,
            available_to: null,
          },
          {
            code: AGILE,
            display_name: displayNames.agile,
            is_business: false,
            is_prepay: false,
            available_to: null,
          },
        ],
      });
    }
    if (/\/products\/[^/]+\/$/.test(u.pathname)) {
      const pc = u.pathname.split('/')[3];
      return jsonResp({
        code: pc,
        single_register_electricity_tariffs: {
          _C: {
            direct_debit_monthly: {
              code: pc === FLEX ? 'E-1R-VAR-22-11-01-C' : 'E-1R-AGILE-24-10-01-C',
            },
          },
        },
      });
    }
    if (u.pathname.includes('standard-unit-rates')) {
      if (u.pathname.includes(FLEX)) {
        return jsonResp({
          results: [
            {
              value_inc_vat: 25,
              valid_from: '2020-01-01T00:00:00Z',
              valid_to: null,
              payment_method: 'DIRECT_DEBIT',
            },
          ],
        });
      }
      const pf = new Date(u.searchParams.get('period_from') ?? winStart.toISOString());
      const pt = new Date(u.searchParams.get('period_to') ?? winEnd.toISOString());
      const rows: unknown[] = [];
      for (let t = pf.getTime(); t < pt.getTime(); t += STEP) {
        rows.push({
          value_inc_vat: 18,
          valid_from: new Date(t).toISOString(),
          valid_to: new Date(t + STEP).toISOString(),
          payment_method: null,
        });
      }
      return jsonResp({ results: rows });
    }
    if (u.pathname.includes('standing-charges')) {
      return jsonResp({
        results: [
          {
            value_inc_vat: 45,
            valid_from: '2020-01-01T00:00:00Z',
            valid_to: null,
            payment_method: 'DIRECT_DEBIT',
          },
        ],
      });
    }
    throw new Error('Unhandled: ' + u.pathname);
  };
}

const accountData: AccountData = {
  number: 'A-X',
  properties: [
    {
      postcode: 'AB1 2CD',
      electricity_meter_points: [
        {
          mpan: '1234567890123',
          gsp: '_C',
          is_export: false,
          meters: [{ serial_number: 'S1' }],
          agreements: [
            {
              tariff_code: 'E-1R-VAR-22-11-01-C',
              valid_from: '2023-01-01T00:00:00Z',
              valid_to: null,
            },
          ],
        },
      ],
    },
  ],
};

const input = {
  apiKey: 'sk_test_fakekey123',
  accountNumber: 'A-X',
  mpan: '1234567890123',
  serial: 'S1',
  serials: ['S1'],
  accountData,
};

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('runComparison (end-to-end, mocked fetch)', () => {
  beforeEach(() => {
    globalThis.fetch = importFetch() as unknown as typeof fetch;
  });

  it('produces one confident period with the expected Flexible/Agile totals', async () => {
    const run = await runComparison(createClient(input.apiKey), input);
    expect(run.periods).toHaveLength(1);
    const p = run.periods[0];
    if (!p) throw new Error('expected exactly one period');
    expect(p.isSplit).toBe(false);
    expect(p.wasClamped).toBe(false);
    expect(p.flex.kwh).toBeCloseTo(432, 3);
    expect(p.flex.energyCostPence).toBeCloseTo(432 * 25, 2);
    expect(p.flex.standingChargePence).toBe(30 * 45);
    expect(p.agile?.energyCostPence).toBeCloseTo(432 * 18, 2);
    expect(p.actualChargePence).toBe(12000);
    expect(p.confident).toBe(true);
    expect(run.context.agileAvailable).toBe(true);
    expect(run.context.statementValidation[0]?.mismatch).toBe(false);
    expect(run.detail.readings.length).toBe(30 * 48);
    // Statement aligns with the window → no trailing unbilled period.
    expect(run.context.readingsBeyondStatements).toBe(false);
  });

  it('compares usage past the last bill as a trailing period with no actual paid', async () => {
    // Statement ends ~20 days ago, but readings run to the ~7-day horizon — the
    // newer ~13 days must still be compared (Flexible/Agile), with actual = null.
    const stmtEnd = new Date();
    stmtEnd.setDate(stmtEnd.getDate() - 20);
    stmtEnd.setUTCHours(0, 0, 0, 0);
    const stmtStart = new Date(stmtEnd);
    stmtStart.setUTCDate(stmtStart.getUTCDate() - 30);
    globalThis.fetch = importFetch(undefined, [
      { start: stmtStart, end: stmtEnd },
    ]) as unknown as typeof fetch;

    const run = await runComparison(createClient(input.apiKey), input);

    expect(run.periods.length).toBe(2);
    const billed = run.periods[0];
    const tail = run.periods[1];
    if (!billed || !tail) throw new Error('expected billed + tail periods');
    expect(billed.actualChargePence).toBe(12000); // the real bill
    expect(tail.actualChargePence).toBeNull(); // no bill covers the recent weeks
    expect(tail.flex.kwh).toBeGreaterThan(0); // but the usage IS compared
    expect(tail.agile?.totalPence).toBeGreaterThan(0);
    expect(run.context.readingsBeyondStatements).toBe(true);
    expect(run.context.latestStatementEnd?.getTime()).toBe(stmtEnd.getTime());
  });

  it('fills a gap BETWEEN non-adjacent statements so that usage is not dropped', async () => {
    // Two statements with a ~10-day hole between them; the newer one ends at the
    // horizon (so no trailing tail). The hole's usage must still be compared.
    const horizon = new Date();
    horizon.setDate(horizon.getDate() - 7);
    horizon.setUTCHours(0, 0, 0, 0);
    const s2Start = new Date(horizon);
    s2Start.setUTCDate(s2Start.getUTCDate() - 15);
    const s1End = new Date(horizon);
    s1End.setUTCDate(s1End.getUTCDate() - 25); // 10-day gap before s2Start
    const s1Start = new Date(horizon);
    s1Start.setUTCDate(s1Start.getUTCDate() - 40);
    globalThis.fetch = importFetch(undefined, [
      { start: s1Start, end: s1End },
      { start: s2Start, end: horizon },
    ]) as unknown as typeof fetch;

    const run = await runComparison(createClient(input.apiKey), input);

    expect(run.periods.length).toBe(3); // two bills + one synthetic gap period
    const unbilled = run.periods.filter((p) => p.actualChargePence === null);
    expect(unbilled).toHaveLength(1);
    expect(unbilled[0]?.flex.kwh).toBeGreaterThan(0); // the gap's usage IS priced
    expect(run.context.readingsBeyondStatements).toBe(false); // newest bill reaches the horizon
  });

  it('adds no trailing period (and no note) when readings end within a day of the last bill', async () => {
    // Statement ends ~12h before the horizon → the sub-day remainder is below the
    // 1-day threshold, so no tail and readingsBeyondStatements stays false.
    const stmtEnd = new Date();
    stmtEnd.setDate(stmtEnd.getDate() - 8);
    stmtEnd.setUTCHours(12, 0, 0, 0); // 12h before the (next-day midnight) horizon
    const stmtStart = new Date(stmtEnd);
    stmtStart.setUTCDate(stmtStart.getUTCDate() - 30);
    globalThis.fetch = importFetch(undefined, [
      { start: stmtStart, end: stmtEnd },
    ]) as unknown as typeof fetch;

    const run = await runComparison(createClient(input.apiKey), input);
    expect(run.context.readingsBeyondStatements).toBe(false);
    expect(run.periods.every((p) => p.actualChargePence !== null)).toBe(true);
  });

  it('still errors when a safely attributable account has no statements', async () => {
    globalThis.fetch = importFetch(undefined, []) as unknown as typeof fetch;

    await expect(runComparison(createClient(input.apiKey), input)).rejects.toThrow(
      'No statements found on this account',
    );
  });

  it('uses Flexible proxy with a caveat for unsupported current ToU tariff shapes', async () => {
    const COSY = 'E-1R-COSY-22-12-08-C';
    const baseFetch = importFetch();
    globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
      const u = new URL(url.toString());
      if (u.pathname.includes(COSY) && u.pathname.includes('night-unit-rates')) {
        return jsonResp({
          results: [
            {
              value_inc_vat: 12,
              valid_from: winStart.toISOString(),
              valid_to: winEnd.toISOString(),
              payment_method: 'DIRECT_DEBIT',
            },
          ],
        });
      }
      return baseFetch(url, opts);
    }) as unknown as typeof fetch;
    const cosyAccountData: AccountData = {
      number: 'A-X',
      properties: [
        {
          postcode: 'AB1 2CD',
          electricity_meter_points: [
            {
              mpan: '1234567890123',
              gsp: '_C',
              is_export: false,
              meters: [{ serial_number: 'S1' }],
              agreements: [
                {
                  tariff_code: COSY,
                  valid_from: '2023-01-01T00:00:00Z',
                  valid_to: null,
                },
              ],
            },
          ],
        },
      ],
    };

    const run = await runComparison(createClient(input.apiKey), {
      ...input,
      accountData: cosyAccountData,
    });

    expect(run.context.flexNote).toContain('Cosy has time-of-use rates');
    expect(run.context.flexColumnSource).toMatchObject({
      kind: 'flexible-proxy',
      actualTariffLabel: 'Cosy',
      actualTariffCode: COSY,
    });
  });

  it('marks statement attribution partial when an unsafe sibling account is excluded', async () => {
    const baseFetch = importFetch();
    const multiMpanAccountData: AccountData = {
      number: 'A-MULTI',
      properties: [
        {
          postcode: 'AB1 2CD',
          electricity_meter_points: [
            {
              mpan: '1234567890123',
              gsp: '_C',
              is_export: false,
              meters: [{ serial_number: 'S1' }],
              agreements: [
                {
                  tariff_code: 'E-1R-VAR-22-11-01-C',
                  valid_from: '2023-01-01T00:00:00Z',
                  valid_to: null,
                },
              ],
            },
            {
              mpan: '9999999999999',
              gsp: '_C',
              is_export: false,
              meters: [{ serial_number: 'S2' }],
              agreements: [
                {
                  tariff_code: 'E-1R-VAR-22-11-01-C',
                  valid_from: '2023-01-01T00:00:00Z',
                  valid_to: null,
                },
              ],
            },
          ],
        },
      ],
    };
    globalThis.fetch = (async (url: string | URL, opts?: { body?: string }) => {
      const u = new URL(url.toString());
      if (u.pathname.includes('/graphql/')) {
        const b = JSON.parse(opts?.body ?? '{}');
        if (String(b.query).includes('viewer')) {
          return jsonResp({
            data: {
              viewer: {
                accounts: [{ number: 'A-X' }, { number: 'A-MULTI' }],
              },
            },
          });
        }
      }
      if (u.pathname === '/v1/accounts/A-MULTI/') {
        return jsonResp(multiMpanAccountData);
      }
      return baseFetch(url, opts);
    }) as unknown as typeof fetch;

    const run = await runComparison(createClient(input.apiKey), input);

    expect(run.context.statementAttribution).toMatchObject({
      mode: 'partial-statements-unsafe-multi-mpan',
      accountsWithMeter: 2,
      accountsUsedForStatements: 1,
      unsafeAccountsWithMeter: 1,
    });
    expect(run.context.statementValidation.length).toBeGreaterThan(0);
    expect(run.periods.some((p) => p.actualChargePence !== null)).toBe(true);
  });

  it('falls back to estimate-only when primary statements cannot be attributed to one MPAN', async () => {
    const multiMpanAccountData: AccountData = {
      number: 'A-X',
      properties: [
        {
          postcode: 'AB1 2CD',
          electricity_meter_points: [
            {
              mpan: '1234567890123',
              gsp: '_C',
              is_export: false,
              meters: [{ serial_number: 'S1' }],
              agreements: [
                {
                  tariff_code: 'E-1R-VAR-22-11-01-C',
                  valid_from: '2023-01-01T00:00:00Z',
                  valid_to: null,
                },
              ],
            },
            {
              mpan: '9999999999999',
              gsp: '_C',
              is_export: false,
              meters: [{ serial_number: 'S2' }],
              agreements: [
                {
                  tariff_code: 'E-1R-VAR-22-11-01-C',
                  valid_from: '2023-01-01T00:00:00Z',
                  valid_to: null,
                },
              ],
            },
          ],
        },
      ],
    };

    const run = await runComparison(createClient(input.apiKey), {
      ...input,
      accountData: multiMpanAccountData,
    });

    expect(run.context.statementAttribution).toMatchObject({
      mode: 'estimate-only-unsafe-multi-mpan',
      accountsWithMeter: 1,
      accountsUsedForStatements: 0,
      unsafeAccountsWithMeter: 1,
    });
    expect(run.context.statementValidation).toEqual([]);
    expect(run.periods.length).toBeGreaterThan(0);
    expect(run.periods.every((p) => p.actualChargePence === null)).toBe(true);
  });
});

describe('runExportComparison (end-to-end, mocked fetch)', () => {
  beforeEach(() => {
    globalThis.fetch = importFetch({
      flex: 'Outgoing Octopus',
      agile: 'Agile Outgoing Octopus',
    }) as unknown as typeof fetch;
  });

  it('values exported energy under both export tariffs, no standing charge', async () => {
    const run = await runExportComparison(createClient(input.apiKey), {
      ...input,
      isExport: true,
    } as never);
    expect(run.exportKwh).toBeGreaterThan(0);
    expect(run.flat?.valuePence).toBeCloseTo(run.exportKwh * 25, 1);
    expect(run.agile?.valuePence).toBeCloseTo(run.exportKwh * 18, 1);
    // No standing-charge concept on the export model at all.
    expect(run).not.toHaveProperty('standingChargePence');
  });

  it('uses the in-force export agreement rather than a future open-ended one', async () => {
    const exportAccountData: AccountData = {
      number: 'A-X',
      properties: [
        {
          postcode: 'AB1 2CD',
          electricity_meter_points: [
            {
              mpan: '1234567890123',
              gsp: '_C',
              is_export: true,
              meters: [{ serial_number: 'S1' }],
              agreements: [
                {
                  tariff_code: 'E-1R-AGILE-OUTGOING-19-05-13-C',
                  valid_from: '2025-01-01T00:00:00Z',
                  valid_to: '2099-01-01T00:00:00Z',
                },
                {
                  tariff_code: 'E-1R-OUTGOING-FIX-12M-19-05-13-C',
                  valid_from: '2099-01-01T00:00:00Z',
                  valid_to: null,
                },
              ],
            },
          ],
        },
      ],
    };

    const run = await runExportComparison(createClient(input.apiKey), {
      ...input,
      accountData: exportAccountData,
    });

    expect(run.currentAgreement?.tariff_code).toBe('E-1R-AGILE-OUTGOING-19-05-13-C');
  });
});
