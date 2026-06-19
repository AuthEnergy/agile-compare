import { el, icon, type ElProps } from './dom';
import { ICONS, type IconName } from './icons';

export type Tone = 'saving' | 'caution' | 'risk' | 'info' | 'support' | 'neutral';

const SEMANTIC: Record<Tone, { fg: string; bg: string }> = {
  saving: { fg: 'var(--status-saving)', bg: 'var(--status-saving-bg)' },
  caution: { fg: 'var(--status-caution)', bg: 'var(--status-caution-bg)' },
  risk: { fg: 'var(--status-risk)', bg: 'var(--status-risk-bg)' },
  info: { fg: 'var(--status-info)', bg: 'var(--status-info-bg)' },
  support: { fg: 'var(--status-support)', bg: 'var(--status-support-bg)' },
  neutral: { fg: 'var(--text-muted)', bg: 'var(--ink-tint)' },
};

export function badge(text: string, tone: Tone = 'neutral'): HTMLElement {
  const t = SEMANTIC[tone];
  return el('span', { class: 'badge', text, style: `color:${t.fg};background:${t.bg}` });
}

export interface ButtonOpts {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg';
  full?: boolean;
  disabled?: boolean;
  iconLeft?: IconName;
  onClick?: () => void;
}

export function button(label: string, opts: ButtonOpts = {}): HTMLElement {
  const variant = opts.variant ?? 'primary';
  const cls = [
    'btn',
    variant === 'ghost' ? 'btn-ghost' : `btn-${variant}`,
    variant === 'ghost' ? '' : `btn-${opts.size ?? 'md'}`,
    opts.full ? 'btn-full' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const children: (Node | string)[] = [];
  if (opts.iconLeft) children.push(icon(ICONS[opts.iconLeft], 16));
  children.push(label);
  const props: ElProps = { class: cls, type: 'button' };
  if (opts.disabled) props.disabled = true;
  if (opts.onClick) props.onClick = opts.onClick;
  return el('button', props, children);
}

export function callout(
  title: string,
  body: string,
  tone: Tone = 'info',
  iconName: IconName = 'info',
): HTMLElement {
  const t = SEMANTIC[tone];
  return el('div', { class: 'callout', style: `border-color:${t.fg};background:${t.bg}` }, [
    el('span', { class: 'callout-icon', style: `color:${t.fg}` }, [icon(ICONS[iconName], 17)]),
    el('div', {}, [
      el('div', { class: 'callout-title', style: `color:${t.fg}`, text: title }),
      el('div', { class: 'callout-body', text: body }),
    ]),
  ]);
}

const FIGURE_TONE: Record<'neutral' | 'saving' | 'caution' | 'risk', string> = {
  neutral: 'var(--text-strong)',
  saving: 'var(--status-saving)',
  caution: 'var(--status-caution)',
  risk: 'var(--status-risk)',
};

export interface FigureOpts {
  label: string;
  amount: string; // already formatted (e.g. "431.64")
  prefix?: string;
  period?: string;
  caption?: string;
  tone?: 'neutral' | 'saving' | 'caution' | 'risk';
  sign?: string; // optional leading sign, e.g. "−"
}

export function savingsFigure(o: FigureOpts): HTMLElement {
  const color = FIGURE_TONE[o.tone ?? 'neutral'];
  return el('div', { class: 'figure' }, [
    el('span', { class: 'figure-label', text: o.label }),
    el('span', {
      class: 'figure-amount',
      style: `color:${color}`,
      text: `${o.sign ?? ''}${o.prefix ?? ''}${o.amount}`,
    }),
    o.period ? el('span', { class: 'figure-period', text: o.period }) : null,
    o.caption ? el('span', { class: 'figure-caption', text: o.caption }) : null,
  ]);
}

// One line of the headline calculation: an optional operator, a label, and a
// right-aligned money amount.
export interface CalcInput {
  label: string;
  amount: string; // already formatted (e.g. "338.97")
  prefix?: string;
  op?: string; // operator glyph before the label (e.g. "−"); omitted on the first line
}

// The emphasised result of the calculation (the difference). Tone colours the
// amount + descriptor and tints the band so the takeaway reads at a glance.
export interface CalcResult {
  label: string;
  amount: string;
  prefix?: string;
  sign?: string; // arithmetic sign so "A − B = result" stays true (e.g. "−")
  descriptor?: string; // e.g. "lower on Agile"
  tone?: 'saving' | 'risk' | 'neutral';
  op?: string; // defaults to "="
}

export interface CalcOpts {
  inputs: CalcInput[];
  result?: CalcResult | null;
  foot?: string; // muted context line, e.g. "1,345 kWh · on these periods"
}

const RESULT_FG: Record<'saving' | 'risk' | 'neutral', string> = {
  saving: 'var(--status-saving)',
  risk: 'var(--status-risk)',
  neutral: 'var(--text-strong)',
};
const RESULT_BG: Record<'saving' | 'risk' | 'neutral', string> = {
  saving: 'var(--status-saving-bg)',
  risk: 'var(--status-risk-bg)',
  neutral: 'var(--surface-sunken)',
};

// Render a comparison as a vertical "receipt": each cost on its own line with an
// operator, then the difference as an emphasised, tone-coloured result band.
// Reads as A − B = C instead of three figures the eye has to relate by itself.
export function costCalc(o: CalcOpts): HTMLElement {
  const inputs = el(
    'div',
    { class: 'calc-inputs' },
    o.inputs.map((inp) =>
      el('div', { class: 'calc-line' }, [
        el('span', { class: 'calc-op', text: inp.op ?? '' }),
        el('span', { class: 'calc-name', text: inp.label }),
        el('span', { class: 'calc-val', text: `${inp.prefix ?? ''}${inp.amount}` }),
      ]),
    ),
  );

  const children: (HTMLElement | null)[] = [inputs];
  if (o.result) {
    const tone = o.result.tone ?? 'neutral';
    children.push(
      el('div', { class: 'calc-result', style: `background:${RESULT_BG[tone]}` }, [
        el('span', {
          class: 'calc-op',
          style: `color:${RESULT_FG[tone]}`,
          text: o.result.op ?? '=',
        }),
        el('span', { class: 'calc-result-name' }, [
          el('span', { class: 'calc-result-label', text: o.result.label }),
          o.result.descriptor
            ? el('span', {
                class: 'calc-result-desc',
                style: `color:${RESULT_FG[tone]}`,
                text: o.result.descriptor,
              })
            : null,
        ]),
        el('span', {
          class: 'calc-result-val',
          style: `color:${RESULT_FG[tone]}`,
          text: `${o.result.sign ?? ''}${o.result.prefix ?? ''}${o.result.amount}`,
        }),
      ]),
    );
  }
  if (o.foot) children.push(el('span', { class: 'calc-foot', text: o.foot }));
  return el('div', { class: 'calc' }, children);
}

export function confidenceBar(
  level: 'high' | 'medium' | 'low',
  valuePct: number,
  caption: string,
): HTMLElement {
  const color = level === 'high' ? 'var(--status-saving)' : 'var(--status-caution)';
  const pct = Math.max(0, Math.min(100, valuePct));
  return el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, [
    el('div', { class: 'confbar-track' }, [
      el('div', { class: 'confbar-fill', style: `width:${pct}%;background:${color}` }),
    ]),
    el('span', { class: 'confbar-caption', text: caption }),
  ]);
}

export interface SwitchOpts {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function switchRow(o: SwitchOpts): HTMLElement {
  return el(
    'button',
    {
      class: 'switch',
      type: 'button',
      role: 'switch',
      ariaChecked: o.checked,
      onClick: () => o.onChange(!o.checked),
    },
    [
      el('span', { class: 'switch-text' }, [
        el('span', { class: 'field-label', text: o.label }),
        o.description ? el('span', { class: 'switch-desc', text: o.description }) : null,
      ]),
      el('span', { class: 'switch-track' }, [el('span', { class: 'switch-knob' })]),
    ],
  );
}

export interface InputOpts {
  label: string;
  hint?: string;
  placeholder?: string;
  value?: string;
  type?: string;
  onInput?: (value: string) => void;
}

export function inputField(o: InputOpts): HTMLElement {
  const field = el('input', {
    class: 'input mono',
    type: o.type ?? 'text',
    placeholder: o.placeholder ?? '',
    value: o.value ?? '',
    onInput: (ev) => o.onInput?.((ev.target as HTMLInputElement).value),
  });
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: o.label }),
    field,
    o.hint ? el('span', { class: 'field-hint', text: o.hint }) : null,
  ]);
}
