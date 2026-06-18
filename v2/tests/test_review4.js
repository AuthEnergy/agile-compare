// Fourth-round review fixes:
//  P1 standing charges use rateAtSorted -> newer overlapping window wins
//     (a stale older open-ended standing window no longer beats a newer one)
//  P2 periods straddling an agreement change are "mixed" and excluded from the
//     current-tariff headline/share (no midpoint mis-attribution)
//  P3 diagnostics _summary reports standing-charge unmatched days
//  P3 CSP adds default-src 'none' + frame/child/font/media-src 'none'

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const elements = {}; let lastCreated = null, alertMsg = null;
function mk(id) {
  return { id, value: "", innerHTML: "", textContent: "", href: "", download: "", scrollTop: 0, scrollHeight: 0, _children: [], firstChild: null,
    classList: { _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])), add(c){this._set.add(c)}, remove(c){this._set.delete(c)}, contains(c){return this._set.has(c)} },
    style: {}, appendChild(c){this._children.push(c);this.firstChild=this._children[0]}, insertBefore(n){this._children.unshift(n);this.firstChild=this._children[0]}, removeChild(){}, addEventListener(){}, querySelectorAll(){return[]}, click(){} };
}
global.document = { getElementById(id){if(!elements[id])elements[id]=mk(id);return elements[id]}, createElement(){lastCreated=mk(null);return lastCreated}, querySelectorAll(){return Object.values(elements).filter(e=>e.classList.contains("screen"))}, body: mk("body") };
global.btoa = s => Buffer.from(s, "binary").toString("base64");
global.alert = m => { alertMsg = m; };
global.navigator = { clipboard: { writeText: async () => {} } };
let lastBlobContent = null;
global.Blob = function (parts) { lastBlobContent = parts[0]; };
// Augment the real WHATWG URL with the object-URL statics downloadDiagnostics
// needs — do NOT replace it, the app and the fetch mock rely on `new URL(...)`.
global.URL.createObjectURL = () => "blob:x";
global.URL.revokeObjectURL = () => {};
function mj(s, b) { return { ok: s >= 200 && s < 300, status: s, json: async () => b, text: async () => JSON.stringify(b) }; }
function ledgerData(l) { return mj(200, { data: { account: { ledgers: l } } }); }

const { state, calculateCost, tariffCodesInRange, renderResults, runComparison, validateInputs, downloadDiagnostics } = require("./app_module.js");
let passed = 0; function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }
state.apiKey = "sk_test_fakekey123";

