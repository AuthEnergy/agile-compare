import { fetchAccount } from './account';
import { OctopusApiError, type OctopusClient } from './client';
import type { AccountData } from '../types/octopus';

// One selectable meter: an MPAN with its (possibly swapped) serials, flagged
// import vs export. Carries the account data so the flow can run without re-fetch.
export interface MeterChoice {
  accountNumber: string;
  mpan: string;
  serial: string; // primary = newest after any exchange
  serials: string[]; // all, newest first — consumption is merged across them
  address: string;
  tariffCode: string;
  gsp: string | null;
  isExport: boolean;
  accountData: AccountData;
}

// Octopus consistently uses these tokens in export/generation tariff codes, so a
// meter reads as export even when is_export isn't set.
const EXPORT_PATTERNS = /EXPORT|OUTGOING|SEG|GENERATION/i;

interface ViewerData {
  viewer?: { accounts?: ({ number?: string | null } | null)[] | null } | null;
}

// Account numbers for the key. The REST /accounts/ list needs elevated perms a
// customer key lacks, so we use the GraphQL viewer query (works for all keys).
export async function fetchAccountNumbers(client: OctopusClient, token: string): Promise<string[]> {
  const data = await client.graphqlRequest<ViewerData>(
    '{ viewer { accounts { number } } }',
    {},
    token,
  );
  return (data.viewer?.accounts ?? [])
    .map((a) => a?.number)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

// Pure: every electricity meter across an account's properties (import + export).
export function collectMeters(accountData: AccountData): MeterChoice[] {
  const accountNumber = accountData.number ?? '';
  const meters: MeterChoice[] = [];
  for (const prop of accountData.properties ?? []) {
    const address = [
      prop.address_line_1,
      prop.address_line_2,
      prop.address_line_3,
      prop.town,
      prop.postcode,
    ]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .join(', ');
    for (const em of prop.electricity_meter_points ?? []) {
      const serials = (em.meters ?? [])
        .map((m) => m.serial_number)
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (serials.length === 0) continue;
      const serial = serials[serials.length - 1] ?? '';
      const agreements = em.agreements ?? [];
      const looksExport =
        !!em.is_export ||
        (agreements.length > 0 &&
          agreements.every((a) => EXPORT_PATTERNS.test(a.tariff_code || '')));
      const current = agreements.find((a) => !a.valid_to) ?? agreements[agreements.length - 1];
      meters.push({
        accountNumber,
        mpan: em.mpan ?? '',
        serial,
        serials: [...serials].reverse(),
        address,
        tariffCode: current ? current.tariff_code : 'unknown',
        gsp: em.gsp ?? null,
        isExport: looksExport,
        accountData,
      });
    }
  }
  return meters;
}

// Discover every meter for the key: account numbers → account data (skipping any
// the key can't read, 403) → collected meters, sorted import-first then most-recent-first.
export async function discoverMeters(client: OctopusClient, token: string): Promise<MeterChoice[]> {
  const numbers = await fetchAccountNumbers(client, token);
  if (numbers.length === 0) throw new Error('No accounts found for this API key.');
  const all: MeterChoice[] = [];
  for (const number of numbers) {
    let acct: AccountData;
    try {
      acct = await fetchAccount(client, number);
    } catch (e) {
      if (e instanceof OctopusApiError && e.status === 403) continue;
      throw e;
    }
    acct.number = number;
    all.push(...collectMeters(acct));
  }
  return sortMeters(all);
}

// Sort import meters before export, then within each group most-recently-activated first
// (highest agreement validFrom). Stable so ties preserve the original API order.
export function sortMeters(meters: MeterChoice[]): MeterChoice[] {
  const latestMs = (m: MeterChoice): number => {
    let best = 0;
    for (const prop of m.accountData.properties ?? []) {
      for (const em of prop.electricity_meter_points ?? []) {
        if ((em.mpan ?? '') !== m.mpan) continue;
        for (const a of em.agreements ?? []) {
          const t = a.valid_from ? new Date(a.valid_from).getTime() : 0;
          if (t > best) best = t;
        }
      }
    }
    return best;
  };
  return [...meters].sort((a, b) => {
    if (a.isExport !== b.isExport) return a.isExport ? 1 : -1;
    return latestMs(b) - latestMs(a);
  });
}
