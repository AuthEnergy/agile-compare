import type { RateWindow } from '../types/domain';
import type { DiscoveredProduct, ProductRow, RawRateRow } from '../types/octopus';
import type { OctopusClient, Params } from './client';
import { classifyTariffCode, productCodeFromTariffCode } from '../domain/tariff';
import { buildGoRateWindows } from '../domain/rates';

export type CurrentTariffRateShape = 'flat' | 'go-day-night';

export interface CurrentTariffRates {
  status: 'available';
  // Unit rate windows, sorted ascending and ready for calculateCost. Go-like tariffs
  // are merged from standard day windows plus night windows; flat/single-register
  // tariffs use the standard-unit-rates windows directly.
  unitWindows: RateWindow[];
  standingWindows: RateWindow[];
  productCode: string;
  rateShape: CurrentTariffRateShape;
  // Set when we fell back to a newer product-code version of the same tariff because
  // the account's code no longer has published rates for the comparison period.
  substitutionNote?: string;
}

export type CurrentTariffRatesResult =
  | CurrentTariffRates
  | { status: 'unavailable'; productCode: string | null; reason: string }
  | { status: 'unsupported'; productCode: string; reason: string };

// Fetch actual rate windows for the tariff the user is currently on, using the
// tariff code from their agreement (no product-name search needed). This fails
// closed: single-register rates and Go/Intelligent Go day+night shapes are priced;
// other ToU shapes (Cosy, Flux, Power Loop, unknown multi-band tariffs) return an
// explicit unsupported status so callers can use Flexible proxy with a caveat.
export async function fetchCurrentTariffRates(
  client: OctopusClient,
  tariffCode: string,
  periodFrom: Date,
  periodTo: Date,
): Promise<CurrentTariffRatesResult> {
  const tariff = classifyTariffCode(tariffCode);
  const isGoLike = tariff.kind === 'go';

  // Inner helper: try fetching all rate windows for a specific product+tariff code.
  // Returns the windows on success, 'unsupported' for unmodelable ToU shapes, or
  // null on any failure (missing endpoint, empty windows, API error) so the caller
  // can try substitute product versions without catching multiple error shapes.
  const tryFetch = async (
    pCode: string,
    tCode: string,
  ): Promise<
    | {
        unitWindows: RateWindow[];
        standingWindows: RateWindow[];
        rateShape: CurrentTariffRateShape;
      }
    | 'unsupported'
    | null
  > => {
    let dayWindows: RateWindow[];
    let standingWindows: RateWindow[];
    try {
      [dayWindows, standingWindows] = await Promise.all([
        fetchRateWindows(client, pCode, tCode, 'standard-unit-rates', periodFrom, periodTo),
        fetchRateWindows(client, pCode, tCode, 'standing-charges', periodFrom, periodTo),
      ]);
    } catch {
      return null;
    }
    if (dayWindows.length === 0) return null;

    let nightWindows: RateWindow[] = [];
    try {
      nightWindows = await fetchRateWindows(
        client,
        pCode,
        tCode,
        'night-unit-rates',
        periodFrom,
        periodTo,
      );
    } catch {
      /* flat-rate tariff — no night-unit-rates endpoint, or 404 */
    }

    if (nightWindows.length > 0 && !isGoLike) return 'unsupported';
    if (isGoLike && nightWindows.length === 0) return null;

    const rateShape: CurrentTariffRateShape = isGoLike ? 'go-day-night' : 'flat';
    const unitWindows =
      rateShape === 'go-day-night'
        ? buildGoRateWindows(dayWindows, nightWindows, periodFrom, periodTo)
        : [...dayWindows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
    return { unitWindows, standingWindows, rateShape };
  };

  // 1. Try the exact product code from the account agreement.
  const originalProductCode = productCodeFromTariffCode(tariffCode);
  if (originalProductCode) {
    const direct = await tryFetch(originalProductCode, tariffCode);
    if (direct === 'unsupported') {
      return {
        status: 'unsupported',
        productCode: originalProductCode,
        reason: `${tariff.label} has time-of-use rates that this page cannot model safely yet.`,
      };
    }
    if (direct !== null) {
      return { status: 'available', productCode: originalProductCode, ...direct };
    }
  }

  // 2. For Go-like tariffs, the account may reference an older product version whose
  //    published rates don't cover the comparison period. Use the same display-name
  //    lookup as the manual tariff picker (fetchTariffRatesByName → findProductVersionsByDisplayName
  //    → fetchMergedRateWindows), which uses dated sampling to find every product version
  //    that overlapped the window regardless of whether the tariff is still open to new customers.
  if (isGoLike) {
    const regionMatch = /^E-\d+R-.+-([A-P])$/i.exec(tariffCode);
    const region = regionMatch?.[1];
    if (region) {
      const goDisplayName =
        tariff.label === 'Intelligent Go' ? 'Intelligent Octopus Go' : 'Octopus Go';
      try {
        const rates = await fetchTariffRatesByName(
          client,
          goDisplayName,
          region,
          periodFrom,
          periodTo,
        );
        if (rates && rates.unitWindows.length > 0) {
          const accountCode = originalProductCode ?? tariffCode;
          const base = {
            status: 'available' as const,
            productCode: originalProductCode ?? goDisplayName,
            unitWindows: rates.unitWindows,
            standingWindows: rates.standingWindows,
            rateShape: 'go-day-night' as const,
          };
          return originalProductCode
            ? {
                ...base,
                substitutionNote:
                  `Your account shows ${accountCode}, whose published rates don't cover this ` +
                  `comparison period. Current ${tariff.label} rates were used instead — ` +
                  `the tariff structure is the same.`,
              }
            : base;
        }
      } catch {
        /* fall through to unavailable */
      }
    }
  }

  // 3. No rates could be fetched — return unavailable for the proxy fallback.
  return {
    status: 'unavailable',
    productCode: originalProductCode ?? null,
    reason: originalProductCode
      ? `${tariff.label} rates are not available from the Octopus API for this comparison period.`
      : 'Could not derive a product code from your current tariff code.',
  };
}

export interface MergedRateWindows {
  windows: RateWindow[];
  used: string[];
  rawCount: number;
}

export async function fetchProductTariffCode(
  client: OctopusClient,
  productCode: string,
  regionLetter: string,
): Promise<string | null> {
  const detail = await client.restGet<{
    single_register_electricity_tariffs?: Record<string, Record<string, { code?: string }>>;
  }>(`/products/${productCode}/`);
  const regionKey = '_' + regionLetter;
  const regionTariffs = (detail.single_register_electricity_tariffs ?? {})[regionKey];
  if (!regionTariffs) return null;
  const tariff = regionTariffs['direct_debit_monthly'] ?? Object.values(regionTariffs)[0];
  return tariff?.code ?? null;
}

export async function findLiveProductCodeByDisplayName(
  client: OctopusClient,
  displayName: string,
): Promise<string | null> {
  const results = await client.restGetAllPages<ProductRow>('/products/', {
    brand: 'OCTOPUS_ENERGY',
    is_variable: 'true',
  });
  const candidates = results.filter(
    (p) => p.display_name === displayName && !p.is_business && !p.is_prepay,
  );
  if (candidates.length === 0) return null;
  const live = candidates.find((p) => !p.available_to);
  return (live ?? candidates[0])?.code ?? null;
}

// Discover ALL product versions for a display name whose availability overlaps
// the window (not just the live one), via dated sampling + boundary probes —
// so a comparison spanning a product-code switch gets both versions' rates.
export async function findProductsByDisplayNameOverlapping(
  client: OctopusClient,
  displayName: string,
  periodFrom: Date,
  periodTo: Date,
): Promise<DiscoveredProduct[]> {
  const samples: Array<Date | null> = [];
  const stepMs = 45 * 24 * 60 * 60 * 1000;
  for (let t = periodFrom.getTime(); t < periodTo.getTime(); t += stepMs) samples.push(new Date(t));
  samples.push(periodTo);
  samples.push(null); // current (no available_at filter)

  const byCode = new Map<string, DiscoveredProduct>();
  const probe = async (at: Date | null): Promise<void> => {
    const params: Params = { brand: 'OCTOPUS_ENERGY', is_variable: 'true' };
    if (at) params['available_at'] = at.toISOString();
    let results: ProductRow[];
    try {
      results = await client.restGetAllPages<ProductRow>('/products/', params);
    } catch {
      return;
    }
    for (const p of results) {
      if (p.display_name === displayName && !p.is_business && !p.is_prepay && !byCode.has(p.code)) {
        byCode.set(p.code, {
          code: p.code,
          available_from: p.available_from ?? null,
          available_to: p.available_to ?? null,
        });
      }
    }
  };

  for (const at of samples) await probe(at);

  // Boundary probes catch a version that started AND retired between samples.
  const fromMs = periodFrom.getTime();
  const toMs = periodTo.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const boundaries = new Set<number>();
  for (const p of [...byCode.values()]) {
    for (const edge of [p.available_from, p.available_to]) {
      if (!edge) continue;
      const ms = new Date(edge).getTime();
      for (const side of [-dayMs, dayMs]) {
        const t = ms + side;
        if (t > fromMs && t < toMs) boundaries.add(Math.floor(t / dayMs) * dayMs);
      }
    }
  }
  for (const t of boundaries) await probe(new Date(t));

  const products = [...byCode.values()];
  const overlapping = products.filter((p) => {
    const af = p.available_from ? new Date(p.available_from).getTime() : -Infinity;
    const at = p.available_to ? new Date(p.available_to).getTime() : Infinity;
    return af < periodTo.getTime() && at > periodFrom.getTime();
  });
  const chosen = overlapping.length ? overlapping : products;
  chosen.sort(
    (a, b) => new Date(a.available_from ?? 0).getTime() - new Date(b.available_from ?? 0).getTime(),
  );
  return chosen;
}

export async function fetchRateWindows(
  client: OctopusClient,
  productCode: string,
  tariffCode: string,
  kind: string,
  periodFrom: Date,
  periodTo: Date,
): Promise<RateWindow[]> {
  const path = `/products/${productCode}/electricity-tariffs/${tariffCode}/${kind}/`;
  const results = await client.restGetAllPages<RawRateRow>(path, {
    period_from: periodFrom.toISOString(),
    period_to: periodTo.toISOString(),
    page_size: 1500,
  });
  return results
    .filter((r) => r.payment_method === 'DIRECT_DEBIT' || !r.payment_method)
    .map((r) => ({
      validFrom: new Date(r.valid_from),
      validTo: r.valid_to ? new Date(r.valid_to) : null,
      value: r.value_inc_vat,
    }));
}

// Merge rate windows across product versions, clipping each to where it was
// actually available so a retired open-ended row can't leak past its end and
// hide a missing-version gap. rawCount = rows seen before clipping, so a caller
// can tell "no rates at all" from "rates exist but don't overlap this window".
// Discover display names of consumer (non-business, non-prepay) Octopus tariffs
// available at any point during the window. Excludes Agile (already the right
// column default) and export/outgoing tariffs. Samples at the start, end, and
// current time so products that launched or retired mid-window are included.
export async function discoverConsumerTariffNames(
  client: OctopusClient,
  periodFrom: Date,
  periodTo: Date,
): Promise<string[]> {
  const seen = new Set<string>();
  // Dense sampling (same cadence as findProductVersionsByDisplayName) so that
  // tariffs which were available at some point in the window — but are now
  // closed to new customers — still appear in the picker.
  const stepMs = 45 * 24 * 60 * 60 * 1000;
  const samples: Array<Date | null> = [];
  for (let t = periodFrom.getTime(); t < periodTo.getTime(); t += stepMs) {
    samples.push(new Date(t));
  }
  samples.push(periodTo);
  samples.push(null); // current: products available to new customers right now
  for (const at of samples) {
    const params: Params = { brand: 'OCTOPUS_ENERGY' };
    if (at) params['available_at'] = at.toISOString();
    let results: ProductRow[];
    try {
      results = await client.restGetAllPages<ProductRow>('/products/', params);
    } catch {
      continue;
    }
    for (const p of results) {
      if (p.is_business || p.is_prepay || !p.display_name) continue;
      const nameLower = p.display_name.toLowerCase();
      if (nameLower.includes('agile')) continue;
      if (nameLower.includes('outgoing') || nameLower.includes('export')) continue;
      seen.add(p.display_name);
    }
  }
  return [...seen].sort();
}

// Like findProductsByDisplayNameOverlapping but does NOT filter to is_variable,
// so fixed-rate tariffs are included alongside variable ones.
async function findProductVersionsByDisplayName(
  client: OctopusClient,
  displayName: string,
  periodFrom: Date,
  periodTo: Date,
): Promise<DiscoveredProduct[]> {
  const samples: Array<Date | null> = [];
  const stepMs = 45 * 24 * 60 * 60 * 1000;
  for (let t = periodFrom.getTime(); t < periodTo.getTime(); t += stepMs) samples.push(new Date(t));
  samples.push(periodTo);
  samples.push(null);

  const byCode = new Map<string, DiscoveredProduct>();
  const probe = async (at: Date | null): Promise<void> => {
    const params: Params = { brand: 'OCTOPUS_ENERGY' };
    if (at) params['available_at'] = at.toISOString();
    let results: ProductRow[];
    try {
      results = await client.restGetAllPages<ProductRow>('/products/', params);
    } catch {
      return;
    }
    for (const p of results) {
      if (p.display_name === displayName && !p.is_business && !p.is_prepay && !byCode.has(p.code)) {
        byCode.set(p.code, {
          code: p.code,
          available_from: p.available_from ?? null,
          available_to: p.available_to ?? null,
        });
      }
    }
  };

  for (const at of samples) await probe(at);

  const fromMs = periodFrom.getTime();
  const toMs = periodTo.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const boundaries = new Set<number>();
  for (const p of [...byCode.values()]) {
    for (const edge of [p.available_from, p.available_to]) {
      if (!edge) continue;
      const ms = new Date(edge).getTime();
      for (const side of [-dayMs, dayMs]) {
        const t = ms + side;
        if (t > fromMs && t < toMs) boundaries.add(Math.floor(t / dayMs) * dayMs);
      }
    }
  }
  for (const t of boundaries) await probe(new Date(t));

  const products = [...byCode.values()];
  const overlapping = products.filter((p) => {
    const af = p.available_from ? new Date(p.available_from).getTime() : -Infinity;
    const at = p.available_to ? new Date(p.available_to).getTime() : Infinity;
    return af < periodTo.getTime() && at > periodFrom.getTime();
  });
  const chosen = overlapping.length ? overlapping : products;
  chosen.sort(
    (a, b) => new Date(a.available_from ?? 0).getTime() - new Date(b.available_from ?? 0).getTime(),
  );
  return chosen;
}

// Fetch merged unit and standing rate windows for a tariff identified by display
// name, across all product versions that overlap the window. Includes both
// variable and fixed-rate tariffs. Probes night-unit-rates and merges them via
// buildGoRateWindows when present (covers Go, Intelligent Go, and Cosy shapes).
export async function fetchTariffRatesByName(
  client: OctopusClient,
  displayName: string,
  regionLetter: string,
  periodFrom: Date,
  periodTo: Date,
): Promise<{ unitWindows: RateWindow[]; standingWindows: RateWindow[] } | null> {
  const products = await findProductVersionsByDisplayName(
    client,
    displayName,
    periodFrom,
    periodTo,
  );
  if (products.length === 0) return null;

  const [dayMerged, standingMerged] = await Promise.all([
    fetchMergedRateWindows(
      client,
      products,
      regionLetter,
      'standard-unit-rates',
      periodFrom,
      periodTo,
    ),
    fetchMergedRateWindows(
      client,
      products,
      regionLetter,
      'standing-charges',
      periodFrom,
      periodTo,
    ),
  ]);
  if (dayMerged.windows.length === 0) return null;

  let nightWindows: RateWindow[] = [];
  try {
    const nightMerged = await fetchMergedRateWindows(
      client,
      products,
      regionLetter,
      'night-unit-rates',
      periodFrom,
      periodTo,
    );
    nightWindows = nightMerged.windows;
  } catch {
    /* flat-rate tariff — no night rates */
  }

  const unitWindows =
    nightWindows.length > 0
      ? buildGoRateWindows(dayMerged.windows, nightWindows, periodFrom, periodTo)
      : dayMerged.windows;

  return { unitWindows, standingWindows: standingMerged.windows };
}

export async function fetchMergedRateWindows(
  client: OctopusClient,
  products: readonly DiscoveredProduct[],
  regionLetter: string,
  kind: string,
  periodFrom: Date,
  periodTo: Date,
): Promise<MergedRateWindows> {
  let all: RateWindow[] = [];
  const used: string[] = [];
  let rawCount = 0;
  for (const p of products) {
    const from =
      p.available_from && new Date(p.available_from) > periodFrom
        ? new Date(p.available_from)
        : periodFrom;
    const to =
      p.available_to && new Date(p.available_to) < periodTo ? new Date(p.available_to) : periodTo;
    if (from >= to) continue;
    let tariffCode: string | null = null;
    try {
      tariffCode = await fetchProductTariffCode(client, p.code, regionLetter);
    } catch {
      tariffCode = null;
    }
    if (!tariffCode) continue;
    let windows: RateWindow[] = [];
    try {
      windows = await fetchRateWindows(client, p.code, tariffCode, kind, from, to);
    } catch {
      windows = [];
    }
    rawCount += windows.length;
    const clipped: RateWindow[] = [];
    for (const w of windows) {
      const wf = w.validFrom > from ? w.validFrom : from;
      const wt = w.validTo && w.validTo < to ? w.validTo : to;
      if (wf < wt) clipped.push({ validFrom: wf, validTo: wt, value: w.value });
    }
    if (clipped.length) {
      all = all.concat(clipped);
      used.push(p.code);
    }
  }
  all.sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  return { windows: all, used, rawCount };
}
