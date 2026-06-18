// Third-round review fixes:
//  P1 unmatched standing-charge days -> confidence/warnings/diagnostics/replay
//  P3 pre-sort once (preSorted flag correctness)
//  P3 product boundary probes (short-lived version discovery)
//  P2 replay size/schema caps
//  P2 email caveats when headline untrusted

const assert = require("assert");
const elements = {}; let lastCreated = null, alertMsg = null;
function mk(id) {
  return { id, value: "", innerHTML: "", textContent: "", scrollTop: 0, scrollHeight: 0, _children: [], firstChild: null,
    classList: { _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])), add(c){this._set.add(c)}, remove(c){this._set.delete(c)}, contains(c){return this._set.has(c)} },
    style: {}, appendChild(c){this._children.push(c);this.firstChild=this._children[0]}, insertBefore(n){this._children.unshift(n);this.firstChild=this._children[0]}, removeChild(){}, addEventListener(){}, querySelectorAll(){return[]}, click(){} };
}
global.document = { getElementById(id){if(!elements[id])elements[id]=mk(id);return elements[id]}, createElement(){lastCreated=mk(null);return lastCreated}, querySelectorAll(){return Object.values(elements).filter(e=>e.classList.contains("screen"))}, body: mk("body") };
global.btoa = s => Buffer.from(s, "binary").toString("base64");
global.alert = m => { alertMsg = m; };
function mj(s, b) { return { ok: s >= 200 && s < 300, status: s, json: async () => b, text: async () => JSON.stringify(b) }; }
function ledgerData(l) { return mj(200, { data: { account: { ledgers: l } } }); }

const { state, calculateCost, findProductsByDisplayNameOverlapping, runComparison, validateInputs, processDiagnosticFile } = require("./app_module.js");
let passed = 0; function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }
state.apiKey = "sk_test_fakekey123";
const day = 24 * 3600 * 1000;

