// Pure PV-generation model. No DOM, no fetch, no state.
//
// Single conversion path, performance ratio applied EXACTLY ONCE:
//   bundled GHI (kWh/m^2, horizontal)  ──transpose──▶  POA (kWh/m^2, plane-of-array)
//   genKwh = POA × arrayKwp / STC_IRRADIANCE × systemLossFactor,  clipped at inverterAcKw × 0.5h
// We bundle irradiation, not PV yield, so the array config is a pure multiplier.
//
// Transposition: isotropic-sky diffuse (Liu-Jordan) + direct beam + constant ground
// albedo (0.2). Isotropic is the conservative (slightly low-biased) sky model — it
// omits circumsolar/horizon brightening, which we prefer to overstating output.
//
// Geometry is computed per slot in UTC (NOAA solar position + equation of time +
// longitude), so the model is never local-time-naive and is DST-stable. The bundled
// half-hour shapes were generated with the SAME geometry (tools/build-solar-profiles.mjs).

import type { Reading } from '../types/domain';
import type { SolarConfig, ZoneResolvedBy } from '../types/solar';
import {
  AREA_ZONE,
  DEFAULT_ZONE,
  DNO_REGION_ZONE,
  MONTHLY_DIFFUSE_FRACTION,
  MONTHLY_GHI_KWH_PER_M2,
  SOLAR_PROFILES_PPM,
  ZONE_META,
} from '../data/solarProfiles.generated';

const HALF_HOUR_MS = 30 * 60 * 1000;
const DEG = Math.PI / 180;
const ALBEDO = 0.2;
const STC_IRRADIANCE_KW_PER_M2 = 1; // a 1 kWp array makes 1 kW at 1000 W/m^2 (STC)
// Floor sin(elevation) when dividing GHI→DNI near the horizon, and cap the
// beam tilt gain, so a low sun can't blow up plane-of-array beam irradiance.
const SIN_ELEV_FLOOR = 0.05;
const MAX_BEAM_TILT_GAIN = 4;

export interface ZoneData {
  zoneId: string;
  label: string;
  lat: number;
  lng: number;
  resolvedBy: ZoneResolvedBy;
}

// Outward code (e.g. "BS1", "SW1A") → postcode AREA (the leading alpha prefix,
// "BS", "SW"). AREA_ZONE is keyed by area, but the account accessor returns the
// outward code — so this reduction is required before the lookup (do not drop it).
export function outwardToArea(outward: string): string {
  const m = /^[A-Za-z]+/.exec(outward.trim());
  return (m ? m[0] : outward).toUpperCase();
}

// Resolve a climatological zone: postcode area first (finest signal we bundle),
// then the DNO region letter, then a national default. Never throws.
export function resolveZone(postcodeArea: string | null, regionLetter: string | null): ZoneData {
  let zoneId: string | null = null;
  let resolvedBy: ZoneResolvedBy = 'default';
  if (postcodeArea) {
    const area = outwardToArea(postcodeArea);
    const z = AREA_ZONE[area];
    if (z) {
      zoneId = z;
      resolvedBy = 'postcode-area';
    }
  }
  if (!zoneId && regionLetter) {
    const z = DNO_REGION_ZONE[regionLetter.toUpperCase()];
    if (z) {
      zoneId = z;
      resolvedBy = 'dno-region';
    }
  }
  if (!zoneId) {
    zoneId = DEFAULT_ZONE;
    resolvedBy = 'default';
  }
  const meta = ZONE_META[zoneId] ?? ZONE_META[DEFAULT_ZONE];
  return {
    zoneId,
    label: meta?.label ?? zoneId,
    lat: meta?.lat ?? 53,
    lng: meta?.lng ?? -1.5,
    resolvedBy,
  };
}

function daysInMonthUtc(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function dayOfYearUtc(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / (24 * 60 * 60 * 1000));
}

interface SolarAngles {
  decl: number; // solar declination (rad)
  ha: number; // hour angle (rad)
  sinElev: number; // = cos(zenith)
}

// NOAA solar position for a UTC instant. minutesUtc is minutes past UTC midnight.
function solarAngles(latDeg: number, lngDeg: number, doy: number, minutesUtc: number): SolarAngles {
  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (minutesUtc / 60 - 12) / 24);
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const timeOffset = eqTime + 4 * lngDeg; // tz = 0 (UTC)
  const tst = minutesUtc + timeOffset;
  const ha = (tst / 4 - 180) * DEG;
  const lat = latDeg * DEG;
  const sinElev = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  return { decl, ha, sinElev };
}

// sin(solar elevation) at a UTC instant for a site — exported for tests and as a
// fallback for callers that need raw geometry.
export function solarSinElevation(latDeg: number, lngDeg: number, date: Date): number {
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return solarAngles(latDeg, lngDeg, dayOfYearUtc(date), minutes).sinElev;
}

