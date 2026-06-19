import type { TimingGuidance } from '../journey/nextSteps';
import { button, callout } from './components';
import { el, icon } from './dom';
import { ICONS } from './icons';

export interface TimingCallbacks {
  onBack: () => void;
  onDiagnostics: () => void;
}

const TONE_ICON = { support: 'clock', info: 'info', neutral: 'info' } as const;

// Stage 2 — "change timing, save more". Renders the data-contextual prompts from
// nextSteps plus the generic flexible-loads list and the three-stage principle.
export function renderTiming(
  host: HTMLElement,
  guidance: TimingGuidance,
  cb: TimingCallbacks,
): void {
  host.append(
    el('div', { style: 'display:flex;flex-direction:column;gap:7px;max-width:680px' }, [
      el('h1', {
        style: 'font-size:var(--text-h1)',
        text: 'Save more by moving flexible use',
      }),
      el('p', {
        class: 'lead',
        text: 'On a half-hourly tariff, when you use power changes the cost. About timing, not using less.',
      }),
    ]),
  );

  for (const p of guidance.prompts) {
    let body: string | HTMLElement = p.body;
    if (p.id === 'principle') {
      body = el('span', {}, [
        p.body + ' ',
        el('strong', { text: 'Avoid 4pm–7pm on weekdays' }),
        ' — typically the highest prices. Download the ',
        el('a', {
          href: 'https://www.octopriceuk.app/',
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Octoprice app',
        }),
        ' or similar to stay informed on live rates.',
      ]);
    }
    host.append(callout(p.title, body, p.tone, TONE_ICON[p.tone]));
  }

  // generic flexible-loads list (never inferred appliances)
  host.append(
    el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' }, [
      el('span', {
        class: 'row-title',
        style: 'font-size:var(--text-h3)',
        text: 'Flexible use is anything you can run later',
      }),
      el(
        'div',
        { style: 'display:flex;flex-wrap:wrap;gap:9px' },
        guidance.flexLoads.map((fl) =>
          el('span', { class: 'chip' }, [
            el('span', { style: 'color:var(--status-support);line-height:0' }, [
              icon(ICONS.clock, 15),
            ]),
            fl,
          ]),
        ),
      ),
      el('span', {
        class: 'row-sub',
        text: 'We don’t assume what you own, and there’s no savings figure for shifting — that’s your choice.',
      }),
    ]),
  );

  // three-stage principle line
  host.append(
    el(
      'div',
      {
        style:
          'display:flex;gap:10px;flex-wrap:wrap;padding:14px 18px;background:var(--status-info-bg);border:1px solid var(--border-soft);border-radius:var(--radius-md)',
      },
      [
        el('span', {
          style: 'font-size:var(--text-body-sm);font-weight:600;color:var(--ink)',
          text: guidance.principle.tariff,
        }),
        el('span', {
          style: 'font-size:var(--text-body-sm);font-weight:600;color:var(--grid-blue)',
          text: guidance.principle.timing,
        }),
        el('span', {
          style: 'font-size:var(--text-body-sm);font-weight:600;color:var(--text-muted)',
          text: guidance.principle.automate,
        }),
      ],
    ),
  );

  host.append(
    el(
      'div',
      {
        style: 'display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap',
      },
      [
        button('Back to comparison', {
          variant: 'secondary',
          onClick: cb.onBack,
        }),
        button('Download or send diagnostics', {
          variant: 'secondary',
          iconLeft: 'lock',
          onClick: cb.onDiagnostics,
        }),
      ],
    ),
  );
}
