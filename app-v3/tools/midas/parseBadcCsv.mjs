// Faithful parser for MIDAS Open "uk-radiation-obs" BADC-CSV files.
//
// BADC-CSV layout (see help.ceda.ac.uk/article/105-badc-csv):
//   <header rows>            global attributes as  name,G,value[,value...]
//   data                     a line whose first cell is exactly "data"
//   <column-name row>        e.g.  ob_end_time,id,...,glbl_irad_amt,difu_irad_amt,...
//   <data rows>
//   end data
//
// RO table (artefacts.ceda.ac.uk/badc_datadocs/ukmo-midas/RO_Table.html):
//   src_id          station number
//   ob_end_time     date/time at END of the observation hour (UTC)
//   ob_hour_count   observation hour count (1 = hourly)
//   version_num     use rows == 1 (quality-controlled)
//   glbl_irad_amt   global solar irradiation, KJ/m^2 over the hour
//   difu_irad_amt   diffuse solar irradiation, KJ/m^2 over the hour (may be absent/blank)
//
// 1 kWh = 3600 KJ, so kWh = KJ / 3600.

const KJ_PER_KWH = 3600;

function splitCsvLine(line) {
  return line.split(',').map((c) => c.trim());
}

// Parse the station latitude/longitude/id from the global-attribute header rows.
// MIDAS Open carries these as `latitude,G,<n>` / `longitude,G,<n>` / `src_id,G,<n>`;
// some releases use a single `location,G,<lat>,<lng>`. Support both.
function parseHeader(headerLines) {
  const g = new Map();
  for (const raw of headerLines) {
    const cells = splitCsvLine(raw);
    if (cells.length >= 3 && cells[1] === 'G') g.set(cells[0].toLowerCase(), cells.slice(2));
  }
  const num = (key) => {
    const v = g.get(key);
    if (!v || v.length === 0) return null;
    const n = Number(v[0]);
    return Number.isFinite(n) ? n : null;
  };
  let lat = num('latitude');
  let lng = num('longitude');
  const loc = g.get('location');
  if ((lat === null || lng === null) && loc && loc.length >= 2) {
    const a = Number(loc[0]);
    const b = Number(loc[1]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      lat = a;
      lng = b;
    }
  }
  const srcRaw = g.get('src_id') ?? g.get('source_id');
  const srcId = srcRaw && srcRaw.length ? srcRaw[0] : null;
  return { lat, lng, srcId };
}

// Parse "YYYY-MM-DD HH:MM[:SS]" (UTC) → Date. MIDAS observation times are UTC.
function parseUtc(s) {
  const t = s.trim().replace(' ', 'T');
  const iso = t.length <= 16 ? `${t}:00Z` : `${t}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Parse one BADC-CSV radiation file's text into a station record. Returns null if
// it isn't a radiation file (no glbl_irad_amt column) or has no usable location.
export function parseRadiationFile(text) {
  const lines = text.split(/\r?\n/);
  let dataIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (splitCsvLine(lines[i])[0]?.toLowerCase() === 'data') {
      dataIdx = i;
      break;
    }
  }
  if (dataIdx === -1) return null;

  const { lat, lng, srcId } = parseHeader(lines.slice(0, dataIdx));

  // First non-empty line after `data` is the column-name row.
  let colIdx = dataIdx + 1;
  while (colIdx < lines.length && lines[colIdx].trim() === '') colIdx++;
  if (colIdx >= lines.length) return null;
  const cols = splitCsvLine(lines[colIdx]).map((c) => c.toLowerCase());
  const idx = (name) => cols.indexOf(name);
  const iTime = idx('ob_end_time');
  const iGlbl = idx('glbl_irad_amt');
  const iDifu = idx('difu_irad_amt');
  const iVer = idx('version_num');
  const iHours = idx('ob_hour_count');
  if (iTime === -1 || iGlbl === -1) return null; // not a radiation obs file

  const rows = [];
  for (let i = colIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line);
    if (cells[0]?.toLowerCase() === 'end data') break;
    if (iVer !== -1 && cells[iVer] !== '1') continue; // quality-controlled rows only
    if (iHours !== -1 && cells[iHours] !== '' && cells[iHours] !== '1') continue; // hourly only
    const obEndTime = parseUtc(cells[iTime] ?? '');
    if (!obEndTime) continue;
    const glblKj = Number(cells[iGlbl]);
    if (!Number.isFinite(glblKj) || glblKj < 0) continue;
    let difuKwh = null;
    if (iDifu !== -1) {
      const difuKj = Number(cells[iDifu]);
      if (Number.isFinite(difuKj) && difuKj >= 0) difuKwh = difuKj / KJ_PER_KWH;
    }
    rows.push({ obEndTime, glblKwh: glblKj / KJ_PER_KWH, difuKwh });
  }

  if (lat === null || lng === null || rows.length === 0) return null;
  return { srcId, lat, lng, rows };
}
