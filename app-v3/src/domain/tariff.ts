import type { Agreement, TariffClass } from '../types/domain';

// Classify an Octopus tariff code into a human-friendly product kind. The
// trailing "-B" etc. is only the GSP region suffix, not the product name. Order
// matters: specific families before the generic VAR/FLEX (Flexible), since most
// codes also contain "VAR" (GO-VAR, OUTGOING-VAR, INTELLI-VAR).
export function classifyTariffCode(code: string | null | undefined): TariffClass {
  if (!code) return { kind: 'unknown', label: 'unknown tariff' };
  const c = String(code).toUpperCase();
  // Export ("Outgoing") first: an export code can also contain AGILE or VAR.
  if (c.includes('OUTGOING')) return { kind: 'export', label: 'Outgoing (export)' };
  if (c.includes('AGILE')) return { kind: 'agile', label: 'Agile' };
  if (c.includes('TRACKER')) return { kind: 'tracker', label: 'Tracker' };
  if (c.includes('COSY')) return { kind: 'cosy', label: 'Cosy' };
  if (c.includes('INTELLI')) return { kind: 'go', label: 'Intelligent Go' };
  if (/(^|-)GO(-|$)/.test(c)) return { kind: 'go', label: 'Go' };
  if (c.includes('FLUX')) return { kind: 'other', label: 'Flux' };
  if (c.includes('POWLP')) return { kind: 'other', label: 'Power Loop' };
  if (c.includes('FIX')) return { kind: 'fixed', label: 'Fixed' };
  if (c.includes('VAR') || c.includes('FLEX')) return { kind: 'flexible', label: 'Flexible' };
  return { kind: 'other', label: code };
}

// Returns a function giving the tariff code in force at a given date (the first
// agreement whose [valid_from, valid_to) covers it), or null.
export function makeTariffAtDateFn(
  agreements: readonly Agreement[] | null | undefined,
): (date: Date) => string | null {
  const sorted = [...(agreements ?? [])].sort(
    (a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime(),
  );
  return function tariffAtDate(date: Date): string | null {
    for (const a of sorted) {
      const from = new Date(a.valid_from);
      const to = a.valid_to ? new Date(a.valid_to) : null;
      if (date >= from && (!to || date < to)) return a.tariff_code;
    }
    return null;
  };
}

// The agreement actually in force at `at`. Octopus may pre-announce a future
// agreement (validTo = null, validFrom in the future), so we can't just find
// the open-ended one — we must check that validFrom has already passed.
// Falls back to the last agreement if none covers `at` (e.g. data before first
// agreement, or a diagnostic replayed after all agreements ended).
export function findCurrentAgreement(
  agreements: readonly Agreement[] | null | undefined,
  at: Date,
): Agreement | null {
  const list = agreements ?? [];
  const ms = at.getTime();
  const sorted = [...list].sort(
    (a, b) => new Date(b.valid_from).getTime() - new Date(a.valid_from).getTime(),
  );
  const active = sorted.find((a) => {
    const from = new Date(a.valid_from).getTime();
    const to = a.valid_to ? new Date(a.valid_to).getTime() : Infinity;
    return from <= ms && to > ms;
  });
  return active ?? list[list.length - 1] ?? null;
}

// Extract the product code from a tariff code.
// e.g. "E-1R-GO-VAR-22-10-14-G" → "GO-VAR-22-10-14"
export function productCodeFromTariffCode(code: string): string | null {
  const m = /^E-\d+R-(.+)-[A-P]$/i.exec(code);
  return m?.[1] ?? null;
}

// Distinct tariff codes in force at any instant during [start, end). >1 code
// means the period straddles an agreement change (mixed-tariff), which callers
// keep out of the current-tariff headline rather than mis-attributing by midpoint.
export function tariffCodesInRange(
  agreements: readonly Agreement[] | null | undefined,
  start: Date,
  end: Date,
): Set<string> {
  const sorted = [...(agreements ?? [])].sort(
    (a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime(),
  );
  const codes = new Set<string>();
  for (const a of sorted) {
    const from = new Date(a.valid_from);
    const to = a.valid_to ? new Date(a.valid_to) : null;
    if (from < end && (!to || to > start)) codes.add(a.tariff_code);
  }
  return codes;
}
