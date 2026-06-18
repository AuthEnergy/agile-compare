// Diagnostic-file replay round-trip: run a live (mocked) comparison, capture
// state.diagnostics exactly as the download would, then replay it through
// processDiagnosticFile and assert it re-renders with NO API calls.

const assert = require("assert");

const elements = {};
let lastCreated = null;
function makeElement(id) {
  const el = {
    id, value: "", innerHTML: "", textContent: "", href: "", download: "", scrollTop: 0, scrollHeight: 0,
    _children: [], firstChild: null,
    classList: {
      _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); },
    },
    style: {},
    appendChild(c) { this._children.push(c); this.firstChild = this._children[0]; },
    insertBefore(node) { this._children.unshift(node); this.firstChild = this._children[0]; },
    removeChild() {}, addEventListener() {}, querySelectorAll() { return []; }, click() {},
  };
  return el;
}
global.document = {
  getElementById(id) { if (!elements[id]) elements[id] = makeElement(id); return elements[id]; },
  createElement() { lastCreated = makeElement(null); return lastCreated; },
  querySelectorAll() { return Object.values(elements).filter(e => e.classList.contains("screen")); },
  body: makeElement("body"),
};
global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
let alertMsg = null;
global.alert = (m) => { alertMsg = m; };
function mockJsonResponse(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }
function ledgerData(ledgers) { return mockJsonResponse(200, { data: { account: { ledgers } } }); }

const { state, runComparison, validateInputs, processDiagnosticFile } = require("./app_module.js");
let passed = 0;
function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }

const REGION = "C", FLEX = "VAR-22-11-01", AGILE = "AGILE-24-10-01";
const step = 30 * 60 * 1000;
const winEnd = new Date(); winEnd.setUTCDate(winEnd.getUTCDate() - 10); winEnd.setUTCHours(0, 0, 0, 0);
const winStart = new Date(winEnd); winStart.setUTCDate(winStart.getUTCDate() - 30);
function buildConsumption(pf, pt) { const r = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime() + step); r.push({ consumption: 0.3, interval_start: t.toISOString(), interval_end: e.toISOString() }); t = e; } return r; }

function liveFetch(url, opts = {}) {
  const u = new URL(url.toString());
  if (u.pathname.includes("/graphql/")) {
    const body = JSON.parse(opts.body);
    if (body.query.includes("obtainKrakenToken")) return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "t" } } });
    if (body.query.includes("Statements")) return ledgerData([{ statements: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: 1, startAt: winStart.toISOString(), endAt: winEnd.toISOString(), totalCharges: { grossTotal: 12000 }, transactions: { totalCount: 1, pageInfo: { hasNextPage: false }, edges: [{ node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 12000 }, consumption: { quantity: 432 } } }] } } }] } }]);
    throw new Error("gql");
  }
  if (u.pathname.includes("/consumption/")) { const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to")); const results = buildConsumption(pf, pt); return mockJsonResponse(200, { count: results.length, next: null, results }); }
  if (u.pathname === "/v1/products/") return mockJsonResponse(200, { count: 2, next: null, results: [
    { code: FLEX, display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_to: null },
    { code: AGILE, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_to: null },
  ] });
  if (u.pathname.match(/\/products\/[^/]+\/$/)) { const pc = u.pathname.split("/")[3]; return mockJsonResponse(200, { code: pc, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: pc === FLEX ? "E-1R-VAR-22-11-01-C" : "E-1R-AGILE-24-10-01-C" } } } }); }
  if (u.pathname.includes(FLEX) && u.pathname.includes("standard-unit-rates")) return mockJsonResponse(200, { results: [{ value_inc_vat: 25, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  if (u.pathname.includes(FLEX) && u.pathname.includes("standing-charges")) return mockJsonResponse(200, { results: [{ value_inc_vat: 45, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  if (u.pathname.includes(AGILE) && u.pathname.includes("standard-unit-rates")) { const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to")); const r = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime() + step); r.push({ value_inc_vat: 18, valid_from: t.toISOString(), valid_to: e.toISOString(), payment_method: null }); t = e; } return mockJsonResponse(200, { results: r }); }
  if (u.pathname.includes(AGILE) && u.pathname.includes("standing-charges")) return mockJsonResponse(200, { results: [{ value_inc_vat: 50, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  throw new Error("Unhandled: " + url);
}

(async () => {
  console.log("\n[Replay] live run -> capture diagnostics -> replay offline\n");
  global.fetch = async (...a) => liveFetch(...a);
  document.getElementById("input-apikey").value = "sk_test_fakekey123"; validateInputs();
  state.accountNumber = "A-X"; state.mpan = "1234567890123"; state.serial = "S1"; state.serials = ["S1"]; state.isExport = false;
  state.accountData = { number: "A-X", properties: [{ postcode: "AB1 2CD", electricity_meter_points: [{ mpan: "1234567890123", gsp: "_C", is_export: false, meters: [{ serial_number: "S1" }], agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] }] }] };
  document.getElementById("results-content").innerHTML = "";
  await runComparison();

  const liveContent = document.getElementById("results-content").innerHTML;
  ok(!liveContent.includes("error-banner"), "live run rendered");
  ok(state.diagnostics && state.diagnostics.billingPeriods && state.diagnostics.readings.raw, "diagnostics captured with raw readings + billing periods");
  const liveFlex = (liveContent.match(/Flexible \(calculated\)<\/div>\s*<div class="value">£([\d.]+)</) || [])[1];

  // The downloaded file is JSON.stringify({_summary, ...d}); replay reads d's keys directly.
  const fileContent = JSON.stringify({ _summary: "x", ...state.diagnostics });

  // Now make ANY network call a hard failure, to prove replay is offline.
  let apiCalled = false;
  global.fetch = async () => { apiCalled = true; throw new Error("NO API CALL ALLOWED DURING REPLAY"); };

  global.FileReader = function () { this.readAsText = (file) => this.onload({ target: { result: file._content } }); };
  alertMsg = null; lastCreated = null;
  document.getElementById("results-content").innerHTML = "REPLAY_PENDING";
  processDiagnosticFile({ _content: fileContent });

  const replayContent = document.getElementById("results-content").innerHTML;
  ok(alertMsg === null, "replay parsed/validated the file without an alert");
  ok(apiCalled === false, "replay made NO live API calls");
  ok(replayContent !== "REPLAY_PENDING" && replayContent.includes("Flexible") && replayContent.includes("Agile") && replayContent.includes("£"), "replay re-rendered the results");
  const replayFlex = (replayContent.match(/Flexible \(calculated\)<\/div>\s*<div class="value">£([\d.]+)</) || [])[1];
  ok(liveFlex && replayFlex && liveFlex === replayFlex, `replayed Flexible total matches the live render (£${replayFlex})`);
  ok(lastCreated && /Replayed from a diagnostics file/.test(lastCreated.textContent), "a 'replayed from diagnostics' banner was created");

  // Garbage file -> friendly alert, no throw.
  alertMsg = null;
  processDiagnosticFile({ _content: '{"not":"a diagnostic"}' });
  ok(alertMsg && /doesn't look like/i.test(alertMsg), "a non-diagnostic file is rejected with a clear message");

  console.log(`\nAll ${passed} replay assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
