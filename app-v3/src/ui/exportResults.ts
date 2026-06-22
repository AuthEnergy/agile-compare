import { buildDayComparisons } from '../domain/drilldown';
import { rateAtSorted } from '../domain/rates';
import type { RateWindow } from '../types/domain';
import type { ExportRun, RunDetail } from '../types/result';
import { button, callout, costCalc, type CalcInput } from './components';
import { FALLBACK_TAG, TAG_ICON, dayCalendar } from './drilldown';
import { el, icon } from './dom';
import { fmtKwh, fmtMoney } from './format';
import { ICONS } from './icons';

const pence = (p: number): string => (p / 100).toFixed(2);

const MONTH_NAMES = [
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

interface ExportMonth {
  label: string;
  monthMs: number;
  kwh: number;
  totalReadings: number;
  flatPence: number;
  flatUnmatched: number;
  agilePence: number;
  agileUnmatched: number;
}

export interface ExportCallbacks {
  onReset: () => void;
  onDiagnostics: () => void;
  consent: boolean;
  onToggleConsent: (v: boolean) => void;
}

function exportMonths(run: ExportRun): ExportMonth[] {
  const byKey = new Map<string, ExportMonth>();
  for (const r of run.detail.readings) {
    const y = r.start.getUTCFullYear();
    const m = r.start.getUTCMonth();
    const key = `${y}-${m}`;
    let mo = byKey.get(key);
    if (!mo) {
      mo = {
        label: `${MONTH_NAMES[m] ?? ''} ${y}`,
        monthMs: Date.UTC(y, m, 1),
        kwh: 0,
        totalReadings: 0,
        flatPence: 0,
        flatUnmatched: 0,
        agilePence: 0,
        agileUnmatched: 0,
      };
      byKey.set(key, mo);
    }
    mo.kwh += r.kwh;
    mo.totalReadings += 1;
    const flatRate = rateAtSorted(run.detail.flatWindows, r.start);
    if (flatRate !== null) mo.flatPence += r.kwh * flatRate;
    else mo.flatUnmatched += 1;
    const agileRate = rateAtSorted(run.detail.agileWindows, r.start);
    if (agileRate !== null) mo.agilePence += r.kwh * agileRate;
    else mo.agileUnmatched += 1;
  }
  return [...byKey.values()];
}

// A zero-rate window covering all time — gives the standing-charge slots a
// matched £0.00 value (export has no standing charge) rather than "unmatched".
const ZERO_STANDING: RateWindow[] = [{ validFrom: new Date(0), validTo: null, value: 0 }];

// Mirrors renderPeriodRow exactly: status tag, ✓/⚠/✗ reason, coverage %, expandable days.
// On expand calls the same dayCalendar used by import, with rate windows swapped so
// green = Agile Out pays more (good), red = Agile Out pays less.
function exportMonthRow(mo: ExportMonth, run: ExportRun): HTMLElement {
  const coveragePct =
    mo.totalReadings > 0
      ? Math.round(((mo.totalReadings - mo.agileUnmatched) / mo.totalReadings) * 100)
      : 100;
  const status = coveragePct >= 95 ? 'complete' : coveragePct >= 75 ? 'partial' : 'mismatch';
  const included = coveragePct >= 95 ? 'yes' : coveragePct >= 75 ? 'caution' : 'no';
  const reason =
    mo.agileUnmatched === 0
      ? 'All export slots matched'
      : `${mo.agileUnmatched} slot${mo.agileUnmatched === 1 ? '' : 's'} unmatched`;

  const ti = TAG_ICON[status] ?? FALLBACK_TAG;
  const chevron = el('span', { class: 'chevron' }, [icon(ICONS.chevronRight, 17)]);
  const head = el('div', { class: 'row', style: 'cursor:pointer' }, [
    el('span', { class: 'row-tag', style: `background:${ti.bg};color:${ti.fg}` }, [
      icon(ICONS[ti.name], 15, 2.2),
    ]),
    el('div', { class: 'row-main' }, [
      el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
        el('span', { class: 'row-title', text: mo.label }),
      ]),
      el('span', { class: 'row-sub' }, [
        el('span', {
          style: `font-weight:600;margin-right:3px;color:${
            included === 'yes'
              ? 'var(--status-saving)'
              : included === 'caution'
                ? 'var(--status-caution)'
                : 'var(--status-risk)'
          }`,
          text: included === 'yes' ? '✓' : included === 'caution' ? '⚠' : '✗',
        }),
        reason,
      ]),
    ]),
    el(
      'div',
      { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:104px' },
      [
        el('span', {
          class: 'mono',
          style: 'font-size:var(--text-data-sm);color:var(--text-strong)',
          text: `Agile Out ${fmtMoney(mo.agilePence)}`,
        }),
        el('span', {
          class: 'mono',
          style: 'font-size:var(--text-caption);color:var(--text-muted)',
          text: `Outgoing ${fmtMoney(mo.flatPence)}`,
        }),
        el(
          'span',
          {
            class: 'mono',
            style:
              'font-size:var(--text-caption);color:var(--text-muted);opacity:0.65;display:flex;align-items:center;gap:5px',
          },
          [
            fmtKwh(mo.kwh, 1),
            el(
              'span',
              {
                style: `display:inline-flex;align-items:center;gap:2px;color:${
                  coveragePct >= 95
                    ? 'var(--text-muted)'
                    : coveragePct >= 75
                      ? 'var(--status-caution)'
                      : 'var(--status-risk)'
                }`,
              },
              [`${coveragePct}%`, icon(ICONS.activity, 10)],
            ),
          ],
        ),
      ],
    ),
    chevron,
  ]);
  const card = el(
    'div',
    {
      style:
        'border:1px solid var(--border-soft);border-radius:var(--radius-md);overflow:hidden;background:var(--surface-card)',
    },
    [head],
  );

  let dayList: HTMLElement | null = null;
  let open = false;
  head.addEventListener('click', () => {
    open = !open;
    chevron.classList.toggle('is-open', open);
    head.classList.toggle('is-selected', open);
    if (open && !dayList) {
      const monthStart = new Date(mo.monthMs);
      const monthEnd = new Date(mo.monthMs);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
      const period = { start: monthStart, end: monthEnd };
      // Swap rate windows: agileWindows → flexUnitSorted, flatWindows → agileUnitSorted.
      // dayCalendar colours green when flex > agile, so swapping means green = Agile Out pays more.
      const detail: RunDetail = {
        readings: run.detail.readings,
        flexUnitSorted: run.detail.agileWindows,
        agileUnitSorted: run.detail.flatWindows,
        flexStanding: ZERO_STANDING,
        agileStanding: ZERO_STANDING,
        agileAvailable: true,
        duplicateIntervals: run.detail.duplicateIntervals,
      };
      const days = buildDayComparisons(period, detail);
      dayList = dayCalendar(
        days,
        detail,
        period,
        { flexLabel: 'Agile Out', agileLabel: 'Outgoing', yoursColumn: null },
        'Green = Agile Out pays more. Tap a day for its 48 half-hours.',
      );
      card.append(dayList);
    } else if (dayList) {
      dayList.style.display = open ? '' : 'none';
    }
  });

  return card;
}

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
    const delta = agile.valuePence - flat.valuePence;
    result = {
      label: 'Difference',
      prefix: '£',
      amount: pence(Math.abs(delta)),
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

  const months = exportMonths(run);
  if (months.length > 0) {
    host.append(
      el('div', { style: 'display:flex;flex-direction:column;gap:9px' }, [
        el(
          'div',
          {
            style:
              'display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap',
          },
          [
            el('span', { class: 'eyebrow', text: 'Monthly export income' }),
            el('span', { class: 'row-sub', text: 'Tap a month for daily and half-hour detail.' }),
          ],
        ),
        ...months.map((mo) => exportMonthRow(mo, run)),
      ]),
    );
  }

  host.append(
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;padding-top:2px' }, [
      button('Start over', { variant: 'secondary', onClick: cb.onReset }),
      button('Diagnostics', { variant: 'secondary', iconLeft: 'lock', onClick: cb.onDiagnostics }),
    ]),
  );
}
