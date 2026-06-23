import type { RateWindow } from '../types/domain';
import { button, callout } from './components';
import { el } from './dom';
import { ICONS } from './icons';
import { icon } from './dom';

export interface TariffColumn {
  unitWindows: RateWindow[];
  standingWindows: RateWindow[];
  label: string;
}

export interface TariffOverrideModalOptions {
  // Label for the "keep your side" option in the left column picker.
  flexLabel: string;
  // Prefill manual rate entry for left/right columns (from a previous manual override).
  prefillLeft: { unitRate: number; standingCharge: number } | null;
  prefillRight: { unitRate: number; standingCharge: number } | null;
  // Pre-select these tariff names when the modal opens (from a previous selection).
  leftSelection: string | null;
  rightSelection: string | null;
  // When provided, shows the tariff picker UI. null = manual-entry-only (sample/replay).
  loadTariffNames: (() => Promise<string[]>) | null;
  fetchRatesByName:
    | ((
        name: string,
      ) => Promise<{ unitWindows: RateWindow[]; standingWindows: RateWindow[] } | null>)
    | null;
  // null for either side means "keep existing rates unchanged".
  onApply: (flex: TariffColumn | null, agile: TariffColumn | null) => void;
}

const KEEP_FLEX = '__keep_flex__';
const KEEP_AGILE = '__keep_agile__';
const MANUAL = '__manual__';

// Injected once per page session so the indeterminate keyframe is available.
let barStylesInjected = false;
function ensureBarStyles(): void {
  if (barStylesInjected) return;
  barStylesInjected = true;
  const s = document.createElement('style');
  s.textContent =
    '@keyframes tariff-bar{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}' +
    '.tariff-bar-fill{width:40%;height:100%;border-radius:var(--radius-pill);' +
    'background:var(--grid-blue);animation:tariff-bar 1.4s ease-in-out infinite}';
  document.head.appendChild(s);
}

function makeProgressBar(): {
  wrap: HTMLElement;
  show: (label: string) => void;
  hide: () => void;
} {
  ensureBarStyles();
  const fill = el('div', { class: 'tariff-bar-fill' });
  const track = el('div', { class: 'steps-track', style: 'overflow:hidden' }, [fill]);
  const labelEl = el('div', { class: 'field-hint', style: 'margin-top:4px' });
  const wrap = el('div', { style: 'display:none;margin-bottom:12px' }, [track, labelEl]);
  return {
    wrap,
    show(label: string) {
      labelEl.textContent = label;
      wrap.style.display = '';
    },
    hide() {
      wrap.style.display = 'none';
    },
  };
}

function makeSelect(defaultValue: string, defaultLabel: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'input';
  const opt = document.createElement('option');
  opt.value = defaultValue;
  opt.textContent = defaultLabel;
  sel.append(opt);
  return sel;
}

function addOption(sel: HTMLSelectElement, value: string, label: string): void {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  sel.append(opt);
}

function makeManualFields(prefill: { unitRate: number; standingCharge: number } | null): {
  wrap: HTMLElement;
  unitInput: HTMLInputElement;
  standingInput: HTMLInputElement;
} {
  const unitInput = el('input', {
    class: 'input',
    type: 'number',
    placeholder: 'e.g. 24.50',
    value: prefill ? String(prefill.unitRate) : '',
  }) as HTMLInputElement;
  unitInput.min = '0.01';
  unitInput.step = '0.01';

  const standingInput = el('input', {
    class: 'input',
    type: 'number',
    placeholder: 'e.g. 53.27',
    value: prefill ? String(prefill.standingCharge) : '',
  }) as HTMLInputElement;
  standingInput.min = '0';
  standingInput.step = '0.01';

  const wrap = el('div', { style: 'display:none;margin-top:8px' }, [
    el('div', { class: 'field', style: 'margin-bottom:8px' }, [
      el('label', { class: 'field-label', text: 'Unit rate (p/kWh)' }),
      unitInput,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: 'Standing charge (p/day)' }),
      standingInput,
    ]),
  ]);

  return { wrap, unitInput, standingInput };
}

