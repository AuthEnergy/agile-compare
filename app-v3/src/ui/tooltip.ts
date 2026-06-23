// Singleton tooltip. One <div> appended to <body>, positioned with
// position:fixed so it escapes any overflow:hidden ancestor. Uses event
// delegation on document so it works for dynamically added elements.

let tipEl: HTMLElement | null = null;

function getTip(): HTMLElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'app-tooltip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function showTip(text: string, anchor: HTMLElement): void {
  const t = getTip();
  t.textContent = text;
  const r = anchor.getBoundingClientRect();
  t.style.left = `${Math.round(r.left + r.width / 2)}px`;
  t.style.top = `${Math.round(r.top - 6)}px`;
  t.style.transform = 'translate(-50%, -100%)';
  t.style.opacity = '1';
}

function hideTip(): void {
  if (tipEl) tipEl.style.opacity = '0';
}

export function initTooltips(): void {
  document.addEventListener('mouseover', (e: MouseEvent) => {
    const anchor = (e.target as Element).closest<HTMLElement>('[data-tooltip]');
    const text = anchor?.dataset.tooltip;
    if (!anchor || !text) {
      hideTip();
      return;
    }
    showTip(text, anchor);
  });

  document.addEventListener('mouseout', (e: MouseEvent) => {
    const anchor = (e.target as Element).closest('[data-tooltip]');
    if (!anchor) return;
    const dest = e.relatedTarget as Element | null;
    if (!dest || !anchor.contains(dest)) hideTip();
  });
}
