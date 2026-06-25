import { describe, it, expect } from 'vitest';
import { compassLabel, computeSolarViewModel } from '../../src/ui/solarViewModel';
import { recomputeSolar, type SolarExportWindows } from '../../src/flows/runSolar';
import { DEFAULT_SOLAR_CONFIG } from '../../src/types/solar';
import type { SolarRun } from '../../src/types/solar';
import type { RateWindow } from '../../src/types/domain';
import { makeRun } from '../diagnostics/runFactory';
import { makeReadings } from '../helpers';

const flat = (p: number): RateWindow[] => [
  { validFrom: new Date('2024-01-01T00:00:00Z'), validTo: null, value: p },
];

function solarRun(withAgile = true, windows?: SolarExportWindows): SolarRun {
  const run = makeRun([
    {
      start: '2025-06-01T00:00:00Z',
      end: '2025-06-15T00:00:00Z',
      flexEnergy: 100,
      flexStanding: 10,
      agileEnergy: withAgile ? 80 : null,
    },
  ]);
  run.detail.readings = makeReadings('2025-06-01T00:00:00Z', 14 * 48, 0.2);
  run.detail.flexUnitSorted = flat(25);
  run.detail.agileUnitSorted = withAgile ? flat(20) : [];
  run.detail.agileAvailable = withAgile;
  run.context.postcodeArea = 'BS1';
  return recomputeSolar(
    run,
    DEFAULT_SOLAR_CONFIG,
    windows ?? { agileOutgoing: [], flatOutgoing: [], source: 'none' },
    {},
  );
}

const BANNED = [
  'you should install',
  'worth installing',
  'pays for itself',
  'payback',
  'guaranteed',
  'saved you',
  'recommend',
  'should switch',
  'use less',
];

const allText = (vm: unknown) => JSON.stringify(vm).toLowerCase();

describe('compassLabel', () => {
  it('maps azimuth-from-south to a compass word', () => {
    expect(compassLabel(0)).toBe('south');
    expect(compassLabel(-90)).toBe('east');
    expect(compassLabel(90)).toBe('west');
  });
});

describe('computeSolarViewModel', () => {
  it('never uses promise or purchase-register language', () => {
    const text = allText(computeSolarViewModel(solarRun()));
    for (const w of BANNED) expect(text, w).not.toContain(w);
  });

  it('keeps the "would have" evidence frame and surfaces coverage', () => {
    const vm = computeSolarViewModel(solarRun());
    expect(vm.generated.toLowerCase()).toContain('would have generated');
    expect(vm.value.sub.toLowerCase()).toContain('not a saving promise');
    expect(vm.coverage.toLowerCase()).toContain('valued');
  });

  it('surfaces the radiation data source for attribution', () => {
    const vm = computeSolarViewModel(solarRun());
    expect(vm.dataSource.toLowerCase()).toContain('radiation data');
    expect(vm.dataSource.length).toBeGreaterThan(20);
  });

  it('labels the import basis and marks the battery panel experimental', () => {
    const vm = computeSolarViewModel(solarRun(true));
    expect(vm.basis).toContain('Agile');
    expect(vm.battery.title.toLowerCase()).toContain('experimental');
  });

  it('labels Flexible when Agile is unavailable, and never says "priced against current"', () => {
    const vm = computeSolarViewModel(solarRun(false));
    expect(vm.basis).toContain('Flexible');
    expect(allText(vm)).not.toContain('priced against current');
  });

  it('shows a banded value across both Octopus export sources', () => {
    const vm = computeSolarViewModel(
      solarRun(true, { agileOutgoing: flat(8), flatOutgoing: flat(15), source: 'octopus' }),
    );
    expect(vm.value.range).toBe(true);
    expect(vm.value.amount).toContain('–'); // an en-dash range
    expect(vm.exportBasis).toContain('Agile Outgoing Octopus');
  });
});
