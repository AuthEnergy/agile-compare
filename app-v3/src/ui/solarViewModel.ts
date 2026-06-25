// Pure view-model for the solar screen: every user-facing string and number is
// shaped here (testable), the screen module only lays it out.
//
// Voice rules (AGENTS.md): "would have" evidence, never a promise. We never tell
// the user to buy or install anything, never quote a payback, and band the headline
// figure + surface coverage so a heavily-modelled estimate doesn't read as a precise
// promise. Banned registers (asserted in tests): "you should install", "worth
// installing", "pays for itself", "payback", "guaranteed", "saved you", "recommend".

import { fmtMoney } from './format';
import type { SolarRun } from '../types/solar';

function kwh(n: number): string {
  return `${Math.round(n).toLocaleString('en-GB')} kWh`;
}

function pounds(pence: number): string {
  return `£${Math.round(pence / 100).toLocaleString('en-GB')}`;
}

const COMPASS: Array<{ az: number; label: string }> = [
  { az: 0, label: 'south' },
  { az: -45, label: 'south-east' },
  { az: 45, label: 'south-west' },
  { az: -90, label: 'east' },
  { az: 90, label: 'west' },
  { az: -135, label: 'north-east' },
  { az: 135, label: 'north-west' },
  { az: 180, label: 'north' },
];

export function compassLabel(azFromSouth: number): string {
  let label = 'south';
  let bestDelta = Infinity;
  for (const c of COMPASS) {
    const delta = Math.abs(c.az - azFromSouth);
    if (delta < bestDelta) {
      bestDelta = delta;
      label = c.label;
    }
  }
  return label;
}

export interface SolarTile {
  label: string;
  amount: string;
  caption?: string;
}

export interface SolarTableRow {
  label: string;
  generated: string;
  self: string;
  exp: string;
}

export interface SolarViewModel {
  arraySummary: string;
  generated: string;
  generatedSub: string;
  value: { amount: string; range: boolean; sub: string };
  coverage: string;
  basis: string;
  exportBasis: string;
  tiles: SolarTile[];
  table: { rows: SolarTableRow[]; foot: string } | null;
  caveats: string[];
  battery: { title: string; body: string };
}

export function computeSolarViewModel(run: SolarRun): SolarViewModel {
  const r = run.result;
  const cfg = r.config;
  const g = r.generation;

  const arraySummary =
    `A ${cfg.arrayKwp.toFixed(1)} kW array facing ${compassLabel(cfg.azimuthDegFromSouth)}, ` +
    `tilted ${Math.round(cfg.tiltDeg)}°`;

  const days = Math.max(1, Math.round(r.windowDays));
  const generated = `Would have generated about ${kwh(g.modelledKwh)}`;
  const generatedSub = `over ${days} day${days === 1 ? '' : 's'} of your usage, using ${r.zoneLabel} climate`;

  // Headline £ as a band: the spread across the export sources we priced (or a
  // single figure when there's only one). Always "about", always "would have".
  const totals = r.bases.length ? r.bases.map((b) => b.totalPence) : [r.importSavingPence];
  const lo = Math.min(...totals);
  const hi = Math.max(...totals);
  const range = Math.round(hi / 100) !== Math.round(lo / 100);
  const valueAmount = range ? `${pounds(lo)}–${pounds(hi)}` : pounds(hi);

  const primary = r.bases[0] ?? {
    kind: 'seg-assumed' as const,
    label: 'assumed SEG rate',
    exportValuePence: 0,
    totalPence: r.importSavingPence,
  };
  const value = {
    amount: valueAmount,
    range,
    sub: 'this is what the energy would have been worth, not a saving promise',
  };

  const coverage =
    g.coverage >= 0.999
      ? 'Valued across all of that generation against your usage'
      : `Valued on ${Math.round(g.coverage * 100)}% of that generation (the half-hours we have your usage for)`;

  const basis =
    r.tariffBasis === 'agile'
      ? 'Self-consumption priced against your Agile half-hourly rates'
      : 'Self-consumption priced against Flexible half-hourly rates';

  const exportBasis = r.usedAssumedSeg
    ? `Export valued at an assumed ${r.segRatePence}p/kWh — change it to match your own SEG rate`
    : r.bases.length > 1
      ? `Export valued under ${r.bases.map((b) => b.label).join(' and ')} (the range above)`
      : `Export valued under ${primary.label}`;

  const tiles: SolarTile[] = [
    {
      label: 'Self-used solar',
      amount: kwh(g.selfConsumedKwh),
      caption: 'used as generated, avoiding import',
    },
    {
      label: 'Exported surplus',
      amount: kwh(g.exportKwh),
      caption: 'sent back to the grid',
    },
    {
      label: 'Avoided import',
      amount: fmtMoney(r.importSavingPence),
      caption: `on ${r.tariffBasisLabel} rates`,
    },
    {
      label: 'Export value',
      amount: fmtMoney(primary.exportValuePence),
      caption: r.usedAssumedSeg ? 'assumed SEG rate' : primary.label,
    },
  ];

  const table =
    r.perMonth.length > 0
      ? {
          rows: r.perMonth.map((m) => ({
            label: m.label,
            generated: kwh(m.generatedKwh),
            self: kwh(m.selfConsumedKwh),
            exp: kwh(m.exportKwh),
          })),
          foot: 'Generated is the full modelled total; self-used and exported cover the half-hours with your usage.',
        }
      : null;

  const battery = {
    title: 'Battery modelling — experimental, coming later',
    body:
      'A home battery would shift some of this surplus into pricier hours instead of exporting it. ' +
      'That model carries more uncertainty (it assumes smart scheduling), so it is being built as a ' +
      'separate, clearly-labelled upper-bound and is not shown here yet.',
  };

  return {
    arraySummary,
    generated,
    generatedSub,
    value,
    coverage,
    basis,
    exportBasis,
    tiles,
    table,
    caveats: run.caveats,
    battery,
  };
}
