// Tiny DOM builder. No framework, no innerHTML for dynamic data — every text
// node goes through textContent so API-derived strings can't inject markup.

type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  style?: string;
  title?: string;
  type?: string;
  href?: string;
  target?: string;
  rel?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaChecked?: boolean;
  role?: string;
  dataset?: Record<string, string>;
  onClick?: (ev: MouseEvent) => void;
  onInput?: (ev: Event) => void;
  onChange?: (ev: Event) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.style) node.setAttribute('style', props.style);
  if (props.title !== undefined) node.title = props.title;
  if (props.type) node.setAttribute('type', props.type);
  if (props.href !== undefined) node.setAttribute('href', props.href);
  if (props.target) node.setAttribute('target', props.target);
  if (props.rel) node.setAttribute('rel', props.rel);
  if (props.placeholder !== undefined) node.setAttribute('placeholder', props.placeholder);
  if (props.value !== undefined) (node as { value?: string }).value = props.value;
  if (props.disabled) (node as { disabled?: boolean }).disabled = true;
  if (props.ariaLabel !== undefined) node.setAttribute('aria-label', props.ariaLabel);
  if (props.ariaChecked !== undefined) node.setAttribute('aria-checked', String(props.ariaChecked));
  if (props.role) node.setAttribute('role', props.role);
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.onClick) node.addEventListener('click', props.onClick as EventListener);
  if (props.onInput) node.addEventListener('input', props.onInput as EventListener);
  if (props.onChange) node.addEventListener('change', props.onChange as EventListener);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// Inline SVG icon. Path data is static/trusted (from icons.ts), so html is safe.
export function icon(pathData: string, size = 16, stroke = 2): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = pathData;
  return svg;
}

// The Auth Energy brand mark — a FILL svg (its own viewBox/aspect ratio).
export function logo(pathData: string, height = 24): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(Math.round((26.97 / 43.969) * height)));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', '0 0 26.97 43.969');
  svg.setAttribute('fill', 'currentColor');
  svg.innerHTML = pathData;
  return svg;
}
