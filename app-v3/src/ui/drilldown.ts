import { buildDayComparisons, buildSlotCalculations } from '../domain/drilldown';
import type { HeadlineColumns } from '../domain/headline';
import type { DayComparison, SlotCalculation } from '../types/drilldown';
import type { ComparisonRun } from '../types/result';
import { badge, type Tone } from './components';
import { clear, el, icon } from './dom';
import { fmtDate, fmtKwh, fmtMoney, fmtPence, fmtSlotTime } from './format';
import { ICONS } from './icons';
import type { PeriodRowVM } from './viewModel';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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

const withYours = (columns: HeadlineColumns, label: string, column: 'flex' | 'agile'): string =>
  columns.yoursColumn === column ? `${label}` : label;

// Monday-first column index (0 = Mon … 6 = Sun) for a UTC date.
const mondayIndex = (d: Date): number => (d.getUTCDay() + 6) % 7;

interface TagIcon {
  name: keyof typeof ICONS;
  fg: string;
  bg: string;
}
const FALLBACK_TAG: TagIcon = {
  name: 'alert',
  fg: 'var(--status-caution)',
  bg: 'var(--amber-tint)',
};
const TAG_ICON: Record<string, TagIcon> = {
  complete: {
    name: 'check',
    fg: 'var(--status-saving)',
    bg: 'var(--green-tint)',
  },
  preSwitch: {
    name: 'clock',
    fg: 'var(--status-caution)',
    bg: 'var(--amber-tint)',
  },
  mixed: {
    name: 'clock',
    fg: 'var(--status-caution)',
    bg: 'var(--amber-tint)',
  },
  partial: {
    name: 'clock',
    fg: 'var(--status-caution)',
    bg: 'var(--amber-tint)',
  },
  incomplete: FALLBACK_TAG,
  mismatch: { name: 'alert', fg: 'var(--status-risk)', bg: 'var(--red-tint)' },
};

// One slot row + its optional flag note. Out-of-period slots are shown, never
// priced; missing slots read as a gap, not zero.
function slotRow(s: SlotCalculation, maxAbsRateDelta: number): HTMLElement[] {
  let rowBg: string;
  let flagText = '';
  let flagFg = 'var(--text-muted)';
  if (s.flags.missingReading) {
    rowBg = 'var(--red-tint)';
    flagText = 'Missing reading — priced as a gap, not zero.';
    flagFg = 'var(--status-risk)';
  } else if (s.flags.flexUnmatched || s.flags.agileUnmatched) {
    rowBg = 'var(--amber-tint)';
    flagText = 'No rate matched this slot.';
    flagFg = 'var(--status-caution)';
  } else if (s.flags.duplicate) {
    rowBg = 'var(--amber-tint)';
    flagText = 'Duplicate reading — kept one, ignored the other.';
    flagFg = 'var(--status-caution)';
  } else if (s.flags.outOfPeriod) {
    rowBg = 'var(--surface-sunken)';
    flagText = 'Outside the billing window — shown, not priced.';
  } else if (s.flexRate !== null && s.agileRate !== null) {
    const delta = s.flexRate - s.agileRate; // positive → Agile cheaper (green)
    const intensity = Math.round((Math.abs(delta) / maxAbsRateDelta) * 40) + 8;
    const color = delta >= 0 ? 'var(--status-saving)' : 'var(--status-risk)';
    rowBg = `color-mix(in srgb, ${color} ${intensity}%, transparent)`;
  } else {
    rowBg = 'var(--surface-card)';
  }

  const kwhText = s.flags.missingReading ? 'missing' : s.kwh === null ? '—' : s.kwh.toFixed(2);

  const flexText = s.flags.outOfPeriod
    ? '—'
    : s.flags.missingReading
      ? 'n/a'
      : s.flags.flexUnmatched || s.flexCostPence === null || s.flexRate === null
        ? 'unmatched'
        : `${fmtMoney(s.flexCostPence)} (${fmtPence(s.flexRate)})`;

  const agileText = s.flags.outOfPeriod
    ? '—'
    : s.flags.missingReading
      ? 'n/a'
      : s.flags.agileUnmatched
        ? 'unmatched'
        : s.agileCostPence === null || s.agileRate === null
          ? 'n/a'
          : `${fmtMoney(s.agileCostPence)} (${fmtPence(s.agileRate)})`;

  const row = el('div', { class: 'slot-row', style: `background:${rowBg}` }, [
    el('span', { text: fmtSlotTime(s.intervalStart, s.intervalEnd) }),
    el('span', {
      class: 'tnum',
      style: s.flags.missingReading ? 'color:var(--status-risk)' : '',
      text: kwhText,
    }),
    el('span', {
      class: 'tnum',
      style: s.flags.flexUnmatched ? 'color:var(--status-caution)' : '',
      text: flexText,
    }),
    el('span', {
      class: 'tnum',
      style: s.flags.agileUnmatched ? 'color:var(--status-caution)' : '',
      text: agileText,
    }),
  ]);
  if (!flagText) return [row];
  return [
    row,
    el('div', { class: 'slot-flag', style: `background:${rowBg};color:${flagFg}` }, [flagText]),
  ];
}

