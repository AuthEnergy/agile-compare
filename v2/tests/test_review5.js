// Fifth-round review fixes:
//  P1 merged rate windows are clipped to each product's availability, so an
//     open-ended (valid_to:null) row from a RETIRED product can't leak past its
//     available_to and hide a genuine missing-version gap.
//  P2 the Statement-charge card / "vs statement" deltas are gated on whether the
//     SUMMARY scope has an actual (not whether any period in the window did), so
//     a current-tariff scope with no billed charge shows n/a, not £0.00.
//  P3 the diagnostics _summary marks a period that straddles a switch as MIXED,
//     even when its midpoint lands on the current tariff (would look clean).

const assert = require("assert");

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
// Augment (do NOT replace) the real WHATWG URL — the app + fetch use new URL().
global.URL.createObjectURL = () => "blob:x";
global.URL.revokeObjectURL = () => {};
function mj(s, b) { return { ok: s >= 200 && s < 300, status: s, json: async () => b, text: async () => JSON.stringify(b) }; }
function ledgerData(l) { return mj(200, { data: { account: { ledgers: l } } }); }

const { state, fetchMergedRateWindows, rateAtSorted, renderResults, runComparison, validateInputs, downloadDiagnostics } = require("./app_module.js");
let passed = 0; function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }
state.apiKey = "sk_test_fakekey123";
const day = 24 * 3600 * 1000;

(async () => {
  console.log("\n[A] Merged windows are clipped to product availability (retired open-ended rate can't leak)\n");
  const T = "2024-06-01T00:00:00Z"; // the retired product's available_to
  // OLD retired at T but its rate row is open-ended (valid_to:null). NEW is the
  // current version but its rate history is MISSING (returns []), so the dates
  // after T have no real rate — that gap MUST stay visible.
  const OLD = { code: "OLD", display_name: "Agile Octopus", is_business: false, is_prepay: false, available_from: "2020-01-01T00:00:00Z", available_to: T };
  const NEW = { code: "NEW", display_name: "Agile Octopus", is_business: false, is_prepay: false, available_from: T, available_to: null };
  global.fetch = async (url) => {
    const u = new URL(url.toString());
    if (u.pathname.match(/\/products\/[^/]+\/$/)) { const pc = u.pathname.split("/")[3]; return mj(200, { code: pc, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: `E-1R-${pc}-C` } } } }); }
    if (u.pathname.includes("/OLD/") && u.pathname.includes("standard-unit-rates")) return mj(200, { results: [{ value_inc_vat: 10, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: null }] });
    if (u.pathname.includes("/NEW/") && u.pathname.includes("standard-unit-rates")) return mj(200, { results: [] });
    return mj(200, { results: [] });
  };
  const merged = await fetchMergedRateWindows([OLD, NEW], "C", "standard-unit-rates", new Date("2023-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));
  ok(merged.windows.length === 1 && merged.windows[0].validTo.getTime() === new Date(T).getTime(),
    "the retired product's open-ended window is clipped to its available_to");
  ok(rateAtSorted(merged.windows, new Date("2024-01-15T12:00:00Z")) === 10,
    "within the retired product's availability, its rate (10p) still applies");
  ok(rateAtSorted(merged.windows, new Date("2024-09-15T12:00:00Z")) === null,
    "after available_to the stale open-ended rate is gone -> the missing-version gap stays visible (would have leaked 10p unclipped)");

  console.log("\n[B] Statement-charge card shows n/a when the summary scope has no actual (not £0.00)\n");
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
  // Pre-switch period (on OLD) carries the only statement charge; the current
  // -tariff period has none. The summary narrows to the current-tariff scope.
  const pPre = mkR("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", 5000);
  const pCur = mkR("2025-04-01T00:00:00Z", "2025-05-01T00:00:00Z", null);
  document.getElementById("results-content").innerHTML = "";
  renderResults({
    results: [pPre, pCur],
    gapInfo: { gaps: [], duplicates: [], earliest: new Date("2025-01-01T00:00:00Z"), latest: new Date("2025-05-01T00:00:00Z") },
    regionLetter: "A", currentAgreement: agreements[1], agreements,
    periodFrom: new Date("2025-01-01T00:00:00Z"), periodTo: new Date("2025-05-01T00:00:00Z"),
    agileAvailable: true, postcodeArea: "AB", statementValidation: [],
    missingEstimate: { totalKwh: 0, slots: 0, perGap: [] }, statementsIncomplete: false,
  });
  const bContent = document.getElementById("results-content").innerHTML;
  ok(/2 of 2|1 of 2/.test(bContent) || /Current tariff, complete data/.test(bContent), "summary narrowed to the current-tariff scope");
  ok(/Statement charge<\/div>\s*<div class="value">n\/a</.test(bContent),
    "the current-tariff Statement-charge card reads n/a (scope has no actual)");
  ok(!/Statement charge<\/div>\s*<div class="value">£0\.00</.test(bContent),
    "it does NOT show a misleading £0.00 for the current-tariff scope");
  ok(bContent.includes("£50.00"),
    "the pre-switch period's real £50.00 charge still appears in the all-periods total (the n/a is scope-specific, not global)");

  console.log("\n[C] Diagnostics summary marks a switch-straddling period as MIXED (even with a current midpoint)\n");
  const FLEX = "VAR-22-11-01", AGILE = "AGILE-24-10-01", step = 30 * 60 * 1000;
  const winEnd = new Date(); winEnd.setUTCDate(winEnd.getUTCDate() - 10); winEnd.setUTCHours(0, 0, 0, 0);
  const winStart = new Date(winEnd); winStart.setUTCDate(winStart.getUTCDate() - 30);
  const switchAt = new Date(winStart.getTime() + 10 * day); // inside the period; midpoint (winStart+15d) lands AFTER it -> current
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
    if (u.pathname.includes("standing-charges")) return mj(200, { results: [{ value_inc_vat: 45, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    throw new Error("Unhandled: " + url);
  };
  document.getElementById("input-apikey").value = "sk_test_fakekey123"; validateInputs();
  state.accountNumber = "A-X"; state.mpan = "1234567890123"; state.serial = "S1"; state.serials = ["S1"]; state.isExport = false;
  state.accountData = { number: "A-X", properties: [{ postcode: "AB1 2CD", electricity_meter_points: [{ mpan: "1234567890123", gsp: "_C", is_export: false, meters: [{ serial_number: "S1" }],
    agreements: [
      { tariff_code: "E-1R-VAR-OLD-C", valid_from: new Date(winStart.getTime() - 60 * day).toISOString(), valid_to: switchAt.toISOString() },
      { tariff_code: "E-1R-VAR-22-11-01-C", valid_from: switchAt.toISOString(), valid_to: null },
    ] }] }] };
  document.getElementById("results-content").innerHTML = "";
  await runComparison();
  ok(state.diagnostics.billingPeriods.some(p => p.mixedTariff && !p.preSwitch),
    "the straddling period is mixed while its midpoint is the current tariff (preSwitch=false) — the deceptive case");
  lastBlobContent = null;
  downloadDiagnostics();
  const diag = JSON.parse(lastBlobContent);
  ok(/MIXED tariff/i.test(diag._summary),
    "the human _summary tags it [MIXED tariff …] instead of showing the current code as if clean");

  console.log(`\nAll ${passed} fifth-round review assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
