import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the posthog-js module before importing our wrapper.
vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
  },
}));

import {
  _resetForTest,
  initAnalytics,
  trackComparisonFailure,
  trackComparisonSuccess,
} from '../../src/analytics/posthog';
import posthog from 'posthog-js';

// vi.mocked preserves the shape while adding Mock methods.
const mockInit = vi.mocked(posthog.init);
const mockCapture = vi.mocked(posthog.capture);

beforeEach(() => {
  _resetForTest();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetForTest();
});

describe('analytics — when consent has not been given', () => {
  it('does not call posthog.capture for success events', () => {
    trackComparisonSuccess({ outwardCode: 'SW1', pctSaved: 10, kwhTotal: 500, periodDays: 30 });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('does not call posthog.capture for failure events', () => {
    trackComparisonFailure({
      errorType: 'NetworkError',
      httpStatus: null,
      corsLikely: false,
      stage: 'auth',
      progressLast: null,
      tariffKind: null,
    });
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('initAnalytics', () => {
  it('calls posthog.init with autocapture and session recording disabled', () => {
    initAnalytics();
    expect(mockInit).toHaveBeenCalledOnce();
    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
        persistence: 'memory',
      }),
    );
  });

  it('calls posthog.init with the EU host', () => {
    initAnalytics();
    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ api_host: 'https://eu.i.posthog.com' }),
    );
  });

  it('only calls posthog.init once even when called multiple times', () => {
    initAnalytics();
    initAnalytics();
    expect(mockInit).toHaveBeenCalledOnce();
  });
});

describe('trackComparisonSuccess', () => {
  beforeEach(() => {
    initAnalytics();
  });

  it('fires comparison_complete with correct property names', () => {
    trackComparisonSuccess({ outwardCode: 'SW1', pctSaved: 12.5, kwhTotal: 523.4, periodDays: 31 });
    expect(mockCapture).toHaveBeenCalledWith('comparison_complete', {
      outward_code: 'SW1',
      pct_saved: 12.5,
      kwh_total: 523,
      period_days: 31,
    });
  });

  it('rounds kwh_total and period_days to integers', () => {
    trackComparisonSuccess({ outwardCode: 'N1', pctSaved: 5, kwhTotal: 199.9, periodDays: 30.9 });
    const call = mockCapture.mock.calls[0];
    assert(call !== undefined);
    const props = call[1] as Record<string, unknown>;
    expect(props['kwh_total']).toBe(200);
    expect(props['period_days']).toBe(31);
  });

  it('passes null outward_code when unavailable', () => {
    trackComparisonSuccess({ outwardCode: null, pctSaved: null, kwhTotal: 300, periodDays: 28 });
    const call = mockCapture.mock.calls[0];
    assert(call !== undefined);
    const props = call[1] as Record<string, unknown>;
    expect(props['outward_code']).toBeNull();
    expect(props['pct_saved']).toBeNull();
  });
});

describe('trackComparisonFailure', () => {
  beforeEach(() => {
    initAnalytics();
  });

  it('fires comparison_failed with correct property names', () => {
    trackComparisonFailure({
      errorType: 'OctopusApiError',
      httpStatus: 401,
      corsLikely: false,
      stage: 'auth',
      progressLast: 'Fetching statements…',
      tariffKind: 'go',
    });
    expect(mockCapture).toHaveBeenCalledWith('comparison_failed', {
      error_type: 'OctopusApiError',
      http_status: 401,
      cors_likely: false,
      stage: 'auth',
      progress_last: 'Fetching statements…',
      tariff_kind: 'go',
    });
  });

  it('accepts "fetch" as a stage value and passes nulls through', () => {
    trackComparisonFailure({
      errorType: 'TypeError',
      httpStatus: null,
      corsLikely: true,
      stage: 'fetch',
      progressLast: null,
      tariffKind: null,
    });
    const call = mockCapture.mock.calls[0];
    assert(call !== undefined);
    const props = call[1] as Record<string, unknown>;
    expect(props['stage']).toBe('fetch');
    expect(props['progress_last']).toBeNull();
    expect(props['tariff_kind']).toBeNull();
  });
});
