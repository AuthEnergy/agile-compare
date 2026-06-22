import { button, callout } from './components';
import { el, icon } from './dom';
import { ICONS } from './icons';

// Modal that collects a flat unit rate (p/kWh) and standing charge (p/day)
// from the user, then calls onApply with the values.
export function openTariffOverrideModal(
  prefillUnit: number | null,
  prefillStanding: number | null,
  onApply: (unitRatePence: number, standingChargePence: number) => void,
): void {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = (): void => backdrop.remove();
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });

  const unitInput = el('input', {
    class: 'input',
    type: 'number',
    placeholder: 'e.g. 24.50',
    value: prefillUnit !== null ? String(prefillUnit) : '',
  });
  unitInput.setAttribute('min', '0.01');
  unitInput.setAttribute('step', '0.01');

  const standingInput = el('input', {
    class: 'input',
    type: 'number',
    placeholder: 'e.g. 53.27',
    value: prefillStanding !== null ? String(prefillStanding) : '',
  });
  standingInput.setAttribute('min', '0');
  standingInput.setAttribute('step', '0.01');

  const errorMsg = el('span', {
    class: 'field-hint',
    style: 'color:var(--status-risk);display:none',
    text: 'Please enter a unit rate greater than zero and a standing charge of zero or more.',
  });

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, [
        el('div', { class: 'row-title', text: 'Edit your tariff rates' }),
        el('div', {
          class: 'row-sub',
          text: 'Enter the unit rate and standing charge from your bill or tariff agreement. These replace the API-fetched rates for every period and slot.',
        }),
      ]),
      el(
        'button',
        {
          class: 'btn btn-ghost',
          type: 'button',
          ariaLabel: 'Close',
          onClick: close,
        },
        [icon(ICONS.x, 18)],
      ),
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
          const unit = parseFloat((unitInput as HTMLInputElement).value);
          const standing = parseFloat((standingInput as HTMLInputElement).value);
          if (!Number.isFinite(unit) || !Number.isFinite(standing) || unit <= 0 || standing < 0) {
            errorMsg.style.display = '';
            return;
          }
          close();
          onApply(unit, standing);
        },
      }),
    ]),
  ]);

  backdrop.append(modal);
  document.body.append(backdrop);
  (unitInput as HTMLInputElement).focus();
}