function slotGrid(
  day: DayComparison,
  run: ComparisonRun,
  period: { start: Date; end: Date },
  columns: HeadlineColumns,
): HTMLElement {
  const slots = buildSlotCalculations(day.date, period, run.detail);
  const rateDeltas = slots
    .filter((s) => s.flexRate !== null && s.agileRate !== null && !s.flags.outOfPeriod)
    .map((s) => (s.flexRate ?? 0) - (s.agileRate ?? 0));
  const maxAbsRateDelta = Math.max(1, ...rateDeltas.map(Math.abs));
  const head = el('div', { class: 'slot-grid-head' }, [
    el('span', { text: 'Slot' }),
    el('span', { class: 'tnum', text: 'kWh' }),
    el('span', {
      class: 'tnum',
      text: `${withYours(columns, columns.flexLabel, 'flex')} (Unit £)`,
    }),
    el('span', {
      class: 'tnum',
      text: `${withYours(columns, columns.agileLabel, 'agile')} (Unit £)`,
    }),
  ]);
  const standingRow = el('div', { class: 'slot-row', style: 'background:var(--surface-sunken)' }, [
    el('span', { text: 'Standing charge' }),
    el('span', { class: 'tnum muted', text: '—' }),
    el('span', {
      class: 'tnum muted',
      text: fmtMoney(day.standingPence.flex),
    }),
    el('span', {
      class: 'tnum muted',
      text: day.standingPence.agile === null ? 'n/a' : fmtMoney(day.standingPence.agile),
    }),
  ]);
  const scroll = el('div', { class: 'slot-scroll' }, [
    standingRow,
    ...slots.flatMap((s) => slotRow(s, maxAbsRateDelta)),
  ]);
  return el('div', { style: 'border-top:1px solid var(--border-soft)' }, [head, scroll]);
}

// The header shown above a selected day's slot grid in the calendar detail panel.
// Mirrors the period row's dual readout: kWh, then Flex £ and Agile £.
function dayDetailHead(day: DayComparison, columns: HeadlineColumns): HTMLElement {
  const agileText = day.agileTotalPence === null ? 'n/a' : fmtMoney(day.agileTotalPence);
  return el('div', { class: 'cal-detail-head' }, [
    el('span', { class: 'day-date', text: fmtDate(day.date) }),
    day.flags.hasUnmatched
      ? badge('Check slots', 'caution')
      : day.flags.partial
        ? badge('Partial', 'caution')
        : null,
    el('span', {
      class: 'mono',
      style: 'margin-left:auto;font-size:var(--text-caption);color:var(--text-muted);opacity:0.7',
      text: fmtKwh(day.kwh, 1),
    }),
    el('span', {
      class: 'mono',
      style: 'font-size:var(--text-data-sm);color:var(--text-muted)',
      text: `${withYours(columns, columns.flexLabel, 'flex')} ${fmtMoney(day.flexTotalPence)}`,
    }),
    el('span', {
      class: 'mono',
      style: 'font-size:var(--text-data-sm);color:var(--text-strong)',
      text: `${withYours(columns, columns.agileLabel, 'agile')} ${agileText}`,
    }),
  ]);
}

