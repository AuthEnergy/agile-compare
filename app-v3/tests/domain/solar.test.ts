import { describe, it, expect } from 'vitest';
import {
  modelledGeneration,
  outwardToArea,
  resolveZone,
  scopeWindowDays,
  solarSinElevation,
} from '../../src/domain/solar';
import type { SolarConfig } from '../../src/types/solar';

const south: SolarConfig = {
  arrayKwp: 4,
  tiltDeg: 35,
  azimuthDegFromSouth: 0,
  systemLossFactor: 0.8,
};

const slot = (iso: string) => ({
  start: new Date(iso),
  end: new Date(new Date(iso).getTime() + 30 * 60 * 1000),
});
const day = (iso: string) => ({
  start: new Date(iso),
  end: new Date(new Date(iso).getTime() + 24 * 60 * 60 * 1000),
});

describe('outwardToArea', () => {
  it('reduces an outward code to its alpha area prefix', () => {
    expect(outwardToArea('BS1')).toBe('BS');
    expect(outwardToArea('SW1A')).toBe('SW');
    expect(outwardToArea('N15')).toBe('N');
    expect(outwardToArea('eh8')).toBe('EH');
  });
});

describe('resolveZone', () => {
  it('uses the postcode area when known (outward code is reduced first)', () => {
    const z = resolveZone('BS1', 'L');
    expect(z.resolvedBy).toBe('postcode-area');
    expect(z.zoneId).toBe('south-west');
  });
  it('falls back to the DNO region letter when no postcode', () => {
    const z = resolveZone(null, 'P');
    expect(z.resolvedBy).toBe('dno-region');
    expect(z.zoneId).toBe('scotland-north');
  });
  it('an unknown area still falls through to the region', () => {
    const z = resolveZone('QQ9', 'C');
    expect(z.resolvedBy).toBe('dno-region');
    expect(z.zoneId).toBe('london');
  });
  it('falls back to the national default when nothing is known', () => {
    const z = resolveZone(null, null);
    expect(z.resolvedBy).toBe('default');
    expect(z.zoneId).toBeTruthy();
  });
});

describe('PV generation model', () => {
  const zone = resolveZone('BS1', null); // south-west, lat 50.7, lng −3.5

  it('produces zero generation at night', () => {
    const gen = modelledGeneration([slot('2025-12-15T00:00:00Z')], south, zone);
    expect(gen.modelledKwh).toBe(0);
  });

  it('south beats north, and a 35° pitch beats vertical, over a summer day', () => {
    const d = [day('2025-06-15T00:00:00Z')];
    const s = modelledGeneration(d, south, zone).modelledKwh;
    const north = modelledGeneration(d, { ...south, azimuthDegFromSouth: 180 }, zone).modelledKwh;
    const vertical = modelledGeneration(d, { ...south, tiltDeg: 90 }, zone).modelledKwh;
    expect(s).toBeGreaterThan(north);
    expect(s).toBeGreaterThan(vertical);
  });

  it('applies the performance ratio exactly once (linear in kWp and loss factor)', () => {
    const d = [day('2025-06-15T00:00:00Z')];
    const g1 = modelledGeneration(d, south, zone).modelledKwh;
    const g2 = modelledGeneration(d, { ...south, arrayKwp: 8 }, zone).modelledKwh;
    expect(g2 / g1).toBeCloseTo(2, 5);
    const gLoss = modelledGeneration(d, { ...south, systemLossFactor: 0.4 }, zone).modelledKwh;
    expect(gLoss / g1).toBeCloseTo(0.5, 5); // 0.4 / 0.8
  });

  it('clips at the inverter AC limit as a POWER cap (kWh = kW × 0.5h), not at twice that', () => {
    const noon = [slot('2025-06-15T12:00:00Z')];
    const big: SolarConfig = { ...south, arrayKwp: 10, inverterAcKw: 2.5 };
    const uncapped = modelledGeneration(noon, { ...south, arrayKwp: 10 }, zone);
    const capped = modelledGeneration(noon, big, zone);
    expect(uncapped.slots).toHaveLength(1);
    expect(uncapped.modelledKwh).toBeGreaterThan(1.25); // the cap must actually bind
    expect(capped.slots[0]?.kwh).toBeCloseTo(1.25, 6); // 2.5 kW × 0.5 h — NOT 2.5 kWh
  });

  it('models the full skeleton over a non-contiguous scope without filling the gap', () => {
    const periods = [day('2025-06-15T00:00:00Z'), day('2025-08-15T00:00:00Z')];
    const gen = modelledGeneration(periods, south, zone);
    expect(gen.slots).toHaveLength(96); // two days × 48, not the whole June–August span
    expect(scopeWindowDays(periods)).toBeCloseTo(2, 6);
  });

  it('places solar noon near 12:00 UTC, longitude-corrected and DST-free', () => {
    let best = -Infinity;
    let bestSlot = -1;
    for (let i = 0; i < 48; i++) {
      const d = new Date(Date.UTC(2025, 5, 21, Math.floor(i / 2), (i % 2) * 30));
      const s = solarSinElevation(zone.lat, zone.lng, d);
      if (s > best) {
        best = s;
        bestSlot = i;
      }
    }
    const hour = bestSlot / 2;
    expect(hour).toBeGreaterThan(11.5);
    expect(hour).toBeLessThan(13.5);
  });
});
