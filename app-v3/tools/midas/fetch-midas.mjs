// Dev-time fetcher for a UK-spanning subset of MIDAS Open "uk-radiation-obs"
// v202507 from CEDA, for regenerating the bundled module from MEASURED data.
//
//   CEDA_TOKEN=<your CEDA access token> node tools/midas/fetch-midas.mjs
//   node tools/build-solar-profiles.mjs --source midas --midas-dir tools/midas-data
//
// Needs a CEDA account access token (CEDA account → "My Account" → Access Token;
// a short-lived bearer token). The token is read from the env only and never
// written anywhere. Downloads land in tools/midas-data/ (gitignored — only the
// GENERATED module is committed). We hit dap.ceda.ac.uk directly with the Bearer
// header because the data.ceda.ac.uk → dap cross-host 302 would strip it.
//
// This is intentionally a SUBSET (a spread of stations across the climate zones,
// a few recent years each) — tens of MB, not the full ~3 GB. Zones without a
// station fall back to modelled shapes (reported in provenance).

/* global fetch */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Auth: a CEDA access token (Bearer) or a logged-in browser cookie string. Read
// from the env only — never written, logged, or committed.
const TOKEN = process.env.CEDA_TOKEN;
const COOKIE = process.env.CEDA_COOKIE;
if (!TOKEN && !COOKIE) {
  console.error(
    'Set CEDA_TOKEN (a CEDA access token) or CEDA_COOKIE (a logged-in session cookie), e.g.\n' +
      '  CEDA_TOKEN=eyJ... node tools/midas/fetch-midas.mjs\n' +
      '  CEDA_COOKIE="$(cat cookie.txt)" node tools/midas/fetch-midas.mjs',
  );
  process.exit(2);
}

const INDEX =
  'https://data.ceda.ac.uk/badc/ukmo-midas-open/data/uk-radiation-obs/dataset-version-202507';
const DATA =
  'https://dap.ceda.ac.uk/badc/ukmo-midas-open/data/uk-radiation-obs/dataset-version-202507';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.MIDAS_OUT ?? join(here, '..', 'midas-data');

// One+ counties per climate zone, chosen from the public index for coverage.
const DEFAULT_COUNTIES = [
  'hampshire',
  'dorset',
  'devon',
  'cornwall',
  'kent',
  'greater-london',
  'norfolk',
  'suffolk',
  'west-midlands',
  'nottinghamshire',
  'dyfed',
  'gwynedd',
  'lancashire',
  'greater-manchester',
  'north-yorkshire',
  'west-yorkshire',
  'south-yorkshire',
  'humberside',
  'tyne-and-wear',
  'durham',
  'fife',
  'aberdeenshire',
  'western-isles',
  'down',
  'antrim',
];

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const counties = arg('--counties', DEFAULT_COUNTIES.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const stationsPerCounty = Number(arg('--stations-per-county', '2'));
const yearsPerStation = Number(arg('--years', '4'));
const maxFiles = Number(arg('--max-files', '250'));

const headers = COOKIE ? { Cookie: COOKIE } : { Authorization: `Bearer ${TOKEN}` };

async function indexJson(path) {
  const r = await fetch(`${INDEX}/${path}?json`);
  if (!r.ok) throw new Error(`index ${r.status} ${path}`);
  const j = await r.json();
  return j.items ?? [];
}
const isDir = (it) => it.type === 'dir' || (!it.ext && !it.size);
const baseName = (p) => p.replace(/\/+$/, '').split('/').pop();

// Collect candidate { name, url, md5 } CSVs for a county: a few stations, latest years.
async function filesForCounty(county) {
  let stations;
  try {
    stations = (await indexJson(county)).filter(isDir).slice(0, stationsPerCounty);
  } catch {
    return [];
  }
  const picked = [];
  for (const st of stations) {
    const station = baseName(st.path);
    let files = [];
    try {
      files = (await indexJson(`${county}/${station}/qc-version-1`)).filter(
        (it) => it.ext === '.csv',
      );
    } catch {
      continue;
    }
    // Largest files first: a full year of hourly radiation is ~160 KB, while a
    // near-empty station-year is tiny — so size is a good completeness proxy.
    files.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    for (const f of files.slice(0, yearsPerStation)) {
      const rel = `${county}/${station}/qc-version-1/${baseName(f.name ?? f.path)}`;
      picked.push({ rel, url: `${DATA}/${rel}?download=1`, md5: f.md5 ?? null });
    }
  }
  return picked;
}

function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const all = [];
  for (const c of counties) {
    const fs = await filesForCounty(c);
    process.stderr.write(`  ${c}: ${fs.length} file(s)\n`);
    all.push(...fs);
    if (all.length >= maxFiles) break;
  }
  const todo = all.slice(0, maxFiles);
  process.stderr.write(`Downloading up to ${todo.length} files into ${OUT}\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const f of todo) {
    const dest = join(OUT, f.rel.replace(/\//g, '__'));
    if (existsSync(dest)) {
      if (!f.md5 || md5(readFileSync(dest)) === f.md5) {
        skipped++;
        continue;
      }
    }
    try {
      const r = await fetch(f.url, { headers, redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      // A login page comes back as HTML, not BADC-CSV — catch a bad/expired token.
      const head = buf.subarray(0, 200).toString('utf8').toLowerCase();
      if (head.includes('<!doctype html') || head.includes('<html')) {
        throw new Error('got an HTML login page — token missing/expired or not accepted by dap');
      }
      if (f.md5 && md5(buf) !== f.md5) throw new Error('md5 mismatch');
      writeFileSync(dest, buf);
      ok++;
    } catch (e) {
      failed++;
      process.stderr.write(`  FAIL ${f.rel}: ${e.message}\n`);
      if (/login page/.test(e.message)) {
        process.stderr.write('Stopping — fix the token and re-run.\n');
        break;
      }
    }
  }
  process.stderr.write(`done: ${ok} downloaded, ${skipped} already present, ${failed} failed.\n`);
  if (ok === 0 && skipped === 0) process.exit(1);
}

main();
