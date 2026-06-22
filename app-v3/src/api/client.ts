import type { Page } from '../types/octopus';

export interface ApiErrorOptions {
  corsLikely?: boolean;
  status?: number | null;
  body?: string | null;
}

export class OctopusApiError extends Error {
  readonly corsLikely: boolean;
  readonly status: number | null;
  readonly body: string | null;
  constructor(message: string, opts: ApiErrorOptions = {}) {
    super(message);
    this.name = 'OctopusApiError';
    this.corsLikely = opts.corsLikely ?? false;
    this.status = opts.status ?? null;
    this.body = opts.body ?? null;
  }
}

const REST_BASE = 'https://api.octopus.energy/v1';
const GRAPHQL_URL = 'https://api.octopus.energy/v1/graphql/';
export const MAX_REST_PAGES = 50;

// Octopus rate-limits; a heavy run (a year of half-hourly Agile rates is ~17k
// rows / a dozen pages) can trip a 429. Without retry, one transient 429/5xx
// turns a recoverable blip into a total loss (e.g. Agile silently disabled for
// the whole comparison). Retry only on 429/5xx (never on a 4xx, which is a real
// answer) with capped exponential backoff, honouring Retry-After when present.
const MAX_ATTEMPTS = 4;
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;
const backoffMs = (attempt: number, resp: Response): number => {
  const retryAfter = Number(resp.headers?.get?.('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, 15_000)
    : Math.min(8_000, 300 * 2 ** (attempt - 1));
};

export type Params = Record<string, string | number | null | undefined>;

export interface OctopusClient {
  restGet<T = unknown>(path: string, params?: Params): Promise<T>;
  restGetAllPages<T = unknown>(path: string, params?: Params): Promise<T[]>;
  restGetRaw<T = unknown>(fullUrl: string): Promise<T>;
  graphqlRequest<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    token?: string | null,
  ): Promise<T>;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const CORS_MSG =
  'Network request failed before any response was received. This is almost always a CORS block ' +
  '(the browser refusing to let this page read api.octopus.energy’s response) or a connectivity issue. ' +
  'Check the browser console for the specific reason.';

// All Octopus access goes through a client holding the API key (no global state).
// `sleep` is injectable so tests exercise the retry path without real delays.
export function createClient(
  apiKey: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): OctopusClient {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const authHeader = (): Record<string, string> => ({
    Authorization: 'Basic ' + btoa(apiKey + ':'),
  });

  // Fetch with retry on 429/5xx; a network failure (CORS) is never retried.
  async function fetchWithRetry(doFetch: () => Promise<Response>, corsMessage: string) {
    for (let attempt = 1; ; attempt++) {
      let resp: Response;
      try {
        resp = await doFetch();
      } catch {
        throw new OctopusApiError(corsMessage, { corsLikely: true });
      }
      if (resp.ok || !isRetryableStatus(resp.status) || attempt >= MAX_ATTEMPTS) return resp;
      await sleep(backoffMs(attempt, resp));
    }
  }

  async function getJson<T>(fullUrl: string): Promise<T> {
    const resp = await fetchWithRetry(() => fetch(fullUrl, { headers: authHeader() }), CORS_MSG);
    if (!resp.ok) {
      let bodyText = '';
      try {
        bodyText = await resp.text();
      } catch {
        /* body unavailable */
      }
      throw new OctopusApiError(`HTTP ${resp.status}: ${bodyText.slice(0, 300)}`, {
        status: resp.status,
        body: bodyText,
      });
    }
    return resp.json() as Promise<T>;
  }

  const restGetRaw = <T = unknown>(fullUrl: string): Promise<T> => getJson<T>(fullUrl);

  const restGet = <T = unknown>(path: string, params: Params = {}): Promise<T> => {
    const url = new URL(path.startsWith('http') ? path : REST_BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return getJson<T>(url.toString());
  };

  async function restGetAllPages<T = unknown>(path: string, params: Params = {}): Promise<T[]> {
    let results: T[] = [];
    let nextUrl: string | null = REST_BASE + path;
    let nextParams: Params | null = params;
    let guard = 0;
    while (nextUrl) {
      if (guard >= MAX_REST_PAGES) {
        throw new OctopusApiError(
          `Octopus API pagination exceeded ${MAX_REST_PAGES} pages for a REST list response.`,
        );
      }
      const url: URL = new URL(nextUrl);
      for (const [k, v] of Object.entries(nextParams ?? {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
      const page: Page<T> = await getJson<Page<T>>(url.toString());
      results = results.concat(page.results ?? []);
      nextUrl = page.next ?? null;
      nextParams = null;
      guard++;
    }
    return results;
  }

  async function graphqlRequest<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
    token: string | null = null,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) headers['Authorization'] = token;

    const resp = await fetchWithRetry(
      () =>
        fetch(GRAPHQL_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query, variables }),
        }),
      'GraphQL request failed before any response was received (likely CORS). Check the browser console.',
    );
    if (!resp.ok) {
      let bodyText = '';
      try {
        bodyText = await resp.text();
      } catch {
        /* body unavailable */
      }
      throw new OctopusApiError(
        `HTTP ${resp.status} from GraphQL endpoint: ${bodyText.slice(0, 300)}`,
        { status: resp.status, body: bodyText },
      );
    }
    const json = (await resp.json()) as GraphqlResponse<T>;
    if (json.errors) {
      throw new OctopusApiError('GraphQL error: ' + json.errors.map((e) => e.message).join('; '));
    }
    return json.data as T;
  }

  return { restGet, restGetAllPages, restGetRaw, graphqlRequest };
}