// Cosine of the angle of incidence on a tilted plane (Duffie & Beckman 1.6.2),
// with surface azimuth γ measured from south (+ west). Negative ⇒ sun behind panel.
function cosIncidence(
  latDeg: number,
  tiltDeg: number,
  azFromSouthDeg: number,
  a: SolarAngles,
): number {
  const lat = latDeg * DEG;
  const beta = tiltDeg * DEG;
  const gamma = azFromSouthDeg * DEG;
  const { decl, ha } = a;
  return (
    Math.sin(decl) * Math.sin(lat) * Math.cos(beta) -
    Math.sin(decl) * Math.cos(lat) * Math.sin(beta) * Math.cos(gamma) +
    Math.cos(decl) * Math.cos(lat) * Math.cos(beta) * Math.cos(ha) +
    Math.cos(decl) * Math.sin(lat) * Math.sin(beta) * Math.cos(gamma) * Math.cos(ha) +
    Math.cos(decl) * Math.sin(beta) * Math.sin(gamma) * Math.sin(ha)
  );
}

// Plane-of-array irradiation (kWh/m^2) for one half-hour slot from horizontal GHI.
export function transpose(
  ghiKwhM2: number,
  diffuseFraction: number,
  cfg: SolarConfig,
  lat: number,
  lng: number,
  date: Date,
): number {
  if (ghiKwhM2 <= 0) return 0;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + 15; // slot midpoint
  const a = solarAngles(lat, lng, dayOfYearUtc(date), minutes);
  const beta = cfg.tiltDeg * DEG;

  const diffuseH = ghiKwhM2 * diffuseFraction;
  const beamH = ghiKwhM2 - diffuseH;

  // Direct beam: scale horizontal beam to the plane by cosθ / sin(elevation),
  // floored near the horizon and capped to avoid low-sun overstatement.
  let beamPlane = 0;
  if (a.sinElev > 0) {
    const cosTheta = cosIncidence(lat, cfg.tiltDeg, cfg.azimuthDegFromSouth, a);
    if (cosTheta > 0) {
      const gain = Math.min(MAX_BEAM_TILT_GAIN, cosTheta / Math.max(a.sinElev, SIN_ELEV_FLOOR));
      beamPlane = beamH * gain;
    }
  }
  const diffusePlane = diffuseH * ((1 + Math.cos(beta)) / 2); // isotropic sky
  const groundPlane = ghiKwhM2 * ALBEDO * ((1 - Math.cos(beta)) / 2);
  return beamPlane + diffusePlane + groundPlane;
}

// Reconstruct horizontal GHI (kWh/m^2) for a single half-hour slot from the bundled
// monthly total and the normalised diurnal shape (ppm/10000 per representative day).
function slotGhi(zoneId: string, date: Date): number {
  const month = date.getUTCMonth();
  const monthly = MONTHLY_GHI_KWH_PER_M2[zoneId];
  const shape = SOLAR_PROFILES_PPM[zoneId];
  if (!monthly || !shape) return 0;
  const monthlyGhi = monthly[month] ?? 0;
  const dayShape = shape[month];
  if (!dayShape) return 0;
  const slotOfDay = date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0);
  const ppm = dayShape[slotOfDay] ?? 0;
  const perDay = monthlyGhi / daysInMonthUtc(date.getUTCFullYear(), month);
  return perDay * (ppm / 10000);
}

export interface ModelledGeneration {
  slots: Reading[]; // full UTC half-hour skeleton over the scope, each with modelled kWh
  modelledKwh: number;
}

interface Interval {
  start: number;
  end: number;
}

// Merge [start,end) windows so a non-contiguous scope (summaryScopePeriods can drop
// interior periods) never fabricates generation in the gaps between periods.
function mergeIntervals(periods: ReadonlyArray<{ start: Date; end: Date }>): Interval[] {
  const ranges = periods
    .map((p) => ({ start: p.start.getTime(), end: p.end.getTime() }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

// Build the complete UTC half-hour generation skeleton over the scope (the union of
// the scoped periods), independent of consumption gaps. "Would have generated N kWh"
// is this full modelled total; valuation (in the flow) intersects it with covered slots.
export function modelledGeneration(
  periods: ReadonlyArray<{ start: Date; end: Date }>,
  cfg: SolarConfig,
  zone: ZoneData,
): ModelledGeneration {
  const slots: Reading[] = [];
  let modelledKwh = 0;
  for (const iv of mergeIntervals(periods)) {
    let t = Math.floor(iv.start / HALF_HOUR_MS) * HALF_HOUR_MS;
    for (; t < iv.end; t += HALF_HOUR_MS) {
      const start = new Date(t);
      const ghi = slotGhi(zone.zoneId, start);
      const month = start.getUTCMonth();
      const df = MONTHLY_DIFFUSE_FRACTION[month] ?? 0.55;
      const poa = transpose(ghi, df, cfg, zone.lat, zone.lng, start);
      let kwh = (poa * cfg.arrayKwp * cfg.systemLossFactor) / STC_IRRADIANCE_KW_PER_M2;
      // Inverter clip is a POWER cap: max energy in a 0.5 h slot is kW × 0.5 h.
      if (cfg.inverterAcKw !== undefined) kwh = Math.min(kwh, cfg.inverterAcKw * 0.5);
      slots.push({ start, end: new Date(t + HALF_HOUR_MS), kwh });
      modelledKwh += kwh;
    }
  }
  return { slots, modelledKwh };
}

// Span of the scope in whole days (union of periods), for the seasonal-bias guard.
export function scopeWindowDays(periods: ReadonlyArray<{ start: Date; end: Date }>): number {
  const merged = mergeIntervals(periods);
  const ms = merged.reduce((s, iv) => s + (iv.end - iv.start), 0);
  return ms / (24 * 60 * 60 * 1000);
}
