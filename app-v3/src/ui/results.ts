import type { Headline } from '../domain/headline';
import type { ComparisonRun } from '../types/result';
import { badge, button, callout, confidenceBar, costCalc } from './components';
import { renderPeriodRow } from './drilldown';
import { el, icon } from './dom';
import { fmtDateShort, fmtKwh } from './format';
import { ICONS } from './icons';
import { renderSharePanel } from './share';
import { computeResultsViewModel } from './viewModel';

function stmtRow(label: string, value: string, strong = false): HTMLElement {
  return el('div', { class: 'table-row' }, [
    el('span', { style: 'font-size:var(--text-body-sm);color:var(--text-body)', text: label }),
    el('span', {
      class: 'mono',
      style: `font-size:var(--text-data-sm);font-weight:${strong ? 600 : 500};color:var(--text-strong)`,
      text: value,
    }),
  ]);
}

export interface ResultsCallbacks {
  onTiming: () => void;
  onReset: () => void;
  onDiagnostics: () => void;
  onEditTariff: () => void;
  onResetTariff: (() => void) | null; // non-null only when a user tariff is active
}

// Paint the import comparison from a ComparisonRun + Headline (live or replayed).
export function renderResults(
  host: HTMLElement,
  run: ComparisonRun,
  headline: Headline,
  replayMeta: string | null,
  cb: ResultsCallbacks,
): void {
  const vm = computeResultsViewModel(run, headline);

  if (replayMeta) {
    host.append(
      el('div', { class: 'banner' }, [
        el('span', { style: 'line-height:0;margin-top:2px;flex-shrink:0;opacity:0.7' }, [
          icon(ICONS.info, 17),
        ]),
        el('div', {}, [
          el('span', {
            style: 'font-size:var(--text-body-sm);font-weight:600',
            text: 'Offline replay — no live data fetched',
          }),
          el('div', {
            class: 'mono',
            style: 'font-size:var(--text-caption);opacity:0.7',
            text: replayMeta,
          }),
        ]),
      ]),
    );
  }

  host.append(
    el('div', { style: 'display:flex;flex-direction:column;gap:5px' }, [
      el('h1', { style: 'font-size:var(--text-h1)', text: 'Your comparison' }),
      el('p', {
        class: 'row-sub',
        style: 'max-width:520px',
        text: 'What each tariff would have cost on your real usage.',
      }),
    ]),
  );

  // headline card — the comparison as a "receipt": each cost on its own line,
  // then the difference as an emphasised result. The kWh + scope move into the
  // foot so the numbers themselves read as a single calculation.
  const diffTone =
    vm.difference?.tone === 'saving'
      ? 'saving'
      : vm.difference?.tone === 'info'
        ? 'info'
        : 'neutral';
  const calc = costCalc({
    inputs: vm.agile
      ? [
          { label: vm.paid.label, prefix: vm.paid.prefix, amount: vm.paid.amount },
          { label: vm.agile.label, prefix: vm.agile.prefix, amount: vm.agile.amount, op: '−' },
        ]
      : [{ label: vm.paid.label, prefix: vm.paid.prefix, amount: vm.paid.amount }],
    result: vm.difference
      ? {
          label: vm.difference.label,
          prefix: vm.difference.prefix,
          amount: vm.difference.amount,
          // Keep "Paid − Agile = result" arithmetically true: the gap is negative
          // when Agile is the dearer side (risk), positive when it saves.
          sign: '',
          tone: diffTone,
          ...(vm.difference.period ? { descriptor: vm.difference.period } : {}),
        }
      : null,
    foot: `${vm.kwhLabel} · ${(vm.difference?.caption ?? vm.paid.caption ?? '').toLowerCase()}`,
  });
  const headlineCard = el(
    'div',
    {
      style:
        'border:1px solid var(--border-soft);border-radius:var(--radius-lg);overflow:hidden;background:var(--surface-card)',
    },
    [
      el(
        'div',
        {
          style:
            'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:11px 18px;background:var(--status-info-bg);border-bottom:1px solid var(--border-soft)',
        },
        [
          el(
            'span',
            {
              style:
                'display:inline-flex;align-items:center;gap:8px;font-size:var(--text-body-sm);font-weight:600;color:var(--ink)',
            },
            [
              el('span', { style: 'color:var(--grid-blue);line-height:0' }, [
                icon(vm.previousTariffNotice ? ICONS.info : ICONS.check, 15),
              ]),
              `${vm.scopeTitle} `,
              el('span', { class: 'mono', text: vm.scopeCount }),
            ],
          ),
          el('span', {
            class: 'mono',
            style: 'font-size:var(--text-caption);color:var(--text-muted)',
            text: vm.windowLabel,
          }),
        ],
      ),
      el('div', { style: 'padding:18px' }, [calc]),
    ],
  );
  // No current-tariff data: explain plainly that the figures are over earlier
  // usage on the previous tariff, before the headline card claims anything.
  if (vm.previousTariffNotice) {
    host.append(
      callout(vm.previousTariffNotice.heading, vm.previousTariffNotice.body, 'caution', 'info'),
    );
  }
  host.append(headlineCard);

  // verdict / not-enough-data
  if (vm.notEnoughData) {
    host.append(
      callout(
        'Not enough complete data yet',
        'Some periods are incomplete or your statement history is partial, so we are not showing a headline verdict — only the periods we could check.',
        'caution',
        'alert',
      ),
    );
  } else if (vm.verdictText) {
    host.append(callout('What this means', vm.verdictText, 'support', 'check'));
  }

  // Honest note when usage runs past the last bill the API returned: that usage
  // still gets a Flexible/Agile estimate, but there's no "actual paid" for it.
  if (run.context.readingsBeyondStatements) {
    const note = run.context.latestStatementEnd
      ? {
          title: 'Your most recent usage isn’t billed yet',
          body: `We found statements up to ${fmtDateShort(run.context.latestStatementEnd)}. Newer usage is still compared on Octopus’s published rates — you can see what Agile and Flexible would have cost — but not what you actually paid, because no bill covering those weeks came back from the API.`,
        }
      : {
          title: 'None of this usage is billed yet',
          body: 'No statement covering this period came back from the API, so every figure here is on Octopus’s published rates — what Agile and Flexible would have cost — not what you actually paid.',
        };
    host.append(callout(note.title, note.body, 'caution', 'info'));
  }

  // confidence
  const level = vm.confidenceLevel;
  const confidenceLabel =
    level === 'high'
      ? 'High confidence'
      : level === 'medium'
        ? 'Medium confidence'
        : 'Low confidence';
  host.append(
    el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' }, [
      el(
        'div',
        {
          style:
            'display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap',
        },
        [
          el('span', {
            class: 'row-title',
            style: 'font-size:var(--text-h3)',
            text: 'How sure are we?',
          }),
          badge(confidenceLabel, level === 'high' ? 'saving' : 'caution'),
        ],
      ),
      confidenceBar(level, vm.confidencePct, vm.confidenceCaption),
      vm.hasActual
        ? callout(
            'What could change this',
            'Assumes your usage pattern continues. Agile tracks wholesale rates, so a costly winter could narrow this.',
            'caution',
            'info',
          )
        : null,
    ]),
  );

  // social share (a branded image + percentages, never £ amounts) — shown when
  // there's a trustworthy, current-tariff result worth posting.
  const sharePanel = renderSharePanel(run, headline);
  if (sharePanel) host.append(sharePanel);

  // periods + drill-down
  host.append(
    el('div', { style: 'display:flex;flex-direction:column;gap:9px' }, [
      el(
        'div',
        {
          style:
            'display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap',
        },
        [
          el('span', { class: 'eyebrow', text: 'What we used, and left out' }),
          el('span', { class: 'row-sub', text: 'Open a complete period for the maths.' }),
        ],
      ),
      ...vm.periods.map((p) => renderPeriodRow(p, run)),
    ]),
  );

  // statement validation — only when a bill actually covers the summarised
  // periods (so there's something to check). When the summary is recent unbilled
  // usage, scopedBilledKwh is 0 and a "0 / 0" table is meaningless, so it's hidden;
  // the "isn't billed yet" note above already explains why.
  const showBilledRows = headline.scopedBilledKwh > 0;
  if (showBilledRows || headline.wholeWindow.anyMismatchAllPeriods) {
    host.append(
      el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:14px' }, [
        el('div', { style: 'display:flex;flex-direction:column;gap:3px' }, [
          el('span', {
            class: 'row-title',
            style: 'font-size:var(--text-h3)',
            text: 'Checked against your statements',
          }),
          el('span', {
            class: 'row-sub',
            text: 'A figure is only “confident” when bill and readings agree.',
          }),
        ]),
        showBilledRows
          ? el('div', { class: 'table' }, [
              stmtRow(
                vm.previousTariffNotice
                  ? 'Billed kWh (earlier usage)'
                  : 'Billed kWh (complete periods)',
                fmtKwh(headline.scopedBilledKwh, 0),
              ),
              stmtRow('Observed kWh', fmtKwh(headline.scopedObservedKwh, 0), true),
            ])
          : null,
        headline.wholeWindow.anyMismatchAllPeriods
          ? callout(
              'A period was excluded',
              'A statement disagreed with the readings for one period, so we dropped its “vs your bill” comparison and left it out of the headline.',
              'caution',
              'alert',
            )
          : null,
      ]),
    );
  }

  // actions
  host.append(
    el(
      'div',
      {
        style:
          'display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding-top:2px',
      },
      [
        el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, [
          button('Start over', { variant: 'secondary', onClick: cb.onReset }),
          button('Diagnostics', {
            variant: 'secondary',
            iconLeft: 'lock',
            onClick: cb.onDiagnostics,
          }),
          button('Edit tariff', { variant: 'secondary', onClick: cb.onEditTariff }),
          cb.onResetTariff
            ? button('Reset to API rates', { variant: 'ghost', onClick: cb.onResetTariff })
            : null,
        ]),
        button('See how timing saves more', {
          variant: 'primary',
          size: 'lg',
          onClick: cb.onTiming,
        }),
      ],
    ),
  );
}

// Small helper so the empty-state path is consistent if a run has no periods.
export function renderResultsEmpty(host: HTMLElement, cb: ResultsCallbacks): void {
  host.append(
    callout(
      'Nothing to compare',
      'This run produced no billing periods to price.',
      'caution',
      'alert',
    ),
    el('div', { style: 'padding-top:6px' }, [
      button('Start over', { variant: 'secondary', onClick: cb.onReset }),
    ]),
  );
}
