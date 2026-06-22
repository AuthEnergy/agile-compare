import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTariffOverrideModal } from '../../src/ui/tariffOverrideModal';

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

describe('openTariffOverrideModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('accepts a zero standing charge', () => {
    const onApply = vi.fn();
    openTariffOverrideModal(null, null, onApply);
    const [unit, standing] = inputs();
    unit.value = '24.5';
    standing.value = '0';

    applyButton().click();

    expect(onApply).toHaveBeenCalledWith(24.5, 0);
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('still rejects a zero unit rate', () => {
    const onApply = vi.fn();
    openTariffOverrideModal(null, null, onApply);
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
    openTariffOverrideModal(null, null, onApply);
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
