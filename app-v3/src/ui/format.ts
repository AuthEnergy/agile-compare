// Presentation formatters. Money is framed as evidence ("would have cost"),
// figures render in mono. All dates/times are UTC (settlement time).

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Pence (number) → "£12.34". Negative handled by the caller's sign logic.
export function fmtMoney(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export function fmtPence(pence: number): string {
  return `${pence.toFixed(2)}p`;
}

export function fmtKwh(kwh: number, dp = 1): string {
  return `${kwh.toFixed(dp)} kWh`;
}

// "1 March 2026" (UTC).
export function fmtDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

// "1 Mar" (UTC), for compact window labels.
export function fmtDateShort(d: Date): string {
  return `${d.getUTCDate()} ${(MONTHS[d.getUTCMonth()] ?? '').slice(0, 3)} ${d.getUTCFullYear()}`;
}

// "14:30" — the UTC half-hour slot start.
export function fmtSlotTime(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${fmt(start)}–${fmt(end)}`;
}

export function fmtSignedMoney(pence: number): string {
  const sign = pence < 0 ? '−' : pence > 0 ? '+' : '';
  return `${sign}${fmtMoney(Math.abs(pence))}`;
}

// Escape for the rare innerHTML path; DOM building uses textContent and needs no
// escaping, but anything interpolated into markup must pass through here.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
