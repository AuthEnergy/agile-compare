import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '../../src/api/client';
import { fetchMergedRateWindows, fetchProductTariffCode } from '../../src/api/products';
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
