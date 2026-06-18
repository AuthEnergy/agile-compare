// Seventh-round review fixes:
//  P2 share text must not coerce a missing Agile (null) to £0.00 -> "100%"
//  P2 the email's WHOLE-WINDOW figures get a whole-window mismatch caveat, even
//     when the headline (scoped) mismatch banner is correctly suppressed
//  P2 export failures populate state.failureDiag (like import does)
//  P3 failure-diag button copy discloses the account number is included

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const elements = {};
function mk(id) {
  return { id, value: "", innerHTML: "", textContent: "", href: "", download: "", scrollTop: 0, scrollHeight: 0, _children: [], firstChild: null,
    classList: { _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])), add(c){this._set.add(c)}, remove(c){this._set.delete(c)}, contains(c){return this._set.has(c)} },
    style: {}, appendChild(c){this._children.push(c);this.firstChild=this._children[0]}, insertBefore(n){this._children.unshift(n);this.firstChild=this._children[0]}, removeChild(){}, addEventListener(){}, querySelectorAll(){return[]}, click(){} };
}
global.document = { getElementById(id){if(!elements[id])elements[id]=mk(id);return elements[id]}, createElement(){return mk(null)}, querySelectorAll(){return Object.values(elements).filter(e=>e.classList.contains("screen"))}, body: mk("body") };
global.navigator = { clipboard: { writeText: async () => {} } };
global.btoa = s => Buffer.from(s, "binary").toString("base64");

const { state, renderResults, runExportComparison, validateInputs } = require("./app_module.js");
let passed = 0; function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }

const agreements = [
  { tariff_code: "E-1R-OLD-A", valid_from: "2025-01-01T00:00:00Z", valid_to: "2025-03-01T00:00:00Z" },
  { tariff_code: "E-1R-CUR-A", valid_from: "2025-03-01T00:00:00Z", valid_to: null },
];
function mkR(startISO, endISO, actualPence, withAgile) {
  const start = new Date(startISO), end = new Date(endISO);
  return {
    period: { start, end, displayStart: start, displayEnd: end, actualChargePence: actualPence, isSplit: false },
    flex: { kwh: 100, energyCostPence: 2000, standingChargePence: 135, totalPence: 2135, unmatchedReadings: 0, unmatchedStandingDays: 0 },
    agile: withAgile ? { kwh: 100, energyCostPence: 1800, standingChargePence: 150, totalPence: 1950, unmatchedReadings: 0, unmatchedStandingDays: 0 } : null,
    confident: true, wasClamped: false, suspectActual: false,
  };
}
function val(startISO, endISO, mismatch, billedKwh, observedKwh) {
  return { displayStart: new Date(startISO), displayEnd: new Date(endISO), billedKwh, observedKwh, mismatch,
    wasClamped: false, transactionsAvailable: true, transactionsComplete: true, electricityChargePence: 5000, creditsPence: 0, credits: [] };
}
function render(opts) {
  document.getElementById("results-content").innerHTML = "";
  renderResults(Object.assign({
    gapInfo: { gaps: [], duplicates: [], earliest: new Date("2025-01-01T00:00:00Z"), latest: new Date("2025-05-01T00:00:00Z") },
    regionLetter: "A", currentAgreement: agreements[1], agreements,
    periodFrom: new Date("2025-01-01T00:00:00Z"), periodTo: new Date("2025-05-01T00:00:00Z"),
    postcodeArea: "AB", statementValidation: [],
    missingEstimate: { totalKwh: 0, slots: 0, perGap: [] }, statementsIncomplete: false,
  }, opts));
  const content = document.getElementById("results-content").innerHTML;
  const mailto = decodeURIComponent((content.match(/href="(mailto:[^"]+)"/) || [])[1] || "");
  return { content, mailto };
}

(async () => {
  console.log("\n[A] Agile unavailable -> share suppressed (no 'Agile saved me 100%')\n");
  // Pre-switch + current period, both with an actual, narrows to current tariff,
  // but agileAvailable=false so summaryAgile is null.
  const a = render({
    results: [mkR("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", 5000, false), mkR("2025-04-01T00:00:00Z", "2025-05-01T00:00:00Z", 5200, false)],
    agileAvailable: false,
  });
  ok(/Agile \(calculated\)<\/div>\s*<div class="value">n\/a</.test(a.content), "the Agile card shows n/a when Agile is unavailable");
  ok(!a.content.includes("share-panel"), "the share panel is suppressed entirely (no Agile = nothing comparative to share)");
  ok(!/saved me|cheaper than Agile|100\.0%/.test(a.content), "no bogus 'Agile saved me 100.0%' claim from a null coerced to zero");

  console.log("\n[B] Out-of-scope mismatch: on-screen banner suppressed, but the whole-window email caveat IS present\n");
  const b = render({
    results: [mkR("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", 5000, true), mkR("2025-04-01T00:00:00Z", "2025-05-01T00:00:00Z", 5200, true)],
    agileAvailable: true,
    statementValidation: [ val("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", true, 400, 200), val("2025-04-01T00:00:00Z", "2025-05-01T00:00:00Z", false, 100, 100) ],
  });
  ok(!/Statement and smart-meter usage don't match/.test(b.content), "on-screen mismatch banner stays suppressed (the mismatch is outside the current-tariff headline scope)");
  ok(/billed and returned usage differ/.test(b.mailto), "the email — which sends WHOLE-WINDOW totals — carries the mismatch caveat (whole-window check), so it can't present 400-vs-200 kWh as clean");

  console.log("\n[C] Export failure populates state.failureDiag (was a no-op before)\n");
  document.getElementById("input-apikey").value = "sk_test_fakekey123"; validateInputs();
  state.isExport = true; state.accountNumber = "A-X"; state.mpan = "9999999999999"; state.serial = "EXP1"; state.serials = ["EXP1"];
  // MPAN not present in accountData -> region undetermined -> runExportComparison
  // throws synchronously (before any fetch) with the MPAN in the message.
  state.accountData = { number: "A-X", properties: [{ postcode: "AB1 2CD", electricity_meter_points: [{ mpan: "1234567890123", gsp: "_C", is_export: true, meters: [{ serial_number: "EXP1" }], agreements: [{ tariff_code: "E-1R-OUTGOING-FIX-12M-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] }] }] };
  state.failureDiag = { _stale: true };
  global.fetch = async () => { throw new Error("fetch should not be reached in this test"); };
  document.getElementById("results-content").innerHTML = "";
  await runExportComparison();
  ok(state.failureDiag && !state.failureDiag._stale && state.failureDiag.error, "an export failure builds a FRESH failure diagnostic (previously left the button to no-op / emit stale data)");
  ok(/region/i.test(state.failureDiag.error.message), "the export error was captured into the diagnostic");
  ok(!state.failureDiag.error.message.includes("9999999999999"), "the MPAN is redacted from the export failure diagnostic too");

  console.log("\n[D] Failure-diag button copy discloses the account number\n");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const desc = (html.match(/id="btn-failure-diag"[^>]*>[^<]*<\/button>\s*<span class="action-desc">([^<]+(?:&mdash;[^<]+)?)/) || [])[1] || html;
  ok(/account number/i.test(desc), "copy states the account number is included (so the user knows what they're sharing)");
  ok(/no MPAN, meter serial, address, or API key/i.test(html), "copy lists what is NOT included (MPAN, serial, address, API key)");

  console.log(`\nAll ${passed} seventh-round review assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