// A month calendar: each cell is tinted green (Agile cheaper) or red (Agile
// pricier) relative to Flex, intensity proportional to the gap. Tapping a day
// reveals its 48 half-hour slots in a detail panel below (built once, cached).
function dayCalendar(
  days: DayComparison[],
  run: ComparisonRun,
  period: { start: Date; end: Date },
  columns: HeadlineColumns,
): HTMLElement {
  // delta = Flex − Agile: positive → Agile cheaper (green), negative → Agile pricier (red)
  const agileDeltas = days
    .filter((d) => d.agileTotalPence !== null)
    .map((d) => d.flexTotalPence - (d.agileTotalPence ?? 0));
  const maxAbsDelta = Math.max(1, ...agileDeltas.map(Math.abs));

  const detail = el('div', { class: 'cal-detail' });
  const gridCache = new Map<number, HTMLElement>();
  let selected: HTMLElement | null = null;
  const showDay = (day: DayComparison, cell: HTMLElement): void => {
    if (selected) selected.classList.remove('is-selected');
    cell.classList.add('is-selected');
    selected = cell;
    let grid = gridCache.get(day.date.getTime());
    if (!grid) {
      grid = slotGrid(day, run, period, columns);
      gridCache.set(day.date.getTime(), grid);
    }
    clear(detail);
    detail.append(dayDetailHead(day, columns), grid);
  };

  // Group by calendar month (a period is usually one month, but handle spans).
  const months = new Map<string, DayComparison[]>();
  for (const d of days) {
    const key = `${d.date.getUTCFullYear()}-${d.date.getUTCMonth()}`;
    const bucket = months.get(key);
    if (bucket) bucket.push(d);
    else months.set(key, [d]);
  }

  const grids: HTMLElement[] = [];
  for (const monthDays of months.values()) {
    const first = monthDays[0];
    if (!first) continue;
    const firstDate = first.date;
    const cells: (HTMLElement | null)[] = WEEKDAYS.map((w) =>
      el('span', { class: 'cal-weekday', text: w }),
    );
    for (let i = 0; i < mondayIndex(firstDate); i++) {
      cells.push(el('span', { class: 'cal-cell cal-cell-empty' }));
    }
    for (const d of monthDays) {
      let cellBg: string;
      if (d.agileTotalPence === null) {
        cellBg = 'transparent';
      } else {
        const delta = d.flexTotalPence - d.agileTotalPence;
        const intensity = Math.round((Math.abs(delta) / maxAbsDelta) * 40) + 8;
        const color = delta >= 0 ? 'var(--status-saving)' : 'var(--status-risk)';
        cellBg = `color-mix(in srgb, ${color} ${intensity}%, transparent)`;
      }
      const agileLabel = d.agileTotalPence === null ? '—' : fmtMoney(d.agileTotalPence);
      const flagged = d.flags.hasUnmatched || d.flags.partial;
      const cell = el(
        'button',
        {
          class: 'cal-cell',
          type: 'button',
          title: `${fmtDate(d.date)} · ${fmtKwh(d.kwh, 1)} · ${withYours(columns, columns.flexLabel, 'flex')} ${fmtMoney(d.flexTotalPence)} · ${withYours(columns, columns.agileLabel, 'agile')} ${agileLabel}`,
          style: `background:${cellBg}`,
        },
        [
          el('span', { class: 'cal-day', text: String(d.date.getUTCDate()) }),
          flagged ? el('span', { class: 'cal-flag' }) : null,
          el('span', {
            class: 'cal-cost mono',
            text: `${fmtMoney(d.flexTotalPence)} / ${agileLabel}`,
          }),
        ],
      );
      cell.addEventListener('click', () => showDay(d, cell));
      cells.push(cell);
    }
    grids.push(
      el('div', {}, [
        el('div', {
          class: 'cal-month',
          text: `${MONTHS[firstDate.getUTCMonth()]} ${firstDate.getUTCFullYear()}`,
        }),
        el('div', { class: 'cal-grid' }, cells),
      ]),
    );
  }

  return el('div', { class: 'drill' }, [
    el('div', {
      class: 'drill-hint',
      text: 'Green = Agile cheaper, red = Agile pricier. Tap a day for its 48 half-hours.',
    }),
    ...grids,
    detail,
  ]);
}

