// Second-round review fixes:
//  P1/P2 multi-serial fetch: skip 404s, FAIL (not silently undercount) on other errors
//  P1/P2 incomplete statement history suppresses headline + share
//  P2 export verdict caveated when rates unmatched or data has gaps
//  P2/P3 CSP tightened (script-src + img-src), not just connect-src

const assert = require("assert");
const fs = require("fs");

const elements = {};
function makeElement(id) {
  return { id, value: "", innerHTML: "", textContent: "", scrollTop: 0, scrollHeight: 0,
    classList: { _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
    style: {}, appendChild() {}, removeChild() {}, addEventListener() {}, querySelectorAll() { return []; }, click() {} };
}
global.document = { getElementById(id) { if (!elements[id]) elements[id] = makeElement(id); return elements[id]; },
  createElement() { return makeElement(null); }, querySelectorAll() { return Object.values(elements).filter(e => e.classList.contains("screen")); }, body: makeElement("body") };
global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
function mockJsonResponse(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }
function errResponse(status) { return { ok: false, status, json: async () => ({}), text: async () => "err " + status }; }
function ledgerData(ledgers) { return mockJsonResponse(200, { data: { account: { ledgers } } }); }

const { state, fetchConsumptionMerged, renderExportResults, runComparison, validateInputs } = require("./app_module.js");
let passed = 0; function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }
state.apiKey = "sk_test_fakekey123";

