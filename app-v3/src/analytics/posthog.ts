const PH_KEY = 'phc_BWYdViiVQJGut9XjZiCbjDGRsPixaJgZQLnVFyJpi5Jt';
export const POSTHOG_CAPTURE_URL = 'https://eu.i.posthog.com/capture/';

let distinctId: string | null = null;

function getDistinctId(): string {
  if (distinctId) return distinctId;
  const cryptoApi = globalThis.crypto;
  distinctId =
    typeof cryptoApi?.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : `otc-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  return distinctId;
}

function outwardCode(value: string | null): string | null {
  if (value === null) return null;
  const normalised = value.trim().toUpperCase();
  if (!normalised || /\s/.test(normalised)) return null;
  return /^(?:GIR|[A-Z]{1,2}\d[A-Z\d]?)$/.test(normalised) ? normalised : null;
}

type EventProperties = Record<string, string | number | boolean | null>;

async function capture(event: string, properties: EventProperties): Promise<void> {
  try {
    await fetch(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: PH_KEY,
        event,
        properties: {
          ...properties,
          distinct_id: getDistinctId(),
        },
      }),
    });
  } catch {
    /* analytics must never affect the comparison journey */
  }
}

export interface ComparisonSuccessProps {
  outwardCode: string | null;
  // Signed: positive = the alternative (Agile) was cheaper, negative = dearer.
  pctSaved: number | null;
  kwhTotal: number;
  periodDays: number;
}

export function trackComparisonSuccess(props: ComparisonSuccessProps): Promise<void> {
  return capture('comparison_complete', {
    outward_code: outwardCode(props.outwardCode),
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

export function trackComparisonFailure(props: ComparisonFailureProps): Promise<void> {
  return capture('comparison_failed', {
    error_type: props.errorType,
    http_status: props.httpStatus,
    cors_likely: props.corsLikely,
    stage: props.stage,
  });
}

// Exported only for unit tests; production sessions keep a fresh per-page id.
export function _resetForTest(): void {
  distinctId = null;
}
