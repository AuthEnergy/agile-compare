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
  const productCode = productCodeFromTariffCode(tariffCode);
  if (!productCode) {
    return {
      status: 'unavailable',
      productCode: null,
      reason: 'Could not derive a product code from your current tariff code.',
    };
  }
  const tariff = classifyTariffCode(tariffCode);
  const isGoLike = tariff.kind === 'go';

  let dayWindows: RateWindow[];
  let standingWindows: RateWindow[];
  try {
    [dayWindows, standingWindows] = await Promise.all([
      fetchRateWindows(
        client,
        productCode,
        tariffCode,
        'standard-unit-rates',
        periodFrom,
        periodTo,
      ),
      fetchRateWindows(client, productCode, tariffCode, 'standing-charges', periodFrom, periodTo),
    ]);
  } catch {
    return {
      status: 'unavailable',
      productCode,
      reason: 'Could not fetch standard unit rates and standing charges for your current tariff.',
    };
  }
  if (dayWindows.length === 0) {
    return {
      status: 'unavailable',
      productCode,
      reason: 'The Octopus API returned no standard unit rates for your current tariff.',
    };
  }

  // Probe for off-peak rates. A positive response means the tariff is not a plain
  // single-register shape; only Go-like two-band day/night tariffs are modelled.
  let nightWindows: RateWindow[] = [];
  try {
    nightWindows = await fetchRateWindows(
      client,
      productCode,
      tariffCode,
      'night-unit-rates',
      periodFrom,
      periodTo,
    );
  } catch {
    /* flat/single-register tariff — no night-unit-rates endpoint */
  }

  if (nightWindows.length > 0 && !isGoLike) {
    return {
      status: 'unsupported',
      productCode,
      reason: `${tariff.label} has time-of-use rates that this page cannot model safely yet.`,
    };
  }

  if (isGoLike && nightWindows.length === 0) {
    return {
      status: 'unavailable',
      productCode,
      reason: `${tariff.label} needs day and night rate windows, but the Octopus API returned no night rates.`,
    };
  }

  const rateShape: CurrentTariffRateShape = isGoLike ? 'go-day-night' : 'flat';
  const unitWindows =
    rateShape === 'go-day-night'
      ? buildGoRateWindows(dayWindows, nightWindows, periodFrom, periodTo)
      : [...dayWindows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());

  return { status: 'available', unitWindows, standingWindows, productCode, rateShape };
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
