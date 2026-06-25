// The "Solar & battery" screen (Phase A — solar). Inputs with hard validation/caps,
// a Calculate action, then the figures/table/caveats from the pure view-model.
// British English, sentence case, no emoji. addEventListener only (via el); every
// derived string goes through textContent, never innerHTML.

import { badge, button, callout, savingsFigure } from './components';
import { el } from './dom';
import { computeSolarViewModel } from './solarViewModel';
import { DEFAULT_SOLAR_CONFIG, SOLAR_LIMITS, type SolarConfig } from '../types/solar';
import type { SolarRun } from '../types/solar';

export interface SolarScreenState {
  solar: SolarRun | null;
  config: SolarConfig;
  segPence: number;
  busy: boolean;
  error: string | null;
}

export interface SolarCallbacks {
  onCalculate: (cfg: SolarConfig, segPence: number) => void;
  onBack: () => void;
}

const DIRECTIONS: Array<{ label: string; az: number }> = [
  { label: 'South', az: 0 },
  { label: 'South-east', az: -45 },
  { label: 'South-west', az: 45 },
  { label: 'East', az: -90 },
  { label: 'West', az: 90 },
  { label: 'North-east', az: -135 },
  { label: 'North-west', az: 135 },
  { label: 'North', az: 180 },
];

function nearestDirection(az: number): number {
  let bestAz = 0;
  let bestDelta = Infinity;
  for (const d of DIRECTIONS) {
    const delta = Math.abs(d.az - az);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestAz = d.az;
    }
  }
  return bestAz;
}

// Parse + clamp a numeric input; NaN/empty falls back to the supplied default.
function clampNum(raw: string, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function numberField(
  label: string,
  hint: string,
  value: string,
  onInput: (raw: string) => void,
): HTMLElement {
  const input = el('input', {
    class: 'input mono',
    type: 'number',
    value,
    onInput: (ev) => onInput((ev.target as HTMLInputElement).value),
  });
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: label }),
    input,
    el('span', { class: 'field-hint', text: hint }),
  ]);
}

function directionField(value: number, onChange: (az: number) => void): HTMLElement {
  const select = el(
    'select',
    {
      class: 'input',
      onChange: (ev) => onChange(Number((ev.target as HTMLSelectElement).value)),
    },
    DIRECTIONS.map((d) => el('option', { value: String(d.az), text: d.label })),
  );
  (select as HTMLSelectElement).value = String(nearestDirection(value));
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: 'Roof direction' }),
    select,
    el('span', { class: 'field-hint', text: 'Which way the panels face' }),
  ]);
}

function renderInputs(host: HTMLElement, state: SolarScreenState, cb: SolarCallbacks): void {
  // Working copy seeded from the persisted config; Calculate reads this (clamped).
  const work: SolarConfig = { ...state.config };
  let inverterRaw =
    state.config.inverterAcKw !== undefined ? String(state.config.inverterAcKw) : '';
  let segRaw = String(state.segPence);

  const L = SOLAR_LIMITS;
  const grid = el('div', { class: 'solar-input-grid' }, [
    numberField(
      'Array size (kW)',
      'Total panel capacity, e.g. 4.0',
      String(work.arrayKwp),
      (raw) => {
        work.arrayKwp = clampNum(
          raw,
          L.arrayKwp.min,
          L.arrayKwp.max,
          DEFAULT_SOLAR_CONFIG.arrayKwp,
        );
      },
    ),
    directionField(work.azimuthDegFromSouth, (az) => {
      work.azimuthDegFromSouth = az;
    }),
    numberField(
      'Tilt (°)',
      '0 is flat, 35 is a typical pitched roof',
      String(work.tiltDeg),
      (raw) => {
        work.tiltDeg = clampNum(raw, L.tiltDeg.min, L.tiltDeg.max, DEFAULT_SOLAR_CONFIG.tiltDeg);
      },
    ),
  ]);

  // Advanced settings behind a native disclosure (CSP-safe, no script).
  const advanced = el('details', { class: 'solar-advanced' }, [
    el('summary', { text: 'Advanced settings' }),
    el('div', { class: 'solar-input-grid' }, [
      numberField(
        'System losses (%)',
        'Inverter, wiring and dirt — typically about 20%',
        String(Math.round((1 - work.systemLossFactor) * 100)),
        (raw) => {
          const lossPct = clampNum(raw, 5, 50, 20);
          work.systemLossFactor = Math.min(
            L.systemLossFactor.max,
            Math.max(L.systemLossFactor.min, 1 - lossPct / 100),
          );
        },
      ),
      numberField(
        'Inverter AC limit (kW)',
        'Optional — leave blank if unsure',
        inverterRaw,
        (raw) => {
          inverterRaw = raw;
        },
      ),
      numberField(
        'Assumed export rate (p/kWh)',
        'Used only if no Octopus export rate is found',
        segRaw,
        (raw) => {
          segRaw = raw;
        },
      ),
    ]),
  ]);

  const calcBtn = button(state.busy ? 'Calculating…' : 'Calculate', {
    variant: 'primary',
    size: 'lg',
    disabled: state.busy,
    onClick: () => {
      const cfg: SolarConfig = {
        arrayKwp: work.arrayKwp,
        tiltDeg: work.tiltDeg,
        azimuthDegFromSouth: work.azimuthDegFromSouth,
        systemLossFactor: work.systemLossFactor,
      };
      const inv = inverterRaw.trim();
      if (inv !== '') {
        cfg.inverterAcKw = clampNum(inv, L.inverterAcKw.min, L.inverterAcKw.max, cfg.arrayKwp);
      }
      const seg = clampNum(segRaw, 0, 100, state.segPence);
      cb.onCalculate(cfg, seg);
    },
  });

  host.append(
    el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' }, [
      el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [
        el('span', { class: 'row-title', style: 'font-size:var(--text-h3)', text: 'Your panels' }),
        el('span', {
          class: 'row-sub',
          text: 'Describe a system and we will value it on your real usage and rates.',
        }),
      ]),
      grid,
      advanced,
      el('div', { style: 'display:flex;justify-content:flex-end' }, [calcBtn]),
    ]),
  );
}

