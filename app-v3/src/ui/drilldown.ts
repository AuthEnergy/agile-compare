import { buildDayComparisons, buildSlotCalculations } from '../domain/drilldown';
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

// Monday-first column index (0 = Mon … 6 = Sun) for a UTC date.
const mondayIndex = (d: Date): number => (d.getUTCDay() + 6) % 7;

const dayCost = (d: DayComparison): number => d.agileTotalPence ?? d.flexTotalPence ?? 0;

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
  complete: { name: 'check', fg: 'var(--status-saving)', bg: 'var(--green-tint)' },
  preSwitch: { name: 'clock', fg: 'var(--status-caution)', bg: 'var(--amber-tint)' },
  mixed: { name: 'clock', fg: 'var(--status-caution)', bg: 'var(--amber-tint)' },
  partial: { name: 'clock', fg: 'var(--status-caution)', bg: 'var(--amber-tint)' },
  incomplete: FALLBACK_TAG,
  mismatch: { name: 'alert', fg: 'var(--status-risk)', bg: 'var(--red-tint)' },
};

// One slot row + its optional flag note. Out-of-period slots are shown, never
// priced; missing slots read as a gap, not zero.
function slotRow(s: SlotCalculation): HTMLElement[] {
  let rowBg = 'var(--surface-card)';
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
  }

  const kwhText = s.flags.missingReading ? 'missing' : s.kwh === null ? '—' : s.kwh.toFixed(2);
  const agileText = s.flags.agileUnmatched
    ? 'unmatched'
    : s.agileRate === null
      ? '—'
      : fmtPence(s.agileRate);
  const costText = s.agileCostPence === null ? 'n/a' : fmtMoney(s.agileCostPence);

  const row = el('div', { class: 'slot-row', style: `background:${rowBg}` }, [
    el('span', { text: fmtSlotTime(s.intervalStart) }),
    el('span', {
      class: 'tnum',
      style: s.flags.missingReading ? 'color:var(--status-risk)' : '',
      text: kwhText,
    }),
    el('span', { class: 'tnum muted', text: s.flexRate === null ? '—' : fmtPence(s.flexRate) }),
    el('span', {
      class: 'tnum',
      style: s.flags.agileUnmatched ? 'color:var(--status-caution)' : '',
      text: agileText,
    }),
    el('span', { class: 'tnum', style: 'font-weight:500', text: costText }),
  ]);
  if (!flagText) return [row];
  return [
    row,
    el('div', { class: 'slot-flag', style: `background:${rowBg};color:${flagFg}` }, [flagText]),
  ];
}

function slotGrid(
  dayMid: Date,
  run: ComparisonRun,
  period: { start: Date; end: Date },
): HTMLElement {
  const slots = buildSlotCalculations(dayMid, period, run.detail);
  const head = el('div', { class: 'slot-grid-head' }, [
    el('span', { text: 'Slot' }),
    el('span', { class: 'tnum', text: 'kWh' }),
    el('span', { class: 'tnum', text: 'Flex' }),
    el('span', { class: 'tnum', text: 'Agile' }),
    el('span', { class: 'tnum', text: 'Cost' }),
  ]);
  const scroll = el('div', { class: 'slot-scroll' }, slots.flatMap(slotRow));
  return el('div', { style: 'border-top:1px solid var(--border-soft)' }, [head, scroll]);
}

// The header shown above a selected day's slot grid in the calendar detail panel.
// Mirrors the period row's dual readout: kWh, then Flex £ and Agile £.
function dayDetailHead(day: DayComparison): HTMLElement {
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
      text: `Flex ${fmtMoney(day.flexTotalPence)}`,
    }),
    el('span', {
      class: 'mono',
      style: 'font-size:var(--text-data-sm);color:var(--text-strong)',
      text: `Agile ${agileText}`,
    }),
  ]);
}

// A month calendar of daily cost: each cell is heat-tinted by cost (darker =
// pricier) so the whole month reads at a glance. Tapping a day reveals its 48
// half-hour slots in a detail panel below (built once per day, then cached).
function dayCalendar(
  days: DayComparison[],
  run: ComparisonRun,
  period: { start: Date; end: Date },
): HTMLElement {
  const maxCost = Math.max(1, ...days.map(dayCost));

  const detail = el('div', { class: 'cal-detail' });
  const gridCache = new Map<number, HTMLElement>();
  let selected: HTMLElement | null = null;
  const showDay = (day: DayComparison, cell: HTMLElement): void => {
    if (selected) selected.classList.remove('is-selected');
    cell.classList.add('is-selected');
    selected = cell;
    let grid = gridCache.get(day.date.getTime());
    if (!grid) {
      grid = slotGrid(day.date, run, period);
      gridCache.set(day.date.getTime(), grid);
    }
    clear(detail);
    detail.append(dayDetailHead(day), grid);
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
      const cost = dayCost(d);
      // 6%…50% tint of the theme's accent — keeps the day number readable while
      // still showing the cost gradient across the month, in light and dark.
      const intensity = Math.round((cost / maxCost) * 44) + 6;
      const flagged = d.flags.hasUnmatched || d.flags.partial;
      const cell = el(
        'button',
        {
          class: 'cal-cell',
          type: 'button',
          title: `${fmtDate(d.date)} · ${fmtKwh(d.kwh, 1)} · ${fmtMoney(cost)}`,
          style: `background:color-mix(in srgb, var(--grid-blue) ${intensity}%, transparent)`,
        },
        [
          el('span', { class: 'cal-day', text: String(d.date.getUTCDate()) }),
          flagged ? el('span', { class: 'cal-flag' }) : null,
          el('span', { class: 'cal-cost mono', text: fmtMoney(cost) }),
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
      text: 'Daily cost — darker is pricier. Tap a day for its 48 half-hours.',
    }),
    ...grids,
    detail,
  ]);
}

// A period row that lazily reveals its day totals, each of which lazily reveals
// 48 slots. Child DOM is built on first expand and cached — never ~19k rows at
// once. Returns the whole card element.
export function renderPeriodRow(vm: PeriodRowVM, run: ComparisonRun): HTMLElement {
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
            text: `Agile ${vm.agileText}`,
          }),
          el('span', {
            class: 'mono',
            style: 'font-size:var(--text-caption);color:var(--text-muted)',
            text: `Flex ${vm.flexText}`,
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
      dayList = dayCalendar(days, run, vm.period);
      card.append(dayList);
    } else if (dayList) {
      dayList.style.display = open ? '' : 'none';
    }
  });
  return card;
}
