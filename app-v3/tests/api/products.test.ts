import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '../../src/api/client';
import {
  fetchCurrentTariffRates,
  fetchMergedRateWindows,
  fetchProductTariffCode,
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

  it('does not price a Go-like tariff without night rates', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(url.toString()).pathname;
      if (path.includes('standard-unit-rates')) return jsonResp({ results: [rateRow(31)] });
      if (path.includes('standing-charges')) return jsonResp({ results: [rateRow(45)] });
      if (path.includes('night-unit-rates')) return jsonResp({ results: [] });
      throw new Error('Unhandled: ' + path);
    }) as unknown as typeof fetch;

    const result = await fetchCurrentTariffRates(
      createClient('k'),
      'E-1R-INTELLI-VAR-22-10-14-C',
      periodFrom,
      periodTo,
    );

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable rates');
    expect(result.reason).toContain('night rates');
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
