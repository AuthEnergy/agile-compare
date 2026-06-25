// Shared solar geometry for the dev-time solar generator and the MIDAS ingest.
// One source of truth so the bundled clear-sky shapes and the MIDAS hour-ending
// half-hour split use the SAME UTC solar position (no drift between them).

const DEG = Math.PI / 180;

// sin(solar elevation) = cos(zenith) at a UTC instant for a site, from day-of-year
// and minutes-past-UTC-midnight. NOAA position + equation of time + longitude
// correction (tz = 0, UTC), so solar noon lands at the true meridian crossing.
export function sinElevation(latDeg, lngDeg, doy, minutesUtc) {
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
  const timeOffset = eqTime + 4 * lngDeg;
  const tst = minutesUtc + timeOffset;
  const ha = (tst / 4 - 180) * DEG;
  const lat = latDeg * DEG;
  return Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayOfYearUtc(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / DAY_MS);
}

// sin(elevation) for a JS Date (UTC).
export function sinElevationAt(latDeg, lngDeg, date) {
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return sinElevation(latDeg, lngDeg, dayOfYearUtc(date), minutes);
}

// Clear-sky GHI proxy (Kasten-Young air mass × Bras transmittance). Shape only —
// the constant cancels in normalisation. Zero below the horizon.
export function clearSkyWeight(latDeg, lngDeg, doy, minutesUtc) {
  const s = sinElevation(latDeg, lngDeg, doy, minutesUtc);
  if (s <= 0.001) return 0;
  const elevDeg = Math.asin(Math.min(1, s)) / DEG;
  const airMass = 1 / (s + 0.50572 * Math.pow(6.07995 + elevDeg, -1.6364));
  return s * Math.pow(0.7, Math.pow(airMass, 0.678));
}

// Great-circle distance (km) between two lat/lng points — for nearest-zone
// assignment of MIDAS stations.
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
