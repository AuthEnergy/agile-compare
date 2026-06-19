# AGENTS.md

Guidance for AI coding agents working in this repo. Read this before making changes.
(Claude Code: `CLAUDE.md` points here.)

## What this is

A browser-only **Octopus Energy tariff-confidence tool** for UK households. It reads
the user's own half-hourly Octopus data **in their browser** and shows what smarter
tariffs *would have cost* on their real usage — with confidence and caveats. There is
**no backend and no telemetry**; the only network call is to `api.octopus.energy`.

Two apps live here:

- **`v2/index.html`** — the legacy single-file app (inline JS/CSS, zero deps). Hardened
  on the `l-wip` branch. This is the **canonical source the v3 rewrite ports from** — when
  porting logic, cite the v2 line range and keep behaviour verbatim unless intentionally changing it.
- **`app-v3/`** — the active **TypeScript rewrite** (the current work). Builds to a single
  self-contained `v3/index.html`. **Do new work here.**

## THE constraint that dominates everything

The USP is *"one inspectable file that runs in your browser and talks only to Octopus."*
v3 **must** build to **one self-contained, UNMINIFIED `v3/index.html`** that boots under the
strict CSP (kept byte-for-byte from v2):

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src 'self' data:; connect-src https://api.octopus.energy;
frame/child/font/media/object-src 'none'; base-uri 'none'; form-action 'none'
```

Consequences you must respect:

- **No external scripts, styles, fonts, or images.** A default Vite build (hashed external
  `<script src>`) is CSP-blocked and won't boot. `font-src 'none'` → **no Google Fonts**: the
  IBM Plex stacks fall back to `system-ui` (the brand brief flags the typeface as a substitution).
- **No minification** — auditability is the point. `tools/verify-single-file.mjs` gates this.
- **Events via `addEventListener` only** — no inline `on*=` handler attributes (keeps the door
  open to future hash-based CSP).
- **`textContent`, never `innerHTML`, for any API/user-derived string** (XSS). The only `innerHTML`
  is static, trusted inline SVG icon paths in `ui/dom.ts`.

## Layout

```
app-v3/src/
  config.ts            app-wide constants (APP_VERSION, DIAGNOSTICS_RECIPIENT, REPLAY_CAPS)
  state.ts             createAppState() factory — NO module-level singleton
  data/sample.ts       synthetic "sample household" run (fake, faithful via calculateCost)
  domain/              PURE: no DOM / no fetch / no state (rates, cost, periods, gaps, tariff,
                       statements, headline, drilldown, redact)
  api/                 createClient(apiKey) injected; account, meters, consumption, products, statements
  flows/               runComparison → ComparisonRun, runExportComparison → ExportRun (return models, NO DOM)
  journey/nextSteps.ts Stage-2 "move your timing" prompts (pure, read-only over a run)
  diagnostics/         capture, failure, replay, bundle, submit (anonymised, DOM-free + injectable)
  storage/credentials  opt-in API-key storage (localStorage)
  ui/                  the ONLY DOM layer (app shell + screens + drill-down view + diagnostics modal)
  main.ts              composition root
