import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AREA_ZONE,
  DEFAULT_ZONE,
  DNO_REGION_ZONE,
  MONTHLY_DIFFUSE_FRACTION,
  MONTHLY_GHI_KWH_PER_M2,
  SOLAR_DATA_PROVENANCE,
  SOLAR_DATA_VERSION,
  SOLAR_PROFILES_PPM,
  ZONE_META,
} from '../../src/data/solarProfiles.generated';

const zoneIds = Object.keys(ZONE_META);

describe('bundled solar profiles', () => {
  it('has at least a dozen zones', () => {
    expect(zoneIds.length).toBeGreaterThanOrEqual(12);
  });

  it('every zone-month half-hour shape has 48 slots summing to exactly 10000 ppm', () => {
    for (const id of zoneIds) {
      const months = SOLAR_PROFILES_PPM[id];
      expect(months, id).toBeDefined();
      expect(months?.length).toBe(12);
      for (const mo of months ?? []) {
        expect(mo.length).toBe(48);
        expect(mo.reduce((a, b) => a + b, 0)).toBe(10000);
        expect(mo.every((v) => v >= 0)).toBe(true);
      }
    }
  });

  it('monthly GHI is positive, plausibly UK, and seasonal (summer > winter)', () => {
    for (const id of zoneIds) {
      const m = MONTHLY_GHI_KWH_PER_M2[id];
      expect(m?.length).toBe(12);
      for (const v of m ?? []) expect(v).toBeGreaterThan(0);
      const annual = (m ?? []).reduce((a, b) => a + b, 0);
      expect(annual, `${id} annual GHI`).toBeGreaterThan(700);
      expect(annual, `${id} annual GHI`).toBeLessThan(1200);
      expect((m ?? [])[5]).toBeGreaterThan((m ?? [])[11] ?? Infinity); // June > December
    }
  });

  it('southern zones have a higher annual GHI than northern zones', () => {
    const south = (MONTHLY_GHI_KWH_PER_M2['south-england'] ?? []).reduce((a, b) => a + b, 0);
    const north = (MONTHLY_GHI_KWH_PER_M2['scotland-north'] ?? []).reduce((a, b) => a + b, 0);
    expect(south).toBeGreaterThan(north);
  });

  it('diffuse fraction is 12 values strictly inside (0,1)', () => {
    expect(MONTHLY_DIFFUSE_FRACTION.length).toBe(12);
    for (const v of MONTHLY_DIFFUSE_FRACTION) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('every zone referenced by AREA_ZONE / DNO_REGION_ZONE / DEFAULT_ZONE exists', () => {
    for (const z of Object.values(AREA_ZONE)) expect(ZONE_META[z], z).toBeDefined();
    for (const z of Object.values(DNO_REGION_ZONE)) expect(ZONE_META[z], z).toBeDefined();
    expect(ZONE_META[DEFAULT_ZONE]).toBeDefined();
  });

  it('maps roughly the full set of UK postcode areas', () => {
    expect(Object.keys(AREA_ZONE).length).toBeGreaterThanOrEqual(110);
  });

  it('has honest, complete provenance with an attributable citation', () => {
    // Either source may be committed: modelled climatology (default) or measured MIDAS.
    const p = SOLAR_DATA_PROVENANCE as unknown as Record<string, string | number | undefined>;
    const get = (k: string): string => String(p[k] ?? '');
    // SOLAR_DATA_VERSION is the bundle version; provenance.version is the upstream
    // dataset version (equal for modelled, "midas-<v>" vs "<v>" for measured).
    expect(SOLAR_DATA_VERSION).toContain(get('version'));
    expect(get('license').length).toBeGreaterThan(0);
    expect(get('citation').length).toBeGreaterThan(0);
    expect(get('shapeBasis').length).toBeGreaterThan(0);
    if ('doi' in p) {
      // measured MIDAS Open build — must be attributable under the OGL.
      expect(get('doi')).toContain('10.5285/');
      expect(get('shapeBasis').toLowerCase()).toContain('measured');
      expect(get('license').toLowerCase()).toContain('open government licence');
    } else {
      // modelled climatology default — must not claim measured data.
      expect(get('shapeBasis').toLowerCase()).toContain('clear-sky');
      expect(get('coverage').toLowerCase()).toContain('not a measured');
    }
  });

  it('stays within the generated-module size budget', () => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'src',
      'data',
      'solarProfiles.generated.ts',
    );
    const bytes = readFileSync(file, 'utf8').length;
    expect(bytes).toBeLessThan(120_000);
  });
});
