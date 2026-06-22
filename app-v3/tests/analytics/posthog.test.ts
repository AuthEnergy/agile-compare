import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTest,
  POSTHOG_CAPTURE_URL,
  trackComparisonFailure,
  trackComparisonSuccess,
} from '../../src/analytics/posthog';

const origFetch = globalThis.fetch;

interface SeenRequest {
  url: string;
  init: RequestInit;
}

let seen: SeenRequest[] = [];

function mockFetch(): void {
  seen = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: url.toString(), init: init ?? {} });
    return { ok: true } as Response;
  }) as typeof fetch;
}

function bodyAt(index: number): {
  api_key?: string;
  event?: string;
  properties?: Record<string, unknown>;
} {
  const req = seen[index];
  assert(req !== undefined);
  expect(typeof req.init.body).toBe('string');
  return JSON.parse(String(req.init.body)) as {
    api_key?: string;
    event?: string;
    properties?: Record<string, unknown>;
  };
}

beforeEach(() => {
  _resetForTest();
  mockFetch();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = '';
});

afterEach(() => {
  _resetForTest();
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe('PostHog direct capture', () => {
  it('sends comparison_complete with only the approved app properties', async () => {
    await trackComparisonSuccess({
      outwardCode: 'sw1',
      pctSaved: 12.54,
      kwhTotal: 523.4,
      periodDays: 30.6,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(POSTHOG_CAPTURE_URL);
    expect(seen[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    });
    const body = bodyAt(0);
    expect(body.api_key).toMatch(/^phc_/);
    expect(body.event).toBe('comparison_complete');
    expect(body.properties).toEqual({
      outward_code: 'SW1',
      pct_saved: 12.5,
      kwh_total: 523,
      period_days: 31,
      distinct_id: expect.any(String),
    });
  });

  it('drops invalid or full postcode values before capture', async () => {
    await trackComparisonSuccess({
      outwardCode: 'SW1A 1AA',
      pctSaved: null,
      kwhTotal: 300,
      periodDays: 28,
    });

    expect(bodyAt(0).properties?.['outward_code']).toBeNull();
  });

  it('sends comparison_failed with the narrow failure shape', async () => {
    await trackComparisonFailure({
      errorType: 'OctopusApiError',
      httpStatus: 401,
      corsLikely: false,
      stage: 'auth',
      progressLast: 'Fetching statements…',
      tariffKind: 'go',
    });

    const body = bodyAt(0);
    expect(body.event).toBe('comparison_failed');
    expect(body.properties).toEqual({
      error_type: 'OctopusApiError',
      http_status: 401,
      cors_likely: false,
      stage: 'auth',
      progress_last: 'Fetching statements…',
      tariff_kind: 'go',
      distinct_id: expect.any(String),
    });
  });

  it('uses one ephemeral distinct id for the current page only', async () => {
    await trackComparisonSuccess({ outwardCode: 'N1', pctSaved: 5, kwhTotal: 200, periodDays: 31 });
    await trackComparisonFailure({
      errorType: 'TypeError',
      httpStatus: null,
      corsLikely: true,
      stage: 'fetch',
      progressLast: null,
      tariffKind: null,
    });

    expect(bodyAt(0).properties?.['distinct_id']).toBe(bodyAt(1).properties?.['distinct_id']);
    expect(bodyAt(1).properties?.['progress_last']).toBeNull();
    expect(bodyAt(1).properties?.['tariff_kind']).toBeNull();
  });

  it('does not create PostHog browser storage', async () => {
    await trackComparisonSuccess({ outwardCode: null, pctSaved: null, kwhTotal: 0, periodDays: 0 });

    expect(Object.keys(localStorage).filter((k) => k.toLowerCase().includes('posthog'))).toEqual(
      [],
    );
    expect(Object.keys(sessionStorage).filter((k) => k.toLowerCase().includes('posthog'))).toEqual(
      [],
    );
    expect(document.cookie.toLowerCase()).not.toContain('posthog');
  });
});