app-v3/tests/          Vitest unit + jsdom
app-v3/tests-e2e/      Playwright vs the BUILT v3/index.html
v3/index.html          GENERATED, COMMITTED build output (do not hand-edit)
```

## Commands (run from the repo root)

```bash
npm --prefix app-v3 ci      # install (root stays dependency-free; app-v3 is self-contained)
npm run check               # the full gate: typecheck + lint + format + unit + build + verify + staleness + e2e
npm run typecheck           # tsc --noEmit (strict: noUncheckedIndexedAccess, exactOptionalPropertyTypes, ...)
npm run lint                # eslint . --max-warnings=0  (warnings FAIL)
npm run format:check        # prettier --check
npm run test:v3             # Vitest
npm run build:v3            # vite build (single-file) + verify-single-file
npm run test:e2e            # Playwright (Chromium, file://) against v3/index.html
```

Always finish with **`npm run check` green** before committing. `npm run check` includes a
**staleness gate** (`git diff --exit-code -- v3/`): if you change `app-v3/`, rebuild and commit
the regenerated `v3/index.html` in the same change.

## Architecture rules

- `domain/` is pure and is the equivalence oracle — keep it free of DOM/fetch/state.
- `api/` takes an injected `OctopusClient` (`createClient(apiKey)`); never reads globals.
- `flows/` return typed models (`ComparisonRun`/`ExportRun`), never touch the DOM; progress via an
  `onProgress` callback.
- `ui/` is the only place that touches the DOM. The app re-renders **only the current screen** on
  state change (the chrome is built once); the fade animates **only on screen transitions**.
- **Drill-down invariants (must hold, are tested):** the month→day→48-slot drill-down is a *view* of
  the headline aggregate. `Σ days === period` (energy, standing, total) and `Σ slots === day`. Days are
  **UTC** midnight-to-midnight (48 slots, no DST). Build lazily, cache child DOM — never render ~19k rows.

## Security — non-negotiable

- **Never put a secret in code, tests, commits, comments, or logs.** No real API keys (`sk_live_…`),
  account numbers (`A-…`), MPANs, or meter serials. The connect input placeholder `sk_live_xxxx…`
  (all x's) is fine; everything else must be obviously fake (e.g. `sk_test_FAKE`, MPAN `19000000000…`).
- **All test fixtures are fake.** The committed diagnostics fixture has no real data.
- `redactPII` is the belt-and-braces pass over any downloaded/shared bundle. Diagnostics **omit the
  account number by default**; export **raw half-hour slots only with explicit consent** (they reveal a
  generation pattern); postcode is reduced to outward area.
- `localStorage` holds **only** the opt-in API key + the theme — nothing else.

## Voice & design (consumer-confidence)

British English, **sentence case** (no Title Case), no emoji. Money is **evidence** — "would have
cost", **never a promise** ("guaranteed saving" / "you should switch" are banned). Stage-2 timing is
**move-don't-reduce** — shift flexible use to cheaper half-hours; **never** "use less" / "turn off".
Generic "flexible loads such as…" by default; name specific appliances only on explicit user selection.
Privacy is always visible; caveats are first-class. Design system: Auth Energy × ESA (calm civic-tech,
GOV.UK tradition, IBM Plex).

## Testing

- Unit (Vitest + jsdom) for domain/flows/diagnostics/ui; **Playwright e2e runs against the BUILT file**
  and asserts **zero CSP violations**.
- A diagnostics JSON produced by hardened l-wip v2 must still **replay to identical totals** (backward-compat fixture).
- Keep the **v2 Node suite green** (`npm --prefix v2 test`) as the cross-version equivalence oracle when touching ported logic.

## Deploy

GitHub Pages on the **`leecrossley` fork** → **https://leecrossley.github.io/agile-compare/**.
`.github/workflows/pages.yml` runs the full gate **then** publishes `v3/index.html` (tests gate the
deploy). It triggers on push to the **`v3`** branch (which is in the `github-pages` environment's allowed
branches). `.github/workflows/v3.yml` runs checks for PRs/branches; `v2-tests.yml` guards v2.
Live deploy to the upstream AuthEnergy Pages is out of scope.

## Git conventions

- Commit messages: **short, lowercase, shorthand** subject (e.g. `v3 p4: drill-down domain + stage-2`).
- End every commit message with the trailer: `Context provided by Overshow. https://over.show`.
- **Don't push unless asked.** Pushing `v3` triggers a public redeploy.
- When porting from v2, the source of truth is `v2/index.html` on the `l-wip` branch.

## Pointers

- Approved rewrite plan: `~/.claude/plans/rustling-seeking-stallman.md` (the phased v3 plan).
- v2 function surface to port from: `v2/tests/extract_module.js`.
- Design handoff (Tariff Confidence v3): the Auth Energy × ESA prototype + design system (HTML/CSS).
