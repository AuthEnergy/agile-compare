import { describe, it, expect, afterEach } from 'vitest';
import { createClient, OctopusApiError } from '../../src/api/client';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('createClient', () => {
  it('restGet builds the full Octopus URL with Basic auth and query params', async () => {
    let seenUrl = '';
    let seenAuth = '';
    globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      seenUrl = url.toString();
      seenAuth = init?.headers?.['Authorization'] ?? '';
      return jsonResp({ ok: true });
    }) as unknown as typeof fetch;

    await createClient('mykey').restGet('/products/', { brand: 'OCTOPUS_ENERGY', skip: null });
    expect(seenUrl).toBe('https://api.octopus.energy/v1/products/?brand=OCTOPUS_ENERGY');
    expect(seenAuth).toBe('Basic ' + btoa('mykey:'));
  });

  it('restGetAllPages follows the `next` link and concatenates results', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = url.toString();
      if (!u.includes('page=2')) {
        return jsonResp({ results: [1, 2], next: 'https://api.octopus.energy/v1/x/?page=2' });
      }
      return jsonResp({ results: [3], next: null });
    }) as unknown as typeof fetch;

    const all = await createClient('k').restGetAllPages<number>('/x/');
    expect(all).toEqual([1, 2, 3]);
  });

  it('throws instead of silently truncating when REST pagination exceeds the page cap', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResp({
        results: [calls],
        next: 'https://api.octopus.energy/v1/x/?page=next',
      });
    }) as unknown as typeof fetch;

    let err: unknown;
    try {
      await createClient('k').restGetAllPages<number>('/x/');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OctopusApiError);
    expect(err instanceof Error ? err.message : '').toBe(
      'Octopus API pagination exceeded 50 pages for a REST list response.',
    );
    expect(err instanceof Error ? err.message : '').not.toContain('/x/');
    expect(calls).toBe(50);
  });

  it('graphqlRequest throws an OctopusApiError on GraphQL errors', async () => {
    globalThis.fetch = (async () =>
      jsonResp({ errors: [{ message: 'boom' }] })) as unknown as typeof fetch;
    await expect(createClient('k').graphqlRequest('query {}')).rejects.toBeInstanceOf(
      OctopusApiError,
    );
  });

  it('wraps a network failure as a CORS-likely error', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(createClient('k').restGet('/x/')).rejects.toMatchObject({ corsLikely: true });
  });

  const noSleep = { sleep: () => Promise.resolve() };

  it('retries on 429 and then succeeds (rate-limit resilience)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 3 ? jsonResp({}, 429) : jsonResp({ results: [7], next: null });
    }) as unknown as typeof fetch;

    const all = await createClient('k', noSleep).restGetAllPages<number>('/x/');
    expect(calls).toBe(3);
    expect(all).toEqual([7]);
  });

  it('gives up after MAX attempts on a persistent 5xx and throws the status', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResp({}, 503);
    }) as unknown as typeof fetch;

    await expect(createClient('k', noSleep).restGet('/x/')).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(4);
  });

  it('does NOT retry a 4xx (a real answer, not a transient failure)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResp({}, 404);
    }) as unknown as typeof fetch;

    await expect(createClient('k', noSleep).restGet('/x/')).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(1);
  });
});
