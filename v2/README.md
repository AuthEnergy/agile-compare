# Octopus Tariff Check

A single-page, browser-only tool by [auth.energy](https://auth.energy) that pulls your real half-hourly Octopus Energy consumption and tells you what it would actually have cost on **Flexible Octopus** and **Agile Octopus**, using each tariff's real historical rates for the exact dates involved — then compares both against what you actually paid, taken from your real billing statements.

**Live version:** [authenergy.github.io/agile-compare](https://authenergy.github.io/agile-compare/)

## What it does

1. Fetches your account details and confirms your meter's region.
2. Fetches your real billing periods and the amount you were actually charged for each one.
3. Pulls half-hourly consumption covering exactly that billing history (up to 7 days ago, since Octopus's smart-meter data typically takes a few days to settle) — the fetch window is built from your real statement dates, not a fixed calendar year, so a normal billing period is never partially cut off.
4. Checks that data for gaps and flags any it finds.
5. Looks up the real historical unit rates and standing charges for both Flexible Octopus (which changes roughly quarterly) and Agile Octopus (which changes every half hour) across that same window.
6. Calculates what each billing period would have cost under each tariff, and shows it next to what you actually paid.

## Where your data goes

Nowhere except Octopus, with one optional exception. This is a static HTML file with no backend, no analytics, and no server of any kind. Every request it makes goes directly from your browser to `api.octopus.energy` using your own API key. Open your browser's network tab while running it if you want to verify this yourself — that's the whole point of it being a single inspectable file rather than a packaged app.

The one exception: a results screen button labelled "Email this summary to auth.energy." It opens a pre-filled draft in your own email app — it does not send anything automatically — containing only your postcode's outward code (e.g. "N15", never the full postcode), the comparison period, total kWh, and the three totals (actual, calculated Flexible, calculated Agile). It never includes your API key, account number, MPAN, meter serial, or raw consumption data. You can review or cancel the draft before it ever leaves your device.

You only ever enter your API key — your account number, MPAN, and meter serial are discovered from Octopus each run and are **never stored**. By default the API key is held only in your browser's memory for the duration of the page being open, and is gone the moment you close or reload the tab. There's an optional "Store my API key on this device" checkbox (off by default) — ticking it saves **only the API key** to that browser's `localStorage` (not a cookie, never transmitted anywhere) until you clear it via the button that appears once something's saved, or clear your browser's site data for the page. Note that any script running on this page's origin could read `localStorage`, so leave it off on shared or public computers.

**You should still treat your API key like a password.** Don't paste it into a copy of this tool you don't trust, don't share a screenshot or recording that shows it, and avoid using the "remember" option on a shared or public computer.

## Running it

**Option A — GitHub Pages (recommended for sharing):**
1. Fork or clone this repo.
2. In your repo's settings: **Settings → Pages → Source**, choose your default branch and the root folder.
3. GitHub will publish it at `https://<your-username>.github.io/<repo-name>/` within a minute or two, and rebuild automatically on every push.

**Option B — just open the file:**
Download `index.html` and open it directly in Chrome (or any modern browser). No server, no build step, no install.

You'll need **just one thing** from your Octopus dashboard at [octopus.energy/dashboard/developer](https://octopus.energy/dashboard/developer/): **your API key**. The app discovers your account(s), electricity meter(s), MPAN, serial number(s) and tariffs from Octopus automatically. If you have more than one electricity meter it shows a picker so you can choose which to analyse — **import** meters are compared on Flexible vs Agile, and **export** meters (solar/generation) are valued under the export tariffs (Outgoing Octopus vs Agile Outgoing).

## Known limitations

- **Standing-charge and unit-rate history across retired product codes.** Octopus periodically retires a product code and replaces it (Agile has gone through several versions). The app discovers **all** Flexible/Agile product versions whose availability overlaps your comparison window and merges their rate windows, so a window spanning a product switch is priced correctly. If coverage still has a gap, the affected readings are flagged as "unmatched" rather than silently miscalculated.
- **Statement history across multiple ledgers.** Octopus exposes statements per ledger but the API can't be paged safely with a single cursor across several paginated ledgers, so on those rare accounts the app stops and flags the history as possibly incomplete rather than risk skipped/duplicated periods.
- **Statements with more than 100 transactions** return only the first page; the app detects this and does not present that statement's electricity charge or billed kWh as complete.
- **Gaps in your smart-meter data reduce accuracy.** Missing half-hour readings contribute zero consumption for that slot rather than an estimate, so a billing period with reading gaps will show as understated. The gap report tells you exactly which dates are affected.
- **This is not financial advice and not affiliated with Octopus Energy.** It's a calculator built from Octopus's own public API. Always check your actual bills and Octopus's own tariff comparison tools before making a switching decision.

## Testing

The calculation logic (gap detection, rate-window matching, period costing) is covered by a small Node test suite in `/tests`, run against the actual app code (extracted live from `index.html`, not a hand-maintained copy, so the tests can't silently drift out of sync with the real app).

```
npm test
```

This regenerates the test module from `index.html` and runs the suites under `/tests`: core calculation logic, a mocked end-to-end pipeline run, billing-period clamping regressions, a realistic-case to-the-penny sanity check, the API-key `localStorage` save/load/clear behaviour, billed-vs-observed validation (statement charge/credit/net split, dual-fuel electricity isolation, tariff classification, HTML escaping, diagnostics download), the historical-product-merge and export-tariff features, and the beta-review hardening (per-ledger statement pagination safety, the incomplete-transaction guard, the no-confident-periods headline suppression, split-period handling, multi-serial consumption merge, and a rate-lookup performance smoke test).

## Contributing

It's one HTML file. Open a PR. If you're changing the calculation logic, please add or update a test in `/tests` covering the change — that's how the bugs mentioned above got caught before anyone saw a wrong number.

## Copyright and license

Copyright (c) 2026 Auth Energy Ltd. Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) — free to use, modify, and distribute for any noncommercial purpose (personal, educational, charitable, research, government). Commercial use requires permission from Auth Energy Ltd; get in touch at [hello@auth.energy](mailto:hello@auth.energy).
