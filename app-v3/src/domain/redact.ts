export interface PiiIdentifiers {
  mpan?: string | null;
  serial?: string | null;
  serials?: readonly string[] | null;
  apiKey?: string | null;
  accountNumber?: string | null;
}

// Strip identifying values out of any free text before it lands in a DOWNLOADED
// artifact (error messages and progress-log lines can interpolate the MPAN/serial).
// Pure: identifiers are passed in (in v2 this read a global state singleton).
// Account number is POLICY-CONTROLLED — redacted only when `ids.accountNumber` is
// supplied, so the diagnostics bundle can omit it by default while a debug path
// could keep it.
export function redactPII(
  text: string | null | undefined,
  ids: PiiIdentifiers,
): string | null | undefined {
  if (text == null) return text;
  let s = String(text);
  if (ids.mpan) s = s.split(ids.mpan).join('[MPAN redacted]');
  const serials = ids.serials && ids.serials.length ? ids.serials : ids.serial ? [ids.serial] : [];
  for (const sn of serials) {
    if (sn) s = s.split(sn).join('[serial redacted]');
  }
  if (ids.apiKey) s = s.split(ids.apiKey).join('[API key redacted]');
  if (ids.accountNumber) s = s.split(ids.accountNumber).join('[account redacted]');
  return s;
}
