import { APP_VERSION } from '../config';
import { el } from './dom';

// Short, on-screen build version (e.g. "v0.3.0") derived from the same constant
// stamped into diagnostics, so the two can never drift.
const VERSION_LABEL = APP_VERSION.match(/v\d[\w.-]*/)?.[0] ?? '';

// Persistent legal/privacy footer. Ported from v2 — the disclaimer wording is
// VERBATIM (legal text); the privacy disclosure is adapted to v3's actual
// diagnostics bundle (which carries raw half-hourly readings for replay, but no
// identifiers). Shown on every screen.

const DISCLAIMER_REST =
  ' This tool is provided "as is" with no warranty of any kind, express or implied, including as to accuracy, completeness, or fitness for any particular purpose. It is not financial or professional advice, and Auth Energy Ltd accepts no liability for decisions made using it. Calculations are based on Octopus’s own published rates and your own account data, but errors are possible — always check your real bills and Octopus’s own tariff tools before switching. Past tariff performance does not indicate future performance: a tariff that would have been cheaper over the period shown is not guaranteed to be cheaper going forward, since both your usage and tariff rates can change.';

const PRIVACY_PARAGRAPHS = [
  'This page has no backend. There is no server collecting your data, because there is no server at all — it is a single static HTML file, viewable by anyone via “view source” or this repository’s public code on GitHub.',
  'Energy data requests go directly from your browser to Octopus Energy’s own API at api.octopus.energy, using your own API key. If default-on anonymous sharing is left enabled, the app also sends one narrow event to EU-hosted PostHog after a comparison succeeds or fails. You can verify this yourself by opening your browser’s network tab while using the page.',
  'If you leave “Share anonymous results with Auth Energy” ticked on the connect screen (on by default, can be unticked before running a comparison), one event is sent to PostHog when your comparison completes. It contains only: your postcode’s outward area (e.g. “SW1”), the percentage difference between tariffs, total kWh used in the comparison period, and the length of that period in days. It never includes your API key, account number, MPAN, meter serial, full postcode, raw consumption, tariff data, dates, or any £ amounts. If a comparison fails, a second event is sent containing only the error type, HTTP status code if any, whether it looks CORS-related, and which stage failed. IP capture is disabled at the PostHog project level. Nothing is sent if you untick the checkbox before running. The app sends these events directly without PostHog cookies, browser persistence, autocapture, page views, feature flags, or session recording.',
  'The “Submit to support”, “Download” and “Replay a file” options are entirely manual — nothing is sent automatically. A diagnostics bundle includes your half-hourly consumption figures and the rate windows (so the run can be replayed), per-period summaries, confidence flags, and your postcode’s outward area only (e.g. “N15”). It never includes your API key, account number, MPAN, meter serial, or full address. For export meters, the raw half-hour export slots are excluded by default (they can reveal when you generate) and added only if you explicitly opt in. You can review, download, or cancel before anything leaves your device.',
  'The theme and analytics sharing preference may be saved using your browser’s local storage. If you tick “remember my key,” your API key is saved there too — a feature built into the browser itself, not a cookie, and not transmitted anywhere except to Octopus when you run a comparison. Your account number, MPAN, and meter serial are discovered from Octopus each time and are not stored. The saved key stays on your device until you clear it (toggle the switch off, or clear your browser’s site data for this page) and is never readable by any other website.',
  'Treat your Octopus API key like a password. Anyone with it can read your account’s billing and consumption history. If you use the “remember” option, that key sits in plain form in this browser’s storage, so avoid using it on a shared or public computer, and clear it when you’re done if you do.',
];

export function renderFooter(): HTMLElement {
  return el('footer', { class: 'app-footer' }, [
    el('div', { class: 'app-footer-inner' }, [
      el('p', { class: 'footer-disclaimer' }, [
        el('strong', { text: 'No warranty, no advice.' }),
        DISCLAIMER_REST,
      ]),
      el('details', { class: 'footer-details' }, [
        el('summary', { text: 'Privacy — how your key and data are handled' }),
        ...PRIVACY_PARAGRAPHS.map((p) => el('p', { class: 'footer-p', text: p })),
      ]),
      el('p', { class: 'footer-fine' }, [
        'Not affiliated with, or endorsed by, Octopus Energy. “Octopus Energy” and related marks are trademarks of their respective owners. ',
        '© 2026 Auth Energy Ltd · Licensed under the PolyForm Noncommercial License 1.0.0',
        VERSION_LABEL ? ` · Octopus Tariff Check ${VERSION_LABEL}` : '',
        ' · ',
        el('a', {
          href: 'https://github.com/AuthEnergy/agile-compare',
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Source on GitHub',
        }),
      ]),
    ]),
  ]);
}
