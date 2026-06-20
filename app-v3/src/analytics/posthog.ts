// PostHog analytics wrapper — only fires when the user has opted in.
// Autocapture and session recording are explicitly disabled at init; the only
// events that ever fire are the two named exports below.
import posthog from 'posthog-js';

const PH_KEY = 'phc_BWYdViiVQJGut9XjZiCbjDGRsPixaJgZQLnVFyJpi5Jt';
const PH_HOST = 'https://eu.i.posthog.com';

let active = false;

export function initAnalytics(): void {
  if (active) return;
  active = true;
  posthog.init(PH_KEY, {
    api_host: PH_HOST,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    // No cookies, no localStorage writes — PostHog uses a fresh random distinct_id
    // per session so individual sessions cannot be correlated across visits.
    persistence: 'memory',
  });
}

export interface ComparisonSuccessProps {
  outwardCode: string | null;
  // Signed: positive = the alternative (Agile) was cheaper, negative = dearer.
  pctSaved: number | null;
  kwhTotal: number;
  periodDays: number;
}

export function trackComparisonSuccess(props: ComparisonSuccessProps): void {
  if (!active) return;
  posthog.capture('comparison_complete', {
    outward_code: props.outwardCode,
    pct_saved: props.pctSaved !== null ? Math.round(props.pctSaved * 10) / 10 : null,
    kwh_total: Math.round(props.kwhTotal),
    period_days: Math.round(props.periodDays),
  });
}

export interface ComparisonFailureProps {
  errorType: string;
  httpStatus: number | null;
  corsLikely: boolean;
  // Which stage of the live journey failed: 'auth' (account discovery) or
  // 'fetch' (reading meter data + running the comparison).
  stage: 'auth' | 'fetch';
}

export function trackComparisonFailure(props: ComparisonFailureProps): void {
  if (!active) return;
  posthog.capture('comparison_failed', {
    error_type: props.errorType,
    http_status: props.httpStatus,
    cors_likely: props.corsLikely,
    stage: props.stage,
  });
}

// Exported only for unit tests — resets module state between test cases.
export function _resetForTest(): void {
  active = false;
}