// Full two-column picker layout, shown when a live client is available.
function buildPickerModal(
  options: TariffOverrideModalOptions & {
    loadTariffNames: () => Promise<string[]>;
    fetchRatesByName: (
      name: string,
    ) => Promise<{ unitWindows: RateWindow[]; standingWindows: RateWindow[] } | null>;
  },
  close: () => void,
): HTMLElement {
  const { flexLabel, prefillLeft, prefillRight, leftSelection, rightSelection, onApply } = options;

  // --- Left column ---
  const leftSel = makeSelect(KEEP_FLEX, `Contracted Tariff (${flexLabel})`);
  const leftManual = makeManualFields(prefillLeft);
  const leftLoadingOpt = document.createElement('option');
  leftLoadingOpt.disabled = true;
  leftLoadingOpt.textContent = 'Loading available tariffs…';
  leftSel.append(leftLoadingOpt);
  addOption(leftSel, MANUAL, 'Enter rates manually');
  if (leftSelection) leftSel.value = leftSelection;

  // --- Right column ---
  const rightSel = makeSelect(KEEP_AGILE, 'Agile Octopus (default)');
  const rightManual = makeManualFields(prefillRight);
  const rightLoadingOpt = document.createElement('option');
  rightLoadingOpt.disabled = true;
  rightLoadingOpt.textContent = 'Loading available tariffs…';
  rightSel.append(rightLoadingOpt);
  addOption(rightSel, MANUAL, 'Enter rates manually');
  if (rightSelection) rightSel.value = rightSelection;

  const errorMsg = el('span', {
    class: 'field-hint',
    style: 'color:var(--status-risk);display:none',
  });

  const progress = makeProgressBar();

  const applyBtn = button('Apply', { variant: 'primary', onClick: () => void handleApply() });

  function showError(msg: string): void {
    progress.hide();
    errorMsg.textContent = msg;
    errorMsg.style.display = '';
  }
  function clearError(): void {
    errorMsg.style.display = 'none';
  }

  // Show/hide manual fields when the select changes.
  leftSel.addEventListener('change', () => {
    leftManual.wrap.style.display = leftSel.value === MANUAL ? '' : 'none';
  });
  rightSel.addEventListener('change', () => {
    rightManual.wrap.style.display = rightSel.value === MANUAL ? '' : 'none';
  });
  if ((leftSelection ?? KEEP_FLEX) === MANUAL) leftManual.wrap.style.display = '';
  if ((rightSelection ?? KEEP_AGILE) === MANUAL) rightManual.wrap.style.display = '';

  async function handleApply(): Promise<void> {
    clearError();
    const leftVal = leftSel.value;
    const rightVal = rightSel.value;

    // Validate manual fields if selected.
    if (leftVal === MANUAL) {
      const u = parseFloat(leftManual.unitInput.value);
      const s = parseFloat(leftManual.standingInput.value);
      if (!Number.isFinite(u) || u <= 0 || !Number.isFinite(s) || s < 0) {
        showError(
          'Left column: enter a unit rate greater than zero and a standing charge of zero or more.',
        );
        return;
      }
    }
    if (rightVal === MANUAL) {
      const u = parseFloat(rightManual.unitInput.value);
      const s = parseFloat(rightManual.standingInput.value);
      if (!Number.isFinite(u) || u <= 0 || !Number.isFinite(s) || s < 0) {
        showError(
          'Right column: enter a unit rate greater than zero and a standing charge of zero or more.',
        );
        return;
      }
    }
    if (leftVal === KEEP_FLEX && rightVal === KEEP_AGILE) {
      close();
      return;
    }

    // Fetch named tariff rates if needed.
    const needFetch =
      (leftVal !== KEEP_FLEX && leftVal !== MANUAL) ||
      (rightVal !== KEEP_AGILE && rightVal !== MANUAL);

    if (needFetch) {
      applyBtn.setAttribute('disabled', '');
    }

    let flexCol: TariffColumn | null = null;
    let agileCol: TariffColumn | null = null;

    try {
      if (leftVal === MANUAL) {
        const unitRate = parseFloat(leftManual.unitInput.value);
        const standingCharge = parseFloat(leftManual.standingInput.value);
        const from = new Date(0);
        const to = new Date(32503680000000);
        flexCol = {
          unitWindows: [{ validFrom: from, validTo: to, value: unitRate }],
          standingWindows: [{ validFrom: from, validTo: to, value: standingCharge }],
          label: 'User tariff',
        };
      } else if (leftVal !== KEEP_FLEX) {
        progress.show(`Fetching rates for ${leftVal}…`);
        const rates = await options.fetchRatesByName(leftVal);
        progress.hide();
        if (!rates) {
          showError(
            `Could not fetch rates for "${leftVal}". Try a different tariff or enter manually.`,
          );
          applyBtn.removeAttribute('disabled');
          return;
        }
        flexCol = { ...rates, label: leftVal };
      }

      if (rightVal === MANUAL) {
        const unitRate = parseFloat(rightManual.unitInput.value);
        const standingCharge = parseFloat(rightManual.standingInput.value);
        const from = new Date(0);
        const to = new Date(32503680000000);
        agileCol = {
          unitWindows: [{ validFrom: from, validTo: to, value: unitRate }],
          standingWindows: [{ validFrom: from, validTo: to, value: standingCharge }],
          label: 'User tariff',
        };
      } else if (rightVal !== KEEP_AGILE) {
        progress.show(`Fetching rates for ${rightVal}…`);
        const rates = await options.fetchRatesByName(rightVal);
        progress.hide();
        if (!rates) {
          showError(
            `Could not fetch rates for "${rightVal}". Try a different tariff or enter manually.`,
          );
          applyBtn.removeAttribute('disabled');
          return;
        }
        agileCol = { ...rates, label: rightVal };
      }
    } catch {
      showError('Failed to fetch tariff rates. Check your connection and try again.');
      applyBtn.removeAttribute('disabled');
      return;
    }

    close();
    onApply(flexCol, agileCol);
  }

  const leftField = el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: 'Left column — base calclation' }),
    el('div', {
      class: 'field-hint',
      text: 'What your usage is priced against. Defaults to your current tariff.',
    }),
    leftSel,
    leftManual.wrap,
  ]);

  const rightField = el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: 'Right column — comparison' }),
    el('div', {
      class: 'field-hint',
      text: 'The tariff to compare against. Defaults to Agile Octopus.',
    }),
    rightSel,
    rightManual.wrap,
  ]);

  // Load tariff names and populate both selects; show the progress bar while loading.
  progress.show('Loading available tariffs…');
  void options.loadTariffNames().then(
    (names) => {
      progress.hide();
      leftLoadingOpt.remove();
      rightLoadingOpt.remove();
      const manualOptL = [...leftSel.options].find((o) => o.value === MANUAL);
      const manualOptR = [...rightSel.options].find((o) => o.value === MANUAL);
      // Insert tariff names before the manual option.
      for (const name of names) {
        const oL = document.createElement('option');
        oL.value = name;
        oL.textContent = name;
        if (manualOptL) leftSel.insertBefore(oL, manualOptL);
        else leftSel.append(oL);

        const oR = document.createElement('option');
        oR.value = name;
        oR.textContent = name;
        if (manualOptR) rightSel.insertBefore(oR, manualOptR);
        else rightSel.append(oR);
      }
      // Restore pre-selections now that options exist.
      if (leftSelection) leftSel.value = leftSelection;
      if (rightSelection) rightSel.value = rightSelection;
    },
    () => {
      progress.hide();
      leftLoadingOpt.textContent = 'Could not load tariff list';
      rightLoadingOpt.textContent = 'Could not load tariff list';
    },
  );

  return el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, [
        el('div', { class: 'row-title', text: 'Choose tariffs to compare' }),
        el('div', {
          class: 'row-sub',
          text: 'Select the tariff for each column. Rates are fetched from the Octopus API for your region and billing window.',
        }),
      ]),
      el('button', { class: 'btn btn-ghost', type: 'button', ariaLabel: 'Close', onClick: close }, [
        icon(ICONS.x, 18),
      ]),
    ]),
    el('div', { class: 'modal-body' }, [progress.wrap, leftField, rightField, errorMsg]),
    el('div', { class: 'modal-foot' }, [
      button('Cancel', { variant: 'secondary', onClick: close }),
      applyBtn,
    ]),
  ]);
}

