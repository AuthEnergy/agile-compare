import { rateAtSorted } from '../domain/rates';
import { summaryScopePeriods, type Headline } from '../domain/headline';
import type { ComparisonRun } from '../types/result';

// Stage 2 — "change timing, save more". Pure, read-only over a ComparisonRun. It
// derives a few lightweight signals and emits MOVE-don't-reduce prompts. Wording
// is generic by default ("flexible loads such as…") and only names specific
// appliances when the user explicitly selects them — never inferred from
// aggregate meter data. No savings simulation (Stage 3 readiness): wording only.

export interface NextStepSignals {
  agileAvailable: boolean;
  agileCheaper: boolean | null; // would Agile already be cheaper? (from the headline)
  cheapShare: number; // 0..1 of rated kWh in the cheapest third of half-hours
  expensiveShare: number; // 0..1 of rated kWh in the priciest third
  ratedKwh: number; // kWh basis (readings that matched an Agile rate)
}

export interface PromptItem {
  id: string;
  tone: 'support' | 'info' | 'neutral';
  title: string;
  body: string;
}

export interface TimingGuidance {
  signals: NextStepSignals;
  prompts: PromptItem[];
  flexLoads: string[];
  principle: { tariff: string; timing: string; automate: string };
}

const GENERIC_FLEX_LOADS = [
  'Washing',
  'Dishwashing',
  'EV or device charging',
  'Immersion / hot water',
  'Battery storage',
];
const GENERIC_LOADS_PHRASE =
  'flexible loads such as the dishwasher, washing machine, immersion, battery, EV or heat pump';

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] ?? ''}`;
}

export function computeSignals(run: ComparisonRun, headline: Headline): NextStepSignals {
  const { readings, agileUnitSorted, agileAvailable } = run.detail;
  // "Would Agile already be cheaper?" — only meaningful when Agile is the compared
  // alternative (i.e. you're not already on Agile).
  const agileCheaper = headline.verdict
    ? headline.verdict.alternativeLabel === 'Agile' && headline.verdict.alternativeCheaper
    : null;
  if (!agileAvailable || agileUnitSorted.length === 0) {
    return { agileAvailable: false, agileCheaper, cheapShare: 0, expensiveShare: 0, ratedKwh: 0 };
  }
  // Scope to the SAME periods the headline trusts. Pre-switch / clamped /
  // mismatched / otherwise-excluded months are not in the headline, so they must
  // not drive "shift your timing" prompts either.
  const scope = summaryScopePeriods(run).map((p) => [p.start.getTime(), p.end.getTime()] as const);
  const inScope = (t: number): boolean => scope.some(([s, e]) => t >= s && t < e);
  const rated: { kwh: number; rate: number }[] = [];
  for (const r of readings) {
    if (!inScope(r.start.getTime())) continue;
    const rate = rateAtSorted(agileUnitSorted, r.start);
    if (rate !== null) rated.push({ kwh: r.kwh, rate });
  }
  const ratedKwh = rated.reduce((s, x) => s + x.kwh, 0);
  let cheapShare = 0;
  let expensiveShare = 0;
  if (rated.length > 0 && ratedKwh > 0) {
    const rates = rated.map((x) => x.rate).sort((a, b) => a - b);
    const pct = (p: number): number =>
      rates[Math.min(rates.length - 1, Math.floor(p * rates.length))] ?? 0;
    const cheapCut = pct(1 / 3);
    const peakCut = pct(2 / 3);
    const cheapKwh = rated.filter((x) => x.rate <= cheapCut).reduce((s, x) => s + x.kwh, 0);
    const peakKwh = rated.filter((x) => x.rate >= peakCut).reduce((s, x) => s + x.kwh, 0);
    cheapShare = cheapKwh / ratedKwh;
    expensiveShare = peakKwh / ratedKwh;
  }
  return { agileAvailable: true, agileCheaper, cheapShare, expensiveShare, ratedKwh };
}

export function nextSteps(
  run: ComparisonRun,
  headline: Headline,
  opts: { selectedAppliances?: readonly string[] } = {},
): TimingGuidance {
  const signals = computeSignals(run, headline);
  const appliances = (opts.selectedAppliances ?? []).filter((a) => a.trim().length > 0);
  const loadsPhrase =
    appliances.length > 0
      ? `flexible loads such as your ${joinList(appliances)}`
      : GENERIC_LOADS_PHRASE;

  const notice = headline.previousTariffOnly;
  const prompts: PromptItem[] = [];

  // When all the data predates the current tariff there is no current usage pattern
  // to tailor advice to — say so plainly and keep the rest generic (mirrors the
  // results screen so the honesty framing carries into Stage 2).
  if (notice) {
    prompts.push({
      id: 'earlier-usage',
      tone: 'info',
      title: 'These tips stay general for now',
      body: `Your half-hourly data is all from before you moved to your current tariff (${notice.currentTariffLabel}), so there is no current-tariff usage pattern to tailor timing tips to yet.`,
    });
  }

  prompts.push({
    id: 'principle',
    tone: 'support',
    title: 'Same usage, cheaper timing',
    body: 'On a half-hourly tariff the cost depends on when you use power, not whether you use it. This is about shifting flexible use to cheaper times — never about going without.',
  });

  // Data-driven prompts only when the headline is trustworthy AND scoped to its
  // periods — and NOT in the all-pre-switch case, where the signals describe old
  // usage on a tariff the user has already left (never present it as "current").
  if (headline.trustworthy && !notice) {
    if (signals.expensiveShare >= 0.3) {
      prompts.push({
        id: 'peak-shift',
        tone: 'info',
        title: 'A sizeable share of your use lands in the pricier half-hours',
        body: `Moving ${loadsPhrase} into the cheaper half-hours, if and when it suits you, is where the extra saving sits.`,
      });
    }
    if (signals.agileCheaper === true) {
      prompts.push({
        id: 'widen-gap',
        tone: 'support',
        title: 'Agile already looks cheaper on your usage',
        body: `Shifting ${loadsPhrase} into its cheap half-hours would widen that gap.`,
      });
    } else if (signals.agileAvailable && signals.agileCheaper === false) {
      prompts.push({
        id: 'timing-dependent',
        tone: 'info',
        title: "Agile isn't ahead on your current pattern",
        body: `It pays off mainly when you can move ${loadsPhrase} to cheaper times.`,
      });
    }
  }

  return {
    signals,
    prompts,
    flexLoads: GENERIC_FLEX_LOADS,
    principle: {
      tariff: 'Change tariff, save money.',
      timing: 'Change timing, save more.',
      automate: 'Automate later, save reliably.',
    },
  };
}