(async () => {
  const from = new Date("2025-06-01T00:00:00Z"), to = new Date("2025-06-02T00:00:00Z");

  console.log("\n[A] Multi-serial fetch error handling\n");
  global.fetch = async (url) => {
    const serial = new URL(url.toString()).pathname.split("/")[5];
    if (serial === "GOOD") return mockJsonResponse(200, { count: 1, next: null, results: [{ interval_start: "2025-06-01T00:00:00Z", interval_end: "2025-06-01T00:30:00Z", consumption: 0.5 }] });
    if (serial === "BAD404") return errResponse(404);
    if (serial === "BAD500") return errResponse(500);
    return mockJsonResponse(200, { count: 0, next: null, results: [] });
  };
  const r1 = await fetchConsumptionMerged("1234567890123", ["BAD404", "GOOD"], from, to);
  ok(r1.length === 1 && Math.abs(r1[0].kwh - 0.5) < 1e-9, "404 serial skipped (no active data), good serial's readings kept");
  let threw = false;
  try { await fetchConsumptionMerged("1234567890123", ["GOOD", "BAD500"], from, to); } catch (e) { threw = true; }
  ok(threw, "a non-404 serial error FAILS the run rather than silently undercounting");

  console.log("\n[B] Incomplete statement history suppresses headline + share\n");
  const step = 30 * 60 * 1000, REGION = "C", FLEX = "VAR-22-11-01", AGILE = "AGILE-24-10-01";
  const winEnd = new Date(); winEnd.setUTCDate(winEnd.getUTCDate() - 10); winEnd.setUTCHours(0, 0, 0, 0);
  const winStart = new Date(winEnd); winStart.setUTCDate(winStart.getUTCDate() - 30);
  const stmtNode = id => ({ id, startAt: winStart.toISOString(), endAt: winEnd.toISOString(), totalCharges: { grossTotal: 12000 }, transactions: { totalCount: 1, pageInfo: { hasNextPage: false }, edges: [{ node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 12000 }, consumption: { quantity: 432 } } }] } });
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url.toString());
    if (u.pathname.includes("/graphql/")) {
      const body = JSON.parse(opts.body);
      if (body.query.includes("obtainKrakenToken")) return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "t" } } });
      if (body.query.includes("Statements")) return ledgerData([   // TWO ledgers, both paginating -> incomplete
        { statements: { pageInfo: { hasNextPage: true, endCursor: "A1" }, edges: [{ node: stmtNode(1) }] } },
        { statements: { pageInfo: { hasNextPage: true, endCursor: "B1" }, edges: [{ node: stmtNode(2) }] } },
      ]);
      throw new Error("gql");
    }
    if (u.pathname.includes("/consumption/")) { const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to")); const r = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime() + step); r.push({ consumption: 0.3, interval_start: t.toISOString(), interval_end: e.toISOString() }); t = e; } return mockJsonResponse(200, { count: r.length, next: null, results: r }); }
    if (u.pathname === "/v1/products/") return mockJsonResponse(200, { count: 2, next: null, results: [{ code: FLEX, display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_to: null }, { code: AGILE, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_to: null }] });
    if (u.pathname.match(/\/products\/[^/]+\/$/)) { const pc = u.pathname.split("/")[3]; return mockJsonResponse(200, { code: pc, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: pc === FLEX ? "E-1R-VAR-22-11-01-C" : "E-1R-AGILE-24-10-01-C" } } } }); }
    if (u.pathname.includes(FLEX) && u.pathname.includes("standard-unit-rates")) return mockJsonResponse(200, { results: [{ value_inc_vat: 25, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    if (u.pathname.includes(FLEX) && u.pathname.includes("standing-charges")) return mockJsonResponse(200, { results: [{ value_inc_vat: 45, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    if (u.pathname.includes(AGILE) && u.pathname.includes("standard-unit-rates")) { const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to")); const r = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime() + step); r.push({ value_inc_vat: 18, valid_from: t.toISOString(), valid_to: e.toISOString(), payment_method: null }); t = e; } return mockJsonResponse(200, { results: r }); }
    if (u.pathname.includes(AGILE) && u.pathname.includes("standing-charges")) return mockJsonResponse(200, { results: [{ value_inc_vat: 50, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    throw new Error("Unhandled: " + url);
  };
  document.getElementById("input-apikey").value = "sk_test_fakekey123"; validateInputs();
  state.accountNumber = "A-X"; state.mpan = "1234567890123"; state.serial = "S1"; state.serials = ["S1"]; state.isExport = false;
  state.accountData = { number: "A-X", properties: [{ postcode: "AB1 2CD", electricity_meter_points: [{ mpan: "1234567890123", gsp: "_C", is_export: false, meters: [{ serial_number: "S1" }], agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] }] }] };
  document.getElementById("results-content").innerHTML = "";
  await runComparison();
  const content = document.getElementById("results-content").innerHTML;
  ok(/statement history may be incomplete/i.test(content), "incomplete-statement banner shown");
  ok(!/would have been .* cheaper/.test(content), "headline verdict suppressed when statement history may be incomplete");
  ok(!content.includes("share-panel"), "share panel suppressed when statement history may be incomplete");

  console.log("\n[C] Export verdict caveated on unmatched/gaps\n");
  const pf = new Date("2025-06-01T00:00:00Z"), pt = new Date("2025-06-10T00:00:00Z");
  document.getElementById("results-content").innerHTML = "";
  renderExportResults({ regionLetter: "G", periodFrom: pf, periodTo: pt, exportKwh: 100, flat: { valuePence: 1200, unmatchedReadings: 5 }, agile: { valuePence: 1600, unmatchedReadings: 0 }, gapInfo: { gaps: [] } });
  let c = document.getElementById("results-content").innerHTML;
  ok(/approximate/i.test(c) && !/would have paid you .* more/.test(c), "unmatched export rates -> verdict caveated as approximate, no firm 'paid you more' claim");

  document.getElementById("results-content").innerHTML = "";
  renderExportResults({ regionLetter: "G", periodFrom: pf, periodTo: pt, exportKwh: 100, flat: { valuePence: 1200, unmatchedReadings: 0 }, agile: { valuePence: 1600, unmatchedReadings: 0 }, gapInfo: { gaps: [{ start: pf, end: new Date(pf.getTime() + 1800000) }] } });
  c = document.getElementById("results-content").innerHTML;
  ok(/approximate/i.test(c), "export data gap -> verdict caveated as approximate");

  document.getElementById("results-content").innerHTML = "";
  renderExportResults({ regionLetter: "G", periodFrom: pf, periodTo: pt, exportKwh: 100, flat: { valuePence: 1200, unmatchedReadings: 0 }, agile: { valuePence: 1600, unmatchedReadings: 0 }, gapInfo: { gaps: [] } });
  c = document.getElementById("results-content").innerHTML;
  ok(/would have paid you .* more/.test(c) && !/approximate/i.test(c), "clean export data -> firm 'paid you more' verdict");

  console.log("\n[D] CSP tightened\n");
  const html = fs.readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8");
  const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || "";
  ok(/script-src 'unsafe-inline'/.test(csp), "CSP restricts script-src (blocks external script loading)");
  ok(/img-src 'self' data:/.test(csp), "CSP restricts img-src (blocks image-beacon exfiltration)");
  ok(/connect-src https:\/\/api\.octopus\.energy/.test(csp), "CSP still restricts connect-src to Octopus");

  console.log(`\nAll ${passed} second-round review assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