(async () => {
  console.log("\n[A] Standing-charge coverage + preSorted\n");
  const readings = [{ start: new Date("2025-06-01T12:00:00Z"), kwh: 1 }, { start: new Date("2025-06-02T12:00:00Z"), kwh: 1 }];
  const pStart = new Date("2025-06-01T00:00:00Z"), pEnd = new Date("2025-06-03T00:00:00Z");
  const unit = [{ validFrom: new Date("2020-01-01T00:00:00Z"), validTo: null, value: 25 }];
  const standOk = [{ validFrom: new Date("2020-01-01T00:00:00Z"), validTo: null, value: 45 }];
  const standMissing = [{ validFrom: new Date("2099-01-01T00:00:00Z"), validTo: null, value: 45 }];
  const rOk = calculateCost(readings, pStart, pEnd, unit, standOk);
  const rMiss = calculateCost(readings, pStart, pEnd, unit, standMissing);
  ok(rOk.unmatchedStandingDays === 0, "covering standing window -> 0 unmatched standing days");
  ok(rMiss.unmatchedStandingDays === 2, "missing standing window -> each uncovered day counted (2)");
  ok(rMiss.standingChargePence === 0, "missing standing window contributes no standing charge (would silently understate)");
  const rPre = calculateCost(readings, pStart, pEnd, unit, standOk, true);
  ok(rPre.totalPence === rOk.totalPence && rPre.unmatchedStandingDays === 0, "preSorted=true yields an identical result");

  console.log("\n[B] Product boundary probes find a short-lived version\n");
  const T = Date.UTC(2024, 0, 1);
  const OLD = { code: "AGILE-OLD", display_name: "Agile Octopus", is_business: false, is_prepay: false, available_from: new Date(T - 100 * day).toISOString(), available_to: new Date(T + 50 * day).toISOString() };
  const MID = { code: "AGILE-MID", display_name: "Agile Octopus", is_business: false, is_prepay: false, available_from: new Date(T + 50 * day).toISOString(), available_to: new Date(T + 60 * day).toISOString() };
  const NEW = { code: "AGILE-NEW", display_name: "Agile Octopus", is_business: false, is_prepay: false, available_from: new Date(T + 60 * day).toISOString(), available_to: null };
  global.fetch = async (url) => {
    const u = new URL(url.toString());
    if (u.pathname !== "/v1/products/") return mj(200, { results: [] });
    const at = u.searchParams.get("available_at");
    const atMs = at ? new Date(at).getTime() : null;          // null = current
    let prod; if (atMs == null || atMs >= T + 60 * day) prod = NEW; else if (atMs >= T + 50 * day) prod = MID; else prod = OLD;
    return mj(200, { count: 1, next: null, results: [prod] });
  };
  // 45-day pass-1 sampling over [T, T+100d] never lands inside MID's 10-day
  // window; only the boundary probe (a day either side of NEW's start) finds it.
  const found = await findProductsByDisplayNameOverlapping("Agile Octopus", new Date(T), new Date(T + 100 * day));
  ok(found.some(p => p.code === "AGILE-MID"), "short-lived version (between samples) discovered via boundary probe");
  ok(found.some(p => p.code === "AGILE-NEW") && found.some(p => p.code === "AGILE-OLD"), "regular versions still discovered");

  // ---- shared e2e mock for C/D ----
  const step = 30 * 60 * 1000, FLEX = "VAR-22-11-01", AGILE = "AGILE-24-10-01";
  const winEnd = new Date(); winEnd.setUTCDate(winEnd.getUTCDate() - 10); winEnd.setUTCHours(0, 0, 0, 0);
  const winStart = new Date(winEnd); winStart.setUTCDate(winStart.getUTCDate() - 30);
  function makeFetch(cfg) {
    return async (url, opts = {}) => {
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
      if (u.pathname.includes("standing-charges")) { const vf = cfg.standingFuture ? "2099-01-01T00:00:00Z" : "2020-01-01T00:00:00Z"; return mj(200, { results: [{ value_inc_vat: 45, valid_from: vf, valid_to: null, payment_method: "DIRECT_DEBIT" }] }); }
      throw new Error("Unhandled: " + url);
    };
  }
  function setup() {
    document.getElementById("input-apikey").value = "sk_test_fakekey123"; validateInputs();
    state.accountNumber = "A-X"; state.mpan = "1234567890123"; state.serial = "S1"; state.serials = ["S1"]; state.isExport = false;
    state.accountData = { number: "A-X", properties: [{ postcode: "AB1 2CD", electricity_meter_points: [{ mpan: "1234567890123", gsp: "_C", is_export: false, meters: [{ serial_number: "S1" }], agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] }] }] };
    document.getElementById("results-content").innerHTML = "";
  }

  console.log("\n[C] Missing standing charges -> not confident -> headline suppressed + caveats\n");
  global.fetch = makeFetch({ standingFuture: true });
  setup();
  await runComparison();
  let content = document.getElementById("results-content").innerHTML;
  ok(/no matching Flexible standing charge|no matching Agile standing charge/i.test(content), "rate-coverage warning names the missing standing charge");
  ok(!/would have been .* cheaper/.test(content), "missing standing charge makes the period unconfident -> headline suppressed");
  const mailto = decodeURIComponent((content.match(/href="(mailto:[^"]+)"/) || [])[1] || "");
  ok(/Caveats:/.test(mailto), "emailed summary carries caveats when the headline is untrusted");

  console.log("\n[D] Replay size/schema caps\n");
  // Capture a valid diagnostic from a clean run.
  global.fetch = makeFetch({});
  setup();
  await runComparison();
  const goodDiag = JSON.parse(JSON.stringify(state.diagnostics));
  global.FileReader = function () { this.readAsText = (f) => this.onload({ target: { result: f._content } }); };
  global.fetch = async () => { throw new Error("no api during replay"); };

  alertMsg = null; document.getElementById("results-content").innerHTML = "PENDING";
  processDiagnosticFile({ _content: JSON.stringify(goodDiag) });
  ok(alertMsg === null && document.getElementById("results-content").innerHTML !== "PENDING", "a valid diagnostic replays without an alert");

  alertMsg = null;
  const oversized = JSON.parse(JSON.stringify(goodDiag)); oversized.billingPeriods = new Array(5001).fill(goodDiag.billingPeriods[0]);
  processDiagnosticFile({ _content: JSON.stringify(oversized) });
  ok(alertMsg && /unexpectedly large/i.test(alertMsg), "an oversized diagnostic (too many periods) is rejected, not rendered");

  alertMsg = null;
  const noWindow = JSON.parse(JSON.stringify(goodDiag)); delete noWindow.comparisonWindow;
  processDiagnosticFile({ _content: JSON.stringify(noWindow) });
  ok(alertMsg && /comparison window/i.test(alertMsg), "a diagnostic missing the comparison window is rejected");

  console.log(`\nAll ${passed} third-round review assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
