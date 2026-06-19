import { describe, it, expect } from 'vitest';
import { computeSignals, nextSteps } from '../../src/journey/nextSteps';
import { computeHeadline } from '../../src/domain/headline';
import type { RateWindow } from '../../src/types/domain';
import type { ComparisonRun } from '../../src/types/result';
import { makeRun } from '../diagnostics/runFactory';
import { makeReadings } from '../helpers';

const win = (fromISO: string, p: number): RateWindow => ({
  validFrom: new Date(fromISO),
  validTo: null,
  value: p,
});

const headlineFor = (run: ComparisonRun) => computeHeadline(run);

// A run whose Agile rate is 10p before noon and 40p from noon — five 1 kWh
// readings in each band, so a clear cheap/peak split.
function splitRateRun(): ComparisonRun {
  const run = makeRun([
    {
      start: '2025-03-01',
      end: '2025-04-01',
      actual: 100,
      flexEnergy: 50,
      flexStanding: 10,
      agileEnergy: 40,
      agileStanding: 10,
    },
  ]);
  run.detail.readings = [
    ...makeReadings('2025-03-01T00:00:00Z', 5, 1),
    ...makeReadings('2025-03-01T12:00:00Z', 5, 1),
  ];
  run.detail.agileUnitSorted = [win('2025-03-01T00:00:00Z', 10), win('2025-03-01T12:00:00Z', 40)];
  run.detail.agileAvailable = true;
  return run;
}

const BANNED = ['use less', 'turn off', 'turn things off', 'cut down', 'reduce your', 'go without'];

describe('computeSignals', () => {
  it('splits rated kWh into cheap/expensive thirds', () => {
    const run = splitRateRun();
    const s = computeSignals(run, headlineFor(run));
    expect(s.agileAvailable).toBe(true);
    expect(s.ratedKwh).toBe(10);
    expect(s.expensiveShare).toBeCloseTo(0.5, 5);
    expect(s.cheapShare).toBeCloseTo(0.5, 5);
    expect(s.agileCheaper).toBe(true);
  });

  it('reports nothing actionable when Agile is unavailable', () => {
    const run = splitRateRun();
    run.detail.agileAvailable = false;
    run.context.agileAvailable = false; // a real run keeps these consistent
    const s = computeSignals(run, headlineFor(run));
    expect(s.agileAvailable).toBe(false);
    expect(s.expensiveShare).toBe(0);
  });

  it('scopes readings to the headline periods — excluded months do not count', () => {
    const run = makeRun([
      {
        start: '2025-03-01',
        end: '2025-04-01',
        tariff: 'current',
        actual: 100,
        flexEnergy: 50,
        flexStanding: 10,
        agileEnergy: 40,
        agileStanding: 10,
      },
      // pre-switch, NOT confident → excluded from the headline scope
      {
        start: '2025-04-01',
        end: '2025-05-01',
        tariff: 'old',
        confident: false,
        actual: 100,
        flexEnergy: 50,
        flexStanding: 10,
        agileEnergy: 40,
        agileStanding: 10,
      },
    ]);
    run.detail.readings = [
      ...makeReadings('2025-03-10T00:00:00Z', 4, 1), // in the kept period
      ...makeReadings('2025-04-10T12:00:00Z', 4, 1), // in the EXCLUDED period
    ];
    run.detail.agileUnitSorted = [win('2025-01-01T00:00:00Z', 10), win('2025-04-01T00:00:00Z', 40)];
    run.detail.agileAvailable = true;

    const s = computeSignals(run, headlineFor(run));
    expect(s.ratedKwh).toBe(4); // only the 4 in-scope readings, not all 8
  });
});

describe('nextSteps', () => {
  it('never uses reduce/turn-off framing in any prompt', () => {
    const run = splitRateRun();
    const g = nextSteps(run, headlineFor(run));
    for (const p of g.prompts) {
      const text = `${p.title} ${p.body}`.toLowerCase();
      for (const phrase of BANNED) expect(text).not.toContain(phrase);
    }
  });

  it('uses generic "flexible loads such as…" wording by default — no appliance overclaim', () => {
    const run = splitRateRun();
    const g = nextSteps(run, headlineFor(run));
    const joined = g.prompts.map((p) => p.body).join(' ');
    expect(joined).toContain('flexible loads such as the dishwasher');
    expect(joined).not.toContain('your EV');
    expect(joined).not.toContain('your heat pump');
  });

  it('names appliances only when the user explicitly selects them', () => {
    const run = splitRateRun();
    const g = nextSteps(run, headlineFor(run), { selectedAppliances: ['EV', 'heat pump'] });
    const joined = g.prompts.map((p) => p.body).join(' ');
    expect(joined).toContain('flexible loads such as your EV or heat pump');
  });

  it('emits the peak-shift prompt when usage concentrates in pricey half-hours', () => {
    const run = splitRateRun();
    const g = nextSteps(run, headlineFor(run));
    expect(g.prompts.some((p) => p.id === 'peak-shift')).toBe(true);
    expect(g.prompts.some((p) => p.id === 'widen-gap')).toBe(true);
    expect(g.flexLoads.length).toBeGreaterThan(0);
    expect(g.principle.timing).toContain('Change timing');
  });

  it('only emits the principle prompt when Agile is unavailable', () => {
    const run = splitRateRun();
    run.detail.agileAvailable = false;
    run.context.agileAvailable = false; // a real run keeps these consistent
    const g = nextSteps(run, headlineFor(run));
    expect(g.prompts.map((p) => p.id)).toEqual(['principle']);
  });

  it('only emits the principle prompt when the headline is not trustworthy', () => {
    const run = splitRateRun();
    run.context.statementsIncomplete = true; // makes the headline not trustworthy
    const g = nextSteps(run, headlineFor(run));
    expect(g.prompts.map((p) => p.id)).toEqual(['principle']);
  });

  it('suppresses data-driven prompts when all data predates the current tariff', () => {
    // Agile would be cheaper on this (old) usage, so without the guard widen-gap
    // would fire — but the pattern is pre-switch, so it must NOT be presented as
    // the user's current behaviour.
    const run = splitRateRun();
    run.periods.forEach((p) => {
      p.tariffCodes = ['E-1R-FIX-12M-23-A'];
      p.actualTariffCode = 'E-1R-FIX-12M-23-A';
    });
    run.context.currentAgreement = {
      tariff_code: 'E-1R-VAR-99-01-A',
      valid_from: '2026-04-09T00:00:00.000Z',
      valid_to: null,
    };
    const h = headlineFor(run);
    expect(h.previousTariffOnly).not.toBeNull();

    const g = nextSteps(run, h);
    const ids = g.prompts.map((p) => p.id);
    expect(ids).toContain('earlier-usage');
    expect(ids).toContain('principle');
    expect(ids).not.toContain('peak-shift');
    expect(ids).not.toContain('widen-gap');
    expect(ids).not.toContain('timing-dependent');

    const earlier = g.prompts.find((p) => p.id === 'earlier-usage');
    expect(earlier?.body).toContain('before you moved to your current tariff');
  });
});
