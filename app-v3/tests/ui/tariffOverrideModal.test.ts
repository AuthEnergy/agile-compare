import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openTariffOverrideModal,
  type TariffOverrideModalOptions,
} from '../../src/ui/tariffOverrideModal';

function applyButton(): HTMLButtonElement {
  const btn = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Apply',
  );
  if (!btn) throw new Error('Apply button not found');
  return btn;
}

function inputs(): [HTMLInputElement, HTMLInputElement] {
  const found = [...document.querySelectorAll<HTMLInputElement>('input')];
  const unit = found[0];
  const standing = found[1];
  if (!unit || !standing) throw new Error('rate inputs not found');
  return [unit, standing];
}

// Helper: open the modal in manual-only mode (no live client / tariff list).
function openManual(onApply: TariffOverrideModalOptions['onApply']): void {
  openTariffOverrideModal({
    flexLabel: 'Flexible',
    prefillLeft: null,
    prefillRight: null,
    leftSelection: null,
    rightSelection: null,
    loadTariffNames: null,
    fetchRatesByName: null,
    onApply,
  });
}

describe('openTariffOverrideModal — manual-entry mode (no client)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('accepts a zero standing charge', () => {
    const onApply = vi.fn();
    openManual(onApply);
    const [unit, standing] = inputs();
    unit.value = '24.5';
    standing.value = '0';

    applyButton().click();

    expect(onApply).toHaveBeenCalledOnce();
    const [flex, agile] = onApply.mock.calls[0] as [unknown, unknown];
    expect(agile).toBeNull();
    expect(flex).toMatchObject({ label: 'User tariff' });
    expect((flex as { unitWindows: { value: number }[] }).unitWindows[0]?.value).toBe(24.5);
    expect((flex as { standingWindows: { value: number }[] }).standingWindows[0]?.value).toBe(0);
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('still rejects a zero unit rate', () => {
    const onApply = vi.fn();
    openManual(onApply);
    const [unit, standing] = inputs();
    unit.value = '0';
    standing.value = '0';

    applyButton().click();

    expect(onApply).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('unit rate greater than zero');
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    expect(unit.getAttribute('min')).toBe('0.01');
    expect(standing.getAttribute('min')).toBe('0');
  });

  it('rejects non-finite rates', () => {
    const onApply = vi.fn();
    openManual(onApply);
    const [unit, standing] = inputs();
    Object.defineProperty(unit, 'value', {
      configurable: true,
      get: () => 'Infinity',
    });
    standing.value = '0';

    applyButton().click();

    expect(onApply).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('unit rate greater than zero');
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
  });
});
