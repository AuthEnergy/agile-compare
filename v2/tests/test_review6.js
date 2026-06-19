// Sixth-round review fix:
//  P2 the billed-vs-observed mismatch + truncated-transaction signals (banner,
//     "not directly comparable" cards, and the email caveat) are scoped to the
//     statements overlapping the SUMMARY scope. A pre-switch statement's
//     mismatch must NOT caveat a clean current-tariff summary — but a mismatch
//     in the summarised periods still must.

const assert = require("assert");

const elements = {};
function mk(id) {
  return { id, value: "", innerHTML: "", textContent: "", href: "", download: "", scrollTop: 0, scrollHeight: 0, _children: [], firstChild: null,
    classList: { _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])), add(c){this._set.add(c)}, remove(c){this._set.delete(c)}, contains(c){return this._set.has(c)} },
    style: {}, appendChild(c){this._children.push(c);this.firstChild=this._children[0]}, insertBefore(n){this._children.unshift(n);this.firstChild=this._children[0]}, removeChild(){}, addEventListener(){}, querySelectorAll(){return[]}, click(){} };
}
global.document = { getElementById(id){if(!elements[id])elements[id]=mk(id);return elements[id]}, createElement(){return mk(null)}, querySelectorAll(){return Object.values(elements).filter(e=>e.classList.contains("screen"))}, body: mk("body") };
global.navigator = { clipboard: { writeText: async () => {} } };

const { renderResults } = require("./app_module.js");
let passed = 0; function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }

const agreements = [
  { tariff_code: "E-1R-OLD-A", valid_from: "2025-01-01T00:00:00Z", valid_to: "2025-03-01T00:00:00Z" },
  { tariff_code: "E-1R-CUR-A", valid_from: "2025-03-01T00:00:00Z", valid_to: null },
];
function mkR(startISO, endISO, actualPence) {
  const start = new Date(startISO), end = new Date(endISO);
  return {
    period: { start, end, displayStart: start, displayEnd: end, actualChargePence: actualPence, isSplit: false },
    flex: { kwh: 100, energyCostPence: 2000, standingChargePence: 135, totalPence: 2135, unmatchedReadings: 0, unmatchedStandingDays: 0 },
    agile: { kwh: 100, energyCostPence: 1800, standingChargePence: 150, totalPence: 1950, unmatchedReadings: 0, unmatchedStandingDays: 0 },
    confident: true, wasClamped: false, suspectActual: false,
  };
}
function val(startISO, endISO, mismatch, billedKwh, observedKwh) {
  return { displayStart: new Date(startISO), displayEnd: new Date(endISO), billedKwh, observedKwh, mismatch,
    wasClamped: false, transactionsAvailable: true, transactionsComplete: true, electricityChargePence: 5000, creditsPence: 0, credits: [] };
}
function render(statementValidation) {
  document.getElementById("results-content").innerHTML = "";
  renderResults({
    results: [mkR("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", 5000), mkR("2025-04-01T00:00:00Z", "2025-05-01T00:00:00Z", 5200)],
    gapInfo: { gaps: [], duplicates: [], earliest: new Date("2025-01-01T00:00:00Z"), latest: new Date("2025-05-01T00:00:00Z") },
    regionLetter: "A", currentAgreement: agreements[1], agreements,
    periodFrom: new Date("2025-01-01T00:00:00Z"), periodTo: new Date("2025-05-01T00:00:00Z"),
    agileAvailable: true, postcodeArea: "AB", statementValidation,
    missingEstimate: { totalKwh: 0, slots: 0, perGap: [] }, statementsIncomplete: false,
  });
  const content = document.getElementById("results-content").innerHTML;
  const mailto = decodeURIComponent((content.match(/href="(mailto:[^"]+)"/) || [])[1] || "");
  return { content, mailto };
}

(async () => {
  console.log("\n[A] Mismatch only in the EXCLUDED pre-switch statement -> clean current-tariff summary is not caveated\n");
  // Pre-switch statement (Jan) mismatches; current-tariff statement (Apr) clean.
  // Summary narrows to the Apr period, which is clean.
  const a = render([ val("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", true, 300, 200), val("2025-04-01T00:00:00Z", "2025-05-01T00:00:00Z", false, 100, 100) ]);
  ok(/2 of 2|of 2 periods|Current tariff, complete data/.test(a.content), "summary narrowed to the current-tariff period");
  ok(!/Statement and smart-meter usage don't match/.test(a.content), "the mismatch banner is suppressed (the mismatch is outside the summary scope)");
  ok(!/delta not-comparable/.test(a.content), "the Flexible/Agile cards are NOT flagged 'not directly comparable' (the static footnote prose doesn't count)");
  // The on-screen headline (scoped) banner is suppressed above, but the email
  // reports WHOLE-WINDOW figures (totalKwh, billedKwhTotal, totalFlex/Agile), so
  // a whole-window mismatch MUST still be caveated there — otherwise the email
  // presents 300-vs-200 kWh as if clean (see seventh-round P2 / test_review7 B).
  ok(/billed and returned usage differ/.test(a.mailto), "the emailed summary DOES carry a mismatch caveat (its figures are whole-window, so the caveat is whole-window) even though the scoped on-screen banner is suppressed");

  console.log("\n[B] Mismatch in the SUMMARISED current-tariff statement -> still caveated (no over-suppression)\n");
  // Now the current-tariff (Apr) statement itself mismatches.
  const b = render([ val("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", false, 100, 100), val("2025-04-01T00:00:00Z", "2025-05-01T00:00:00Z", true, 300, 200) ]);
  ok(/Statement and smart-meter usage don't match/.test(b.content), "the mismatch banner DOES appear when the summarised period mismatches");
  ok(/delta not-comparable/.test(b.content), "the cards are correctly flagged 'not directly comparable' when the in-scope statement mismatches");
  ok(/billed 300\.00 kWh.*returned 200\.00 kWh/.test(b.content.replace(/&nbsp;|&middot;|·|\s+/g, m => /\s/.test(m) ? " " : "")) || /300\.00 kWh/.test(b.content), "banner figures reflect the in-scope statement (300 billed)");
  ok(/billed and returned usage differ/.test(b.mailto), "the emailed summary carries the mismatch caveat when the summarised period mismatches");

  console.log(`\nAll ${passed} sixth-round review assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