function renderResult(host: HTMLElement, run: SolarRun): void {
  const vm = computeSolarViewModel(run);

  // Headline: generation + a banded "would have been worth" figure.
  host.append(
    el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:6px' }, [
      el('span', { class: 'row-sub', text: vm.arraySummary }),
      el('span', { class: 'row-title', style: 'font-size:var(--text-h3)', text: vm.generated }),
      el('span', { class: 'row-sub', text: vm.generatedSub }),
      el(
        'div',
        { style: 'display:flex;flex-wrap:wrap;gap:18px;align-items:flex-end;margin-top:6px' },
        [
          savingsFigure({
            label: 'Worth about (would have)',
            amount: vm.value.amount,
            tone: 'saving',
          }),
          el('span', { class: 'row-sub', style: 'max-width:280px', text: vm.value.sub }),
        ],
      ),
      el('span', { class: 'row-sub', text: vm.coverage }),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:4px' }, [
        badge(vm.basis, 'info'),
        badge(vm.exportBasis, 'neutral'),
      ]),
    ]),
  );

  // Figure tiles.
  host.append(
    el(
      'div',
      { class: 'solar-tiles' },
      vm.tiles.map((t) =>
        el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:2px' }, [
          el('span', { class: 'figure-label', text: t.label }),
          el('span', { class: 'figure-amount', style: 'font-size:var(--text-h3)', text: t.amount }),
          t.caption ? el('span', { class: 'row-sub', text: t.caption }) : null,
        ]),
      ),
    ),
  );

  // Per-month table.
  if (vm.table) {
    const head = el('tr', {}, [
      el('th', { text: 'Month' }),
      el('th', { text: 'Generated' }),
      el('th', { text: 'Self-used' }),
      el('th', { text: 'Exported' }),
    ]);
    const body = vm.table.rows.map((r) =>
      el('tr', {}, [
        el('td', { text: r.label }),
        el('td', { class: 'mono', text: r.generated }),
        el('td', { class: 'mono', text: r.self }),
        el('td', { class: 'mono', text: r.exp }),
      ]),
    );
    host.append(
      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:10px' }, [
        el('span', {
          class: 'row-title',
          style: 'font-size:var(--text-h3)',
          text: 'Month by month',
        }),
        el('table', { class: 'solar-table' }, [el('thead', {}, [head]), el('tbody', {}, body)]),
        el('span', { class: 'row-sub', text: vm.table.foot }),
      ]),
    );
  }

  // Caveats — first-class, never hidden.
  host.append(
    el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px' }, [
      el('span', {
        class: 'row-title',
        style: 'font-size:var(--text-h3)',
        text: 'Read this alongside the figure',
      }),
      el(
        'ul',
        { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px' },
        vm.caveats.map((c) => el('li', { class: 'row-sub', text: c })),
      ),
    ]),
  );

  // Battery — clearly-labelled experimental placeholder (Phase B not yet shipped).
  host.append(callout(vm.battery.title, vm.battery.body, 'caution', 'info'));
}

export function renderSolar(host: HTMLElement, state: SolarScreenState, cb: SolarCallbacks): void {
  host.append(
    el('div', { style: 'display:flex;flex-direction:column;gap:7px;max-width:760px' }, [
      el('h1', { style: 'font-size:var(--text-h1)', text: 'Solar & battery' }),
      el('p', {
        class: 'lead',
        text: 'What rooftop solar would have been worth on your real usage and real rates — evidence, not a sales pitch.',
      }),
    ]),
  );

  if (state.error) {
    host.append(callout("That didn't work", state.error, 'risk', 'alert'));
  }

  renderInputs(host, state, cb);

  if (state.busy) {
    host.append(
      el('div', { style: 'display:flex;align-items:center;gap:11px;padding:8px 2px' }, [
        el('span', {
          style:
            'flex:none;width:18px;height:18px;border-radius:50%;border:2.5px solid var(--grid-blue-tint);border-top-color:var(--grid-blue);animation:ae-spin 700ms linear infinite',
        }),
        el('span', { class: 'row-sub', text: 'Fetching export rates and modelling generation…' }),
      ]),
    );
  } else if (state.solar) {
    renderResult(host, state.solar);
  }

  host.append(
    el('div', { style: 'padding-top:4px' }, [
      button('Back to comparison', { variant: 'secondary', onClick: cb.onBack }),
    ]),
  );
}
