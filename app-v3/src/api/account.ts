import type { Agreement } from '../types/domain';
import type { AccountData } from '../types/octopus';
import type { OctopusClient } from './client';

export async function obtainKrakenToken(client: OctopusClient, apiKey: string): Promise<string> {
  const query = `
    mutation ObtainKrakenToken($input: ObtainJSONWebTokenInput!) {
      obtainKrakenToken(input: $input) { token }
    }`;
  const data = await client.graphqlRequest<{ obtainKrakenToken: { token: string } }>(query, {
    input: { APIKey: apiKey },
  });
  return data.obtainKrakenToken.token;
}

export function fetchAccount(client: OctopusClient, accountNumber: string): Promise<AccountData> {
  return client.restGet<AccountData>(`/accounts/${accountNumber}/`);
}

// Region letter for the MPAN. The documented `gsp` field is unreliable on real
// responses, so the tariff_code suffix (e.g. "...-A") is the primary source.
// Returns "MPAN_FOUND_NO_REGION" (found but undeterminable) distinct from null
// (MPAN not on the account at all).
export function getRegionLetterFromAccount(accountData: AccountData, mpan: string): string | null {
  for (const prop of accountData.properties ?? []) {
    for (const em of prop.electricity_meter_points ?? []) {
      if (em.mpan === mpan) {
        if (em.gsp) return em.gsp.replace(/^_/, '');
        for (const a of em.agreements ?? []) {
          const match = (a.tariff_code ?? '').match(/-([A-Z])$/);
          if (match) return match[1] ?? null;
        }
        return 'MPAN_FOUND_NO_REGION';
      }
    }
  }
  return null;
}

export function getAgreementsForMpan(accountData: AccountData, mpan: string): Agreement[] {
  for (const prop of accountData.properties ?? []) {
    for (const em of prop.electricity_meter_points ?? []) {
      if (em.mpan === mpan) return em.agreements ?? [];
    }
  }
  return [];
}

// Returns only the OUTWARD part of the postcode (e.g. "N15" from "N15 4FZ") —
// never the full postcode. The coarsest useful location signal.
export function getPostcodeAreaForMpan(accountData: AccountData, mpan: string): string | null {
  for (const prop of accountData.properties ?? []) {
    for (const em of prop.electricity_meter_points ?? []) {
      if (em.mpan === mpan) {
        const postcode = (prop.postcode ?? '').trim();
        if (!postcode) return null;
        const spaceIdx = postcode.indexOf(' ');
        if (spaceIdx > 0) return postcode.slice(0, spaceIdx);
        return postcode.length > 3 ? postcode.slice(0, -3) : postcode;
      }
    }
  }
  return null;
}
