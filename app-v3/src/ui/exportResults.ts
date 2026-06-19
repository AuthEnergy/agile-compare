import { rateAtSorted } from '../domain/rates';
import type { ExportRun } from '../types/result';
import type { Reading } from '../types/domain';
import { button, callout, costCalc, switchRow, type CalcInput } from './components';
import { el, icon } from './dom';
import { fmtDate, fmtKwh, fmtMoney, fmtPence, fmtSlotTime } from './format';
import { ICONS } from './icons';

const DAY_MS = 24 * 60 * 60 * 1000;
const pence = (p: number): string => (p / 100).toFixed(2);

export interface ExportCallbacks {
  onReset: () => void;
  onDiagnostics: () => void;
  // consent for raw half-hour export slots (privacy-sensitive)
  consent: boolean;
  onToggleConsent: (v: boolean) => void;
}

interface ExportDay {
  dateMid: number;
  kwh: number;
  valuePence: number;
  readings: Reading[];
}

// Group export readings by UTC day, valuing each at the Agile Outgoing rate.
function exportDays(run: ExportRun): ExportDay[] {
  const byDay = new Map<number, ExportDay>();
  for (const r of run.detail.readings) {
    const dayMid = Math.floor(r.start.getTime() / DAY_MS) * DAY_MS;
    let d = byDay.get(dayMid);
    if (!d) {
      d = { dateMid: dayMid, kwh: 0, valuePence: 0, readings: [] };
      byDay.set(dayMid, d);
    }
    d.kwh += r.kwh;
    const rate = rateAtSorted(run.detail.agileWindows, r.start);
    if (rate !== null) d.valuePence += r.kwh * rate;
    d.readings.push(r);
  }
  return [...byDay.values()].sort((a, b) => a.dateMid - b.dateMid);
}

function exportSlotTable(day: ExportDay, run: ExportRun): HTMLElement {
  const head = el(
    'div',
    { class: 'slot-grid-head', style: 'grid-template-columns:60px repeat(3,1fr)' },
    [
      el('span', { text: 'Slot' }),
      el('span', { class: 'tnum', text: 'Exported' }),
      el('span', { class: 'tnum', text: 'Agile Out' }),
      el('span', { class: 'tnum', text: 'Paid' }),
    ],
  );
  const rows = day.readings.map((r) => {
    const rate = rateAtSorted(run.detail.agileWindows, r.start);
    return el('div', { class: 'slot-row', style: 'grid-template-columns:60px repeat(3,1fr)' }, [
      el('span', { text: fmtSlotTime(r.start, new Date(r.start.getTime() + 30 * 60 * 1000)) }),
      el('span', { class: 'tnum', text: r.kwh.toFixed(2) }),
      el('span', { class: 'tnum muted', text: rate === null ? 'unmatched' : fmtPence(rate) }),
      el('span', {
        class: 'tnum',
        style: 'font-weight:500;color:var(--status-saving)',
        text: rate === null ? 'n/a' : fmtMoney(r.kwh * rate),
      }),
    ]);
  });
  return el('div', { style: 'border-top:1px solid var(--border-soft)' }, [
    head,
    el('div', { class: 'slot-scroll' }, rows),
  ]);
}

function exportDayRow(day: ExportDay, run: ExportRun): HTMLElement {
  const chevron = el('span', { class: 'chevron' }, [icon(ICONS.chevronRight, 13, 2.2)]);
  const head = el('div', { class: 'day-head' }, [
    chevron,
    el('span', { class: 'day-date', text: fmtDate(new Date(day.dateMid)) }),
    el('span', {
      class: 'mono',
      style: 'font-size:var(--text-data-sm);color:var(--text-muted)',
      text: fmtKwh(day.kwh, 1),
    }),
    el('span', {
      class: 'mono',
      style: 'font-size:var(--text-data-sm);color:var(--status-saving)',
      text: fmtMoney(day.valuePence),
    }),
  ]);
  const card = el('div', { class: 'day' }, [head]);
  let table: HTMLElement | null = null;
  let open = false;
  head.addEventListener('click', () => {
    open = !open;
    chevron.classList.toggle('is-open', open);
    if (open && !table) {
      table = exportSlotTable(day, run);
      card.append(table);
    } else if (table) {
      table.style.display = open ? '' : 'none';
    }
  });
  return card;
}

