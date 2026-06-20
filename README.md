# Octopus Tariff Check

A single-page, browser-only tool by [auth.energy](https://auth.energy) that pulls your real half-hourly Octopus Energy consumption and shows what it would actually have cost on **Flexible Octopus** and **Agile Octopus**, using each tariff's real historical rates for the exact dates involved — then compares both against what you actually paid, taken from your real billing statements. You can drill any complete month down to its daily totals and individual half-hour slots.

**Live version:** [authenergy.github.io/agile-compare](https://authenergy.github.io/agile-compare/)

The live site serves **v3** — a typed, modular rewrite that still builds to one self-contained, inspectable HTML file. The previous single-file version lives in [`v2/`](v2/).

## What it does

1. You paste a **read-only Octopus API key** — that's the only thing you enter. Everything else (your account, meter, region, billing history) is discovered from Octopus for you, and if the key has more than one meter you pick which to compare.
2. Fetches your real billing periods and the amount you were actually charged for each.
3. Pulls half-hourly consumption up to ~7 days ago (Octopus's smart-meter data takes a few days to settle). Usage newer than your latest bill is still compared on rates — you just won't see an "actual paid" for it.
4. Checks the data for gaps and flags any it finds.
5. Looks up the real historical unit rates and standing charges for Flexible Octopus (changes roughly quarterly) and Agile Octopus (changes every half hour) across the same window.
6. Calculates what each period would have cost under each tariff and shows it next to what you actually paid — compared against the standard tariff you're **not** already on (Agile by default; Flexible if you're already on Agile).

## Where your data goes

**Nowhere except Octopus and (opt-in) PostHog.** This is a static HTML file with no backend and no server of any kind. Every request goes directly from your browser to `api.octopus.energy` using your own API key. The page loads no external scripts, styles, fonts, or images — open your browser's network tab to verify, which is the whole point of it being one inspectable file.

- **Analytics (opt-in, on by default):** if you leave "Share anonymous results with Auth Energy" ticked on the connect screen, one event is sent to [PostHog](https://posthog.com/) (EU-hosted, `eu.i.posthog.com`) when a comparison completes. It contains only: your postcode's **outward area** (e.g. "SW1"), the **% difference** between tariffs, **total kWh** used, and the **period length in days**. If a comparison fails, a second event records only the error type, HTTP status code, whether it looks CORS-related, and which stage failed. No API key, account number, MPAN, meter serial, full postcode, or £ amounts are ever sent. PostHog is configured with autocapture and session recording explicitly disabled — only those two events can fire. Untick the checkbox to send nothing at all.
- **Storage:** by default nothing is stored. Only your **API key** is saved, and only if you tick **"remember my key"** — to your browser's `localStorage` (not a cookie, never transmitted), until you clear it. Your account number, MPAN, and meter serial are discovered from Octopus each run and are **never** stored.
- **Diagnostics / share are manual.** "Download diagnostics", "Submit to support", and the social share are opt-in and send nothing automatically. A diagnostics bundle carries your half-hourly figures, rate windows, per-period summaries, and your postcode's **outward area only** (e.g. "N15") — never your API key, account number, MPAN, meter serial, or full address. The social share uses **percentages only**, never your bill amounts.

**Treat your API key like a password.** Don't paste it into a copy of this tool you don't trust, don't share a screenshot that shows it, and avoid the "remember" option on a shared computer.

## Running it

**Use the hosted version** above, or run your own:

**Option A — GitHub Pages (your own fork).** Pushing to `main` runs the `deploy v3 to pages` GitHub Action, which installs dependencies, runs the full v3 gate, rebuilds `v3/index.html`, checks the committed build is fresh, and publishes it at the root of your Pages site. Enable Pages with **Settings → Pages → Source → GitHub Actions**.

**Option B — open the built file.** `v3/index.html` is a single self-contained file. Download it and open it directly in any modern browser (`file://`), or serve it from any static host — no server or build step needed to *run* it.

You only need one thing from your Octopus dashboard at [octopus.energy/dashboard/developer](https://octopus.energy/dashboard/developer/): your **API key**. The connect screen links there.

### Offline replay

Already have a downloaded diagnostics file? On the connect screen choose **"Replay a saved diagnostics file offline"** to re-render the full results from that file — no API key and no network calls. (Replay covers import-meter diagnostics today.)

## Development

The app source is in [`app-v3/`](app-v3/) — a self-contained Vite + TypeScript project that builds to one unminified, CSP-compatible `v3/index.html` via `vite-plugin-singlefile`. The committed `v3/index.html` is generated output.

```bash
npm --prefix app-v3 ci      # install (once)
npm --prefix app-v3 run dev # local dev server with HMR
npm run build:v3            # build + verify the single-file output → v3/index.html
npm run check               # typecheck + lint + format + unit + build + staleness + e2e
```

Architecture is layered so the calculation engine has no DOM or network dependency: `domain/` (pure rates/cost/periods/headline/drilldown), `api/` (injected Octopus client), `flows/` (return typed models, no DOM), `diagnostics/`, `ui/` (the only DOM layer).

## Testing

```bash
npm run test:v3    # Vitest unit + jsdom DOM tests
npm run test:e2e   # Playwright e2e against the BUILT v3/index.html (asserts zero CSP violations)
```

Unit tests cover the pure domain (rate matching, costing, gap detection, headline scoping, drill-down Σ-invariants), the flows against a mocked Octopus API, and a backward-compatibility fixture asserting a diagnostics file still replays to identical totals. The e2e suite boots the real built file under the production CSP.

## Known limitations

- **Rate history depends on Octopus's product codes.** The app discovers live products dynamically rather than hardcoding them, but if Octopus retires a product mid-window without the older one's rate history remaining queryable, some slots show as "unmatched" — flagged in the output, never silently miscalculated.
- **Gaps reduce accuracy.** A missing half-hour reading contributes zero for that slot rather than an estimate, so a period with gaps reads understated. The gap report tells you exactly which dates are affected.
- **Not financial advice and not affiliated with Octopus Energy.** It's a calculator built from Octopus's own public API. Always check your real bills and Octopus's own tariff tools before switching.

## Copyright and license

Copyright (c) 2026 Auth Energy Ltd. Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) — free to use, modify, and distribute for any noncommercial purpose (personal, educational, charitable, research, government). Commercial use requires permission from Auth Energy Ltd; get in touch at [hello@auth.energy](mailto:hello@auth.energy).
