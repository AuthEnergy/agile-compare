// CI gate over the BUILT v3/index.html. Proves the deployed artifact is one
// self-contained, unminified, CSP-intact file — the privacy/auditability USP.
// (Staleness — "committed v3/ == build(source)" — is a separate `git diff
// --exit-code -- v3/` step; this script checks the file's shape, not freshness.)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const builtPath = join(here, '..', '..', 'v3', 'index.html');

// Deliberate v3 policy: Octopus API plus narrow direct PostHog event capture.
const CANONICAL_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; ` +
  `connect-src https://api.octopus.energy https://eu.i.posthog.com; frame-src 'none'; child-src 'none'; ` +
  `font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;

// Known exported/domain identifiers that must survive an UNMINIFIED build. Grows
// per phase via the env (Rollup may rewrite the declaration form but keeps names).
const REQUIRED_IDENTIFIERS = (process.env.V3_VERIFY_IDENTIFIERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const errors = [];

if (!existsSync(builtPath)) {
  console.error(`verify-single-file: built file missing at ${builtPath} (run the build first)`);
  process.exit(1);
}
const html = readFileSync(builtPath, 'utf8');

// 1) CSP byte-for-byte against the v3 policy above.
if (!html.includes(CANONICAL_CSP)) {
  errors.push('CSP meta does not match the canonical v3 policy byte-for-byte');
}

// 2) No external script/style/asset references (would break the CSP boot / single-file).
if (/<script[^>]+\bsrc\s*=/i.test(html))
  errors.push('external <script src> found — not single-file');
if (/<link[^>]+\bhref\s*=\s*["'](?!data:)[^"']/i.test(html)) {
  errors.push('external <link href> found (stylesheet/modulepreload) — not single-file');
}
if (/(?:src|href)\s*=\s*["'][^"']*\/assets\//i.test(html)) {
  errors.push('/assets/ reference found — build emitted separate assets');
}

// 3) Unminified: many short lines, no absurdly long single line.
// Threshold is 5 000 (not 2 000) to allow long, hand-readable literals;
// real minifiers produce lines of 50 000+.
const lines = html.split('\n');
const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
if (lines.length < 20) errors.push(`only ${lines.length} lines — looks minified/single-line`);
if (longest > 5000) errors.push(`longest line is ${longest} chars — looks minified`);

// 4) Required domain identifiers survived.
for (const id of REQUIRED_IDENTIFIERS) {
  if (!html.includes(id)) errors.push(`expected identifier "${id}" not found in built output`);
}

if (errors.length) {
  console.error('verify-single-file FAILED:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(
  `verify-single-file OK — ${lines.length} lines, longest ${longest}, CSP intact, single-file` +
    (REQUIRED_IDENTIFIERS.length ? `, ${REQUIRED_IDENTIFIERS.length} identifiers present` : ''),
);