// Paint the export ("Outgoing") comparison: income, no standing charge. Raw
// half-hour slots stay hidden until explicit consent (they reveal a generation
// pattern); only aggregates show by default.
export function renderExportResults(host: HTMLElement, run: ExportRun, cb: ExportCallbacks): void {
  host.append(
    el('div', { style: 'display:flex;flex-direction:column;gap:5px' }, [
      el('h1', { style: 'font-size:var(--text-h1)', text: 'Your export comparison' }),
    ]),
    callout(
      'Income, not cost',
      'Export tariffs pay you, with no standing charge. These show what each would have paid you on your real export. Gaps or unmatched rates make them approximate.',
      'support',
      'info',
    ),
  );

  // Income comparison as a receipt: Agile Outgoing − Outgoing flat = difference,
  // so the "+X more on Agile" reads as a real subtraction, not three loose tiles.
  const flat = run.flat;
  const agile = run.agile;
  const inputs: CalcInput[] = [];
  if (agile) inputs.push({ label: 'Agile Outgoing', prefix: '£', amount: pence(agile.valuePence) });
  if (flat)
    inputs.push({
      label: 'Outgoing flat',
      prefix: '£',
      amount: pence(flat.valuePence),
      ...(inputs.length ? { op: '−' } : {}),
    });
  let result: Parameters<typeof costCalc>[0]['result'] = null;
  if (flat && agile) {
    const delta = agile.valuePence - flat.valuePence; // +ve → Agile pays more
    result = {
      label: 'Difference',
      prefix: '£',
      amount: pence(Math.abs(delta)),
      // "Agile − Flat = result": negative when Agile pays less than flat.
      sign: delta >= 0 ? '' : '−',
      descriptor: delta >= 0 ? 'more on Agile' : 'less on Agile',
      tone: delta >= 0 ? 'saving' : 'risk',
    };
  }
  host.append(
    el('div', { class: 'card' }, [
      costCalc({ inputs, result, foot: `${fmtKwh(run.exportKwh, 1)} exported` }),
    ]),
  );

  // privacy-gated detail
  const detailCard = el(
    'div',
    { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' },
    [
      el('div', { style: 'display:flex;flex-direction:column;gap:3px' }, [
        el('span', {
          class: 'row-title',
          style: 'font-size:var(--text-h3)',
          text: 'Half-hour export detail',
        }),
        el('span', {
          class: 'row-sub',
          text: 'Aggregate only by default. Raw timestamps can reveal when you generate.',
        }),
      ]),
      switchRow({
        label: 'Show half-hour export detail',
        description: 'Stays on your device. Nothing is shared by turning this on.',
        checked: cb.consent,
        onChange: cb.onToggleConsent,
      }),
    ],
  );
  if (cb.consent) {
    const days = exportDays(run);
    detailCard.append(
      el('div', { class: 'drill', style: 'background:transparent;padding:0' }, [
        el('div', {
          class: 'drill-hint',
          style: 'padding:0 0 4px',
          text: 'Daily export. Tap a day for its half-hours.',
        }),
        ...days.map((d) => exportDayRow(d, run)),
      ]),
    );
  }
  host.append(detailCard);

  host.append(
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;padding-top:2px' }, [
      button('Start over', { variant: 'secondary', onClick: cb.onReset }),
      button('Diagnostics', { variant: 'secondary', iconLeft: 'lock', onClick: cb.onDiagnostics }),
    ]),
  );
}