// Simple manual-entry-only layout, shown for sample/replay runs without a client.
function buildManualModal(options: TariffOverrideModalOptions, close: () => void): HTMLElement {
  const { prefillLeft, onApply } = options;

  const unitInput = el('input', {
    class: 'input',
    type: 'number',
    placeholder: 'e.g. 24.50',
    value: prefillLeft ? String(prefillLeft.unitRate) : '',
  }) as HTMLInputElement;
  unitInput.min = '0.01';
  unitInput.step = '0.01';

  const standingInput = el('input', {
    class: 'input',
    type: 'number',
    placeholder: 'e.g. 53.27',
    value: prefillLeft ? String(prefillLeft.standingCharge) : '',
  }) as HTMLInputElement;
  standingInput.min = '0';
  standingInput.step = '0.01';

  const errorMsg = el('span', {
    class: 'field-hint',
    style: 'color:var(--status-risk);display:none',
    text: 'Please enter a unit rate greater than zero and a standing charge of zero or more.',
  });

  return el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, [
        el('div', { class: 'row-title', text: 'Edit your tariff rates' }),
        el('div', {
          class: 'row-sub',
          text: 'Enter the unit rate and standing charge. These replace the API-fetched rates for every period and slot.',
        }),
      ]),
      el('button', { class: 'btn btn-ghost', type: 'button', ariaLabel: 'Close', onClick: close }, [
        icon(ICONS.x, 18),
      ]),
    ]),
    el('div', { class: 'modal-body' }, [
      callout(
        'Flat rate across all periods',
        'The same unit rate applies to every half-hour slot. Your tariff side is relabelled "User tariff" and the Agile comparison is unchanged.',
        'info',
        'info',
      ),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'Unit rate (p/kWh)' }),
        el('div', { class: 'field-hint', text: 'Pence per kilowatt-hour, e.g. 24.50' }),
        unitInput,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'Standing charge (p/day)' }),
        el('div', { class: 'field-hint', text: 'Pence per day, e.g. 53.27' }),
        standingInput,
      ]),
      errorMsg,
    ]),
    el('div', { class: 'modal-foot' }, [
      button('Cancel', { variant: 'secondary', onClick: close }),
      button('Apply', {
        variant: 'primary',
        onClick: () => {
          const unit = parseFloat(unitInput.value);
          const standing = parseFloat(standingInput.value);
          if (!Number.isFinite(unit) || !Number.isFinite(standing) || unit <= 0 || standing < 0) {
            errorMsg.style.display = '';
            return;
          }
          close();
          const from = new Date(0);
          const to = new Date(32503680000000);
          onApply(
            {
              unitWindows: [{ validFrom: from, validTo: to, value: unit }],
              standingWindows: [{ validFrom: from, validTo: to, value: standing }],
              label: 'User tariff',
            },
            null,
          );
        },
      }),
    ]),
  ]);
}

export function openTariffOverrideModal(options: TariffOverrideModalOptions): void {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = (): void => backdrop.remove();
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });

  const modal =
    options.loadTariffNames && options.fetchRatesByName
      ? buildPickerModal(
          options as TariffOverrideModalOptions & {
            loadTariffNames: () => Promise<string[]>;
            fetchRatesByName: (
              name: string,
            ) => Promise<{ unitWindows: RateWindow[]; standingWindows: RateWindow[] } | null>;
          },
          close,
        )
      : buildManualModal(options, close);

  backdrop.append(modal);
  document.body.append(backdrop);

  // Focus the first input or select.
  const first = modal.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
  first?.focus();
}
