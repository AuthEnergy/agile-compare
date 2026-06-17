# Octopus Tariff Check

A single-page, browser-only tool that pulls roughly a year of your real half-hourly Octopus Energy consumption and tells you what it would actually have cost on **Flexible Octopus** and **Agile Octopus**, using each tariff's real historical rates for the exact dates involved — then compares both against what you actually paid, taken from your real billing statements.

**Live version:** `https://<your-username>.github.io/<repo-name>/` (replace once GitHub Pages is enabled — see below).

## What it does

1. Fetches your account details and confirms your meter's region.
2. Pulls ~12 months of half-hourly consumption (up to 7 days ago, since Octopus's smart-meter data typically takes a few days to settle).
3. Checks that data for gaps and flags any it finds.
4. Fetches your real billing periods and the amount you were actually charged for each one.
5. Looks up the real historical unit rates and standing charges for both Flexible Octopus (which changes roughly quarterly) and Agile Octopus (which changes every half hour) across that same window.
6. Calculates what each billing period would have cost under each tariff, and shows it next to what you actually paid.

## Where your data goes

Nowhere except Octopus. This is a static HTML file with no backend, no analytics, and no server of any kind. Every request it makes goes directly from your browser to `api.octopus.energy` using your own API key. Open your browser's network tab while running it if you want to verify this yourself — that's the whole point of it being a single inspectable file rather than a packaged app.

By default, your API key, account number, MPAN, and meter serial are only ever held in your browser's memory for the duration of the page being open, and are gone the moment you close or reload the tab. There's an optional "remember these details in this browser" checkbox if you'd rather not re-enter them every time — ticking it saves them to that browser's `localStorage` (not a cookie, never transmitted anywhere) until you clear them via the button that appears once something's saved, or clear your browser's site data for the page.

**You should still treat your API key like a password.** Don't paste it into a copy of this tool you don't trust, don't share a screenshot or recording that shows it, and avoid using the "remember" option on a shared or public computer.

## Running it

**Option A — GitHub Pages (recommended for sharing):**
1. Fork or clone this repo.
2. In your repo's settings: **Settings → Pages → Source**, choose your default branch and the root folder.
3. GitHub will publish it at `https://<your-username>.github.io/<repo-name>/` within a minute or two, and rebuild automatically on every push.

**Option B — just open the file:**
Download `index.html` and open it directly in Chrome (or any modern browser). No server, no build step, no install.

You'll need four things from your Octopus dashboard at [octopus.energy/dashboard/developer](https://octopus.energy/dashboard/developer/):
- Your API key
- Your account number (format `A-AAAA1111`)
- Your electricity meter's MPAN (13 digits)
- Your meter's serial number

The app's input screen links to that dashboard page and explains where to find each one.

## Known limitations

- **CORS is unverified.** This tool calls Octopus's API directly from your browser. Whether Octopus's API sends the right CORS headers to permit that from an arbitrary page hasn't been confirmed against the live API at the time of writing. If it doesn't, the app will fail clearly on the very first request with a message explaining that's likely what happened — it won't hang or fail silently. If this turns out to be a real blocker, the fix would be routing requests through a small serverless proxy, which is a different piece of infrastructure than what's here today. Contributions/reports on this welcome.
- **Standing-charge and unit-rate history depends on Octopus's product codes staying the same.** Flexible Octopus's product code has been stable since November 2022, and Agile Octopus's since October 2024; the app discovers the current live product dynamically rather than hardcoding either, but if Octopus retires a product mid-comparison-window without the older one's rate history remaining queryable, some readings may show as "unmatched" in the results — this is flagged in the output rather than silently miscalculated.
- **Gaps in your smart-meter data reduce accuracy.** Missing half-hour readings contribute zero consumption for that slot rather than an estimate, so a billing period with reading gaps will show as understated. The gap report tells you exactly which dates are affected.
- **This is not financial advice and not affiliated with Octopus Energy.** It's a calculator built from Octopus's own public API. Always check your actual bills and Octopus's own tariff comparison tools before making a switching decision.

## Testing

The calculation logic (gap detection, rate-window matching, period costing) is covered by a small Node test suite in `/tests`, run against the actual app code (extracted live from `index.html`, not a hand-maintained copy, so the tests can't silently drift out of sync with the real app).

```
npm test
```

This regenerates the test module from `index.html` and runs five suites: core calculation logic (including region detection against a real account response shape), a mocked end-to-end pipeline run, a regression test for a billing-period-date-clamping bug found and fixed during development, a realistic-case sanity check that all rendered totals match hand-calculated expected values to the penny, and the "remember my details" localStorage save/load/clear behaviour.

## Contributing

It's one HTML file. Open a PR. If you're changing the calculation logic, please add or update a test in `/tests` covering the change — that's how the clamping bug mentioned above got caught before anyone saw a wrong number.