(async () => {
  console.log("\n[A] Standing charges: newer overlapping window wins (rateAtSorted, not first-match)\n");
  // An older open-ended (validTo:null) standing window overlaps a newer one —
  // exactly what merged historical product versions produce. A linear first
  // -match would return the stale 10p; the fix returns the newer 99p.
  const unit = [{ validFrom: new Date("2020-01-01T00:00:00Z"), validTo: null, value: 25 }];
  const standOverlap = [
    { validFrom: new Date("2020-01-01T00:00:00Z"), validTo: null, value: 10 },
    { validFrom: new Date("2024-01-01T00:00:00Z"), validTo: null, value: 99 },
  ];
  const newP = calculateCost([], new Date("2025-06-01T00:00:00Z"), new Date("2025-06-03T00:00:00Z"), unit, standOverlap);
  ok(Math.abs(newP.standingChargePence - 198) < 1e-9, "two 2025 days priced at the newer 99p/day = 198p (a stale first-match would give 20p)");
  ok(newP.unmatchedStandingDays === 0, "both days are covered -> no unmatched standing days");
  const oldP = calculateCost([], new Date("2022-06-01T00:00:00Z"), new Date("2022-06-03T00:00:00Z"), unit, standOverlap);
  ok(Math.abs(oldP.standingChargePence - 20) < 1e-9, "before the newer window starts, the older 10p/day still applies = 20p");
  // The replay path passes standing windows unsorted with preSorted=true; the
  // lookup must still be correct, since calculateCost sorts standing itself.
  const reversed = [...standOverlap].reverse();
  const newP2 = calculateCost([], new Date("2025-06-01T00:00:00Z"), new Date("2025-06-03T00:00:00Z"), unit, reversed, true);
  ok(Math.abs(newP2.standingChargePence - 198) < 1e-9, "correct even when standing windows arrive unsorted with preSorted=true");

  console.log("\n[B] Periods spanning a tariff switch are mixed and kept out of the current-tariff comparison\n");
  const agreements = [
    { tariff_code: "E-1R-OLD-A", valid_from: "2025-01-01T00:00:00Z", valid_to: "2025-03-15T00:00:00Z" },
    { tariff_code: "E-1R-CUR-A", valid_from: "2025-03-15T00:00:00Z", valid_to: null },
  ];
  ok(tariffCodesInRange(agreements, new Date("2025-03-01T00:00:00Z"), new Date("2025-04-01T00:00:00Z")).size === 2,
    "a period straddling the 2025-03-15 switch is detected as mixed (2 codes)");
  ok(tariffCodesInRange(agreements, new Date("2025-04-01T00:00:00Z"), new Date("2025-05-01T00:00:00Z")).size === 1,
    "a clean post-switch period is single-tariff (1 code)");

  function mkResult(startISO, endISO, actualPence) {
    const start = new Date(startISO), end = new Date(endISO);
    return {
      period: { start, end, displayStart: start, displayEnd: end, actualChargePence: actualPence, isSplit: false },
      flex: { kwh: 100, energyCostPence: 2000, standingChargePence: 135, totalPence: 2135, unmatchedReadings: 0, unmatchedStandingDays: 0 },
      agile: { kwh: 100, energyCostPence: 1800, standingChargePence: 150, totalPence: 1950, unmatchedReadings: 0, unmatchedStandingDays: 0 },
      confident: true, wasClamped: false, suspectActual: false,
    };
  }
  // P_mixed midpoint (2025-03-16) lands AFTER the switch, so the OLD midpoint
  // logic would have wrongly counted it as a current-tariff period.
  const pMixed = mkResult("2025-03-01T00:00:00Z", "2025-04-01T00:00:00Z", 3000);
  const pCur1 = mkResult("2025-04-01T00:00:00Z", "2025-05-01T00:00:00Z", 3000);
  const pCur2 = mkResult("2025-05-01T00:00:00Z", "2025-06-01T00:00:00Z", 3000);
  document.getElementById("results-content").innerHTML = "";
  renderResults({
    results: [pMixed, pCur1, pCur2],
    gapInfo: { gaps: [], duplicates: [], earliest: new Date("2025-03-01T00:00:00Z"), latest: new Date("2025-06-01T00:00:00Z") },
    regionLetter: "A", currentAgreement: agreements[1], agreements,
    periodFrom: new Date("2025-03-01T00:00:00Z"), periodTo: new Date("2025-06-01T00:00:00Z"),
    agileAvailable: true, postcodeArea: "AB", statementValidation: [],
    missingEstimate: { totalKwh: 0, slots: 0, perGap: [] }, statementsIncomplete: false,
  });
  const bContent = document.getElementById("results-content").innerHTML;
  ok(/mixed tariff/i.test(bContent), "the straddling period is labelled 'mixed tariff' in the table");
  ok(/2 of 3/.test(bContent), "the current-tariff comparison covers 2 of 3 periods (the mixed one is excluded)");
  // Current-tariff-only flex total = the two clean periods (2135 + 2135 = £42.70),
  // NOT all three (£64.05) — proving the mixed period is left out of the total.
  ok(bContent.includes("42.70") && !/Current tariff[^<]*42\.70[^<]*64\.05/.test(bContent), "current-tariff total sums only the two clean periods (£42.70)");

  console.log("\n[C] Diagnostics summary reports standing-charge coverage\n");
  const step = 30 * 60 * 1000, FLEX = "VAR-22-11-01", AGILE = "AGILE-24-10-01";
  const winEnd = new Date(); winEnd.setUTCDate(winEnd.getUTCDate() - 10); winEnd.setUTCHours(0, 0, 0, 0);
  const winStart = new Date(winEnd); winStart.setUTCDate(winStart.getUTCDate() - 30);
  // standingFuture: the standing-charge window starts in 2099, so every day in
  // the window is uncovered -> unmatchedStandingDays > 0 while readings match.
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url.toString());
    if (u.pathname.includes("/graphql/")) {
      const b = JSON.parse(opts.body);
      if (b.query.includes("obtainKrakenToken")) return mj(200, { data: { obtainKrakenToken: { token: "t" } } });
      if (b.query.includes("Statements")) return ledgerData([{ statements: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: 1, startAt: winStart.toISOString(), endAt: winEnd.toISOString(), totalCharges: { grossTotal: 12000 }, transactions: { totalCount: 1, pageInfo: { hasNextPage: false }, edges: [{ node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 12000 }, consumption: { quantity: 432 } } }] } } }] } }]);
      throw new Error("gql");
    }
    if (u.pathname.includes("/consumption/")) { const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to")); const r = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime() + step); r.push({ consumption: 0.3, interval_start: t.toISOString(), interval_end: e.toISOString() }); t = e; } return mj(200, { count: r.length, next: null, results: r }); }
    if (u.pathname === "/v1/products/") return mj(200, { count: 2, next: null, results: [{ code: FLEX, display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_to: null }, { code: AGILE, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_to: null }] });
    if (u.pathname.match(/\/products\/[^/]+\/$/)) { const pc = u.pathname.split("/")[3]; return mj(200, { code: pc, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: pc === FLEX ? "E-1R-VAR-22-11-01-C" : "E-1R-AGILE-24-10-01-C" } } } }); }
    if (u.pathname.includes(FLEX) && u.pathname.includes("standard-unit-rates")) return mj(200, { results: [{ value_inc_vat: 25, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    if (u.pathname.includes(AGILE) && u.pathname.includes("standard-unit-rates")) { const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to")); const r = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime() + step); r.push({ value_inc_vat: 18, valid_from: t.toISOString(), valid_to: e.toISOString(), payment_method: null }); t = e; } return mj(200, { results: r }); }
    if (u.pathname.includes("standing-charges")) return mj(200, { results: [{ value_inc_vat: 45, valid_from: "2099-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    throw new Error("Unhandled: " + url);
  };
  document.getElementById("input-apikey").value = "sk_test_fakekey123"; validateInputs();
  state.accountNumber = "A-X"; state.mpan = "1234567890123"; state.serial = "S1"; state.serials = ["S1"]; state.isExport = false;
  state.accountData = { number: "A-X", properties: [{ postcode: "AB1 2CD", electricity_meter_points: [{ mpan: "1234567890123", gsp: "_C", is_export: false, meters: [{ serial_number: "S1" }], agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] }] }] };
  document.getElementById("results-content").innerHTML = "";
  await runComparison();
  ok(state.diagnostics.totals.allPeriods.flexUnmatchedStandingDays > 0, "diagnostics totals carry a non-zero standing-charge unmatched count");
  lastBlobContent = null;
  downloadDiagnostics();
  const diag = JSON.parse(lastBlobContent);
  ok(/unmatched standing days/i.test(diag._summary), "the human _summary reports unmatched standing days (not just readings)");
  ok(/sc-days-unmatched=/.test(diag._summary), "each per-period summary line includes its standing-charge unmatched days");
  const scLine = diag._summary.split("\n").find(l => /Flex unmatched standing days/.test(l));
  ok(scLine && parseInt(scLine.split(":")[1].trim()) > 0, "the reported standing-days total is the non-zero value, not silently 0");

  console.log("\n[D] CSP tightened with default-src + frame/child/font/media-src\n");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || "";
  ok(/default-src 'none'/.test(csp), "default-src 'none' denies every resource class not explicitly re-opened");
  ok(/frame-src 'none'/.test(csp) && /child-src 'none'/.test(csp) && /font-src 'none'/.test(csp) && /media-src 'none'/.test(csp), "frame/child/font/media-src are explicitly pinned to none");
  ok(/script-src 'unsafe-inline'/.test(csp) && /style-src 'unsafe-inline'/.test(csp) && /img-src 'self' data:/.test(csp) && /connect-src https:\/\/api\.octopus\.energy/.test(csp), "the inline + Octopus allowances the single-file app needs are still present");

  console.log(`\nAll ${passed} fourth-round review assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
