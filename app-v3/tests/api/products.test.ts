import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '../../src/api/client';
import {
  fetchCurrentTariffRates,
  fetchMergedRateWindows,
  fetchProductTariffCode,
  findFlatOutgoingProducts,
  findProductsByDisplayNameOverlapping,
} from '../../src/api/products';
import type { DiscoveredProduct } from '../../src/types/octopus';

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

function errorResp(status: number, body = ''): Response {
  return {
    ok: false,
    status,
    json: async () => JSON.parse(body || '{}'),
    text: async () => body,
  } as unknown as Response;
}

const periodFrom = new Date('2025-01-01T00:00:00Z');
const periodTo = new Date('2025-01-02T00:00:00Z');

const rateRow = (value: number, from = periodFrom, to: Date | null = null) => ({
  value_inc_vat: value,
  valid_from: from.toISOString(),
  valid_to: to?.toISOString() ?? null,
  payment_method: 'DIRECT_DEBIT',
});

describe('fetchProductTariffCode', () => {
  it('requests the Octopus origin (NOT a same-origin path) and returns the region tariff code', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(url.toString());
      return jsonResp({
        single_register_electricity_tariffs: {
          _C: { direct_debit_monthly: { code: 'E-1R-VAR-22-11-01-C' } },
        },
      });
    }) as unknown as typeof fetch;

    const code = await fetchProductTariffCode(createClient('k'), 'FLEX', 'C');
    expect(code).toBe('E-1R-VAR-22-11-01-C');
    // Regression guard: a relative '/products/...' would be CSP-blocked same-origin.
    expect(urls[0]).toMatch(/^https:\/\/api\.octopus\.energy\/v1\/products\/FLEX\//);
  });

  it('returns null when the region has no tariffs', async () => {
    globalThis.fetch = (async () =>
      jsonResp({ single_register_electricity_tariffs: {} })) as unknown as typeof fetch;
    expect(await fetchProductTariffCode(createClient('k'), 'X', 'C')).toBeNull();
  });
});

describe('fetchCurrentTariffRates', () => {
  it('returns flat/single-register current tariff rates when no night endpoint exists', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(url.toString()).pathname;
      if (path.includes('standard-unit-rates')) return jsonResp({ results: [rateRow(24)] });
      if (path.includes('standing-charges')) return jsonResp({ results: [rateRow(45)] });
      if (path.includes('night-unit-rates')) return errorResp(404, 'not found');
      throw new Error('Unhandled: ' + path);
    }) as unknown as typeof fetch;

    const result = await fetchCurrentTariffRates(
      createClient('k'),
      'E-1R-FIX-12M-23-C',
      periodFrom,
      periodTo,
    );

    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available rates');
    expect(result.rateShape).toBe('flat');
    expect(result.unitWindows).toHaveLength(1);
    expect(result.unitWindows[0]?.value).toBe(24);
    expect(result.standingWindows[0]?.value).toBe(45);
  });

  it('returns Go-style day/night rates for Go-like tariffs', async () => {
    const nightStart = new Date('2025-01-01T00:30:00Z');
    const nightEnd = new Date('2025-01-01T05:30:00Z');
    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(url.toString()).pathname;
      if (path.includes('standard-unit-rates')) return jsonResp({ results: [rateRow(31)] });
      if (path.includes('standing-charges')) return jsonResp({ results: [rateRow(45)] });
      if (path.includes('night-unit-rates')) {
        return jsonResp({ results: [rateRow(8, nightStart, nightEnd)] });
      }
      throw new Error('Unhandled: ' + path);
    }) as unknown as typeof fetch;

    const result = await fetchCurrentTariffRates(
      createClient('k'),
      'E-1R-GO-VAR-22-10-14-C',
      periodFrom,
      periodTo,
    );

    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available rates');
    expect(result.rateShape).toBe('go-day-night');
    expect(result.unitWindows.map((w) => w.value)).toEqual([31, 8, 31]);
  });

  it('fails closed for unsupported non-Go time-of-use tariffs', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(url.toString()).pathname;
      if (path.includes('standard-unit-rates')) return jsonResp({ results: [rateRow(31)] });
      if (path.includes('standing-charges')) return jsonResp({ results: [rateRow(45)] });
      if (path.includes('night-unit-rates')) return jsonResp({ results: [rateRow(12)] });
      throw new Error('Unhandled: ' + path);
    }) as unknown as typeof fetch;

    const result = await fetchCurrentTariffRates(
      createClient('k'),
      'E-1R-COSY-22-12-08-C',
      periodFrom,
      periodTo,
    );

    expect(result.status).toBe('unsupported');
    if (result.status !== 'unsupported') throw new Error('expected unsupported rates');
    expect(result.reason).toContain('Cosy');
    expect(result.reason).toContain('cannot model safely');
  });

  it('does not price a Go-like tariff when no night rates exist anywhere', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(url.toString()).pathname;
      if (path.includes('standard-unit-rates')) return jsonResp({ results: [rateRow(31)] });
      if (path.includes('standing-charges')) return jsonResp({ results: [rateRow(45)] });
      if (path.includes('night-unit-rates')) return jsonResp({ results: [] });
      // Products list returns empty — no live substitute available
      if (path === '/v1/products/') return jsonResp({ results: [], next: null });
      throw new Error('Unhandled: ' + path);
    }) as unknown as typeof fetch;

    const result = await fetchCurrentTariffRates(
      createClient('k'),
      'E-1R-INTELLI-VAR-22-10-14-C',
      periodFrom,
      periodTo,
    );

    expect(result.status).toBe('unavailable');
  });

  it('substitutes via display-name lookup when the account tariff has no night rates for the period', async () => {
    const nightStart = new Date('2025-01-01T00:30:00Z');
    const nightEnd = new Date('2025-01-01T05:30:00Z');
    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(url.toString()).pathname;
      // Old product night rates: empty (triggers fallback)
      if (path.includes('GO-VAR-22-10-14') && path.includes('night-unit-rates')) {
        return jsonResp({ results: [] });
      }
      // Products list (all available_at probes): return GO-24-10-01 as "Octopus Go"
      if (path === '/v1/products/') {
        return jsonResp({
          results: [
            {
              code: 'GO-24-10-01',
              display_name: 'Octopus Go',
              is_business: false,
              is_prepay: false,
              available_from: '2024-10-01T00:00:00Z',
              available_to: null,
            },
          ],
          next: null,
        });
      }
      // Tariff code lookup for GO-24-10-01 (called by fetchMergedRateWindows)
      if (path === '/v1/products/GO-24-10-01/') {
        return jsonResp({
          single_register_electricity_tariffs: {
            _C: { direct_debit_monthly: { code: 'E-1R-GO-24-10-01-C' } },
          },
        });
      }
      // Night rates for substitute product: present
      if (path.includes('GO-24-10-01') && path.includes('night-unit-rates')) {
        return jsonResp({ results: [rateRow(8, nightStart, nightEnd)] });
      }
      // All other rate endpoints (standard/standing for both products)
      if (path.includes('standard-unit-rates')) return jsonResp({ results: [rateRow(31)] });
      if (path.includes('standing-charges')) return jsonResp({ results: [rateRow(45)] });
      throw new Error('Unhandled: ' + path);
    }) as unknown as typeof fetch;

    const result = await fetchCurrentTariffRates(
      createClient('k'),
      'E-1R-GO-VAR-22-10-14-C',
      periodFrom,
      periodTo,
    );

    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available rates');
    expect(result.rateShape).toBe('go-day-night');
    expect(result.substitutionNote).toMatch(/GO-VAR-22-10-14/);
  });
});