// A period row that lazily reveals its day totals, each of which lazily reveals
// 48 slots. Child DOM is built on first expand and cached — never ~19k rows at
// once. Returns the whole card element.
export function renderPeriodRow(
  vm: PeriodRowVM,
  run: ComparisonRun,
  columns: HeadlineColumns,
): HTMLElement {
  const ti = TAG_ICON[vm.status] ?? FALLBACK_TAG;
  const tag = el('span', { class: 'row-tag', style: `background:${ti.bg};color:${ti.fg}` }, [
    icon(ICONS[ti.name], 15, 2.2),
  ]);
  const chevron = el('span', { class: 'chevron', style: vm.expandable ? '' : 'opacity:0.25' }, [
    icon(ICONS.chevronRight, 17),
  ]);
  const head = el(
    'div',
    {
      class: 'row',
      style: vm.expandable ? 'cursor:pointer' : 'cursor:default',
    },
    [
      tag,
      el('div', { class: 'row-main' }, [
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
          el('span', { class: 'row-title', text: vm.title }),
          badge(vm.tag, vm.tagTone as Tone),
        ]),
        el('span', { class: 'row-sub', text: vm.reason }),
      ]),
      el(
        'div',
        {
          style: 'display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:104px',
        },
        [
          el('span', {
            class: 'mono',
            style: 'font-size:var(--text-data-sm);color:var(--text-strong)',
            text:
              `${withYours(columns, columns.agileLabel, 'agile')} ${vm.agileText}` +
              (vm.agileAvgPence !== null
                ? ` (${vm.agileAvgPence.toFixed(1)}p/kWh)`
                : ''),
          }),
          el('span', {
            class: 'mono',
            style: 'font-size:var(--text-caption);color:var(--text-muted)',
            text:
              `${withYours(columns, columns.flexLabel, 'flex')} ${vm.flexText}` +
              (vm.flexAvgPence !== null
                ? ` (${vm.flexAvgPence.toFixed(1)}p/kWh)`
                : ''),
          }),
          el('span', {
            class: 'mono',
            style: 'font-size:var(--text-caption);color:var(--text-muted);opacity:0.65',
            text: vm.kwhText,
          }),
        ],
      ),
      chevron,
    ],
  );
  const card = el(
    'div',
    {
      style:
        'border:1px solid var(--border-soft);border-radius:var(--radius-md);overflow:hidden;background:var(--surface-card)',
    },
    [head],
  );

  if (!vm.expandable) return card;

  let dayList: HTMLElement | null = null;
  let open = false;
  head.addEventListener('click', () => {
    open = !open;
    chevron.classList.toggle('is-open', open);
    head.classList.toggle('is-selected', open);
    if (open && !dayList) {
      const days = buildDayComparisons(vm.period, run.detail);
      dayList = dayCalendar(days, run, vm.period, columns);
      card.append(dayList);
    } else if (dayList) {
      dayList.style.display = open ? '' : 'none';
    }
  });
  return card;
}