describe('findFlatOutgoingProducts (historical fixed export coverage)', () => {
  // A pre-2024-10-28 window: the flat export is the FIXED "Outgoing Octopus 12M
  // Fixed"; there is no variable "Outgoing Octopus" yet.
  const oldFrom = new Date('2024-06-01T00:00:00Z');
  const oldTo = new Date('2024-07-01T00:00:00Z');
  const FIXED = {
    code: 'OUTGOING-FIX-12M-19-05-13',
    display_name: 'Outgoing Octopus 12M Fixed',
    is_variable: false,
    is_business: false,
    is_prepay: false,
    available_from: '2019-05-13T00:00:00Z',
    available_to: '2024-10-28T00:00:00Z',
  };
  const VARIABLE = {
    code: 'OUTGOING-VAR-24-10-26',
    display_name: 'Outgoing Octopus',
    is_variable: true,
    is_business: false,
    is_prepay: false,
    available_from: '2024-10-26T00:00:00Z',
    available_to: null,
  };
  // Mock the products endpoint, honouring the is_variable=true server filter.
  function mockProducts(): void {
    globalThis.fetch = (async (url: string | URL) => {
      const u = new URL(url.toString());
      const variableOnly = u.searchParams.get('is_variable') === 'true';
      const results = [FIXED, VARIABLE].filter((p) => !variableOnly || p.is_variable);
      return jsonResp({ results, next: null });
    }) as unknown as typeof fetch;
  }

  it('finds the historical FIXED flat export the variable-only lookup misses', async () => {
    mockProducts();
    const codes = (await findFlatOutgoingProducts(createClient('k'), oldFrom, oldTo)).map(
      (p) => p.code,
    );
    expect(codes).toContain('OUTGOING-FIX-12M-19-05-13');
  });

  it('the default (variable-only) lookup would NOT surface the fixed product (regression)', async () => {
    mockProducts();
    const codes = (
      await findProductsByDisplayNameOverlapping(
        createClient('k'),
        'Outgoing Octopus 12M Fixed',
        oldFrom,
        oldTo,
      )
    ).map((p) => p.code);
    expect(codes).not.toContain('OUTGOING-FIX-12M-19-05-13');
  });
});

describe('fetchMergedRateWindows', () => {
  it('clips a retired open-ended window to availability and reports rawCount', async () => {
    const T = '2024-06-01T00:00:00Z';
    globalThis.fetch = (async (url: string | URL) => {
      const u = new URL(url.toString());
      if (/\/products\/[^/]+\/$/.test(u.pathname)) {
        return jsonResp({
          single_register_electricity_tariffs: {
            _C: { direct_debit_monthly: { code: 'E-1R-OLD-C' } },
          },
        });
      }
      return jsonResp({
        results: [
          {
            value_inc_vat: 10,
            valid_from: '2020-01-01T00:00:00Z',
            valid_to: null,
            payment_method: null,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const products: DiscoveredProduct[] = [
      { code: 'OLD', available_from: '2020-01-01T00:00:00Z', available_to: T },
    ];
    const merged = await fetchMergedRateWindows(
      createClient('k'),
      products,
      'C',
      'standard-unit-rates',
      new Date('2023-01-01T00:00:00Z'),
      new Date('2025-01-01T00:00:00Z'),
    );
    expect(merged.rawCount).toBe(1);
    expect(merged.windows).toHaveLength(1);
    expect(merged.windows[0]?.validTo?.getTime()).toBe(new Date(T).getTime());
  });
});
