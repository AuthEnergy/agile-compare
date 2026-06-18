// v2 tests for the beta-review hardening:
//  P1 per-ledger statement pagination safety
//  P1 incomplete-transaction guard
//  P1 no-confident-periods -> no headline
//  P1/P2 split-period actuals excluded from vs-statement claims
//  P2 multi-serial consumption merge
//  P2/P3 binary-search rate lookup performance
//  P2 diagnostics statementValidation; export diag has no raw timestamps; CSP present

const assert = require("assert");
const fs = require("fs");

/* ---------------------------------------------------------------- DOM mock */
const elements = {};
function makeElement(id) {
  return {
    id, value: "", innerHTML: "", textContent: "", href: "", download: "", scrollTop: 0, scrollHeight: 0,
    classList: {
      _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); },
    },
    style: {}, appendChild(c) { (this._children = this._children || []).push(c); }, removeChild() {},
    addEventListener() {}, querySelectorAll() { return []; }, click() {},
  };
}
global.document = {
  getElementById(id) { if (!elements[id]) elements[id] = makeElement(id); return elements[id]; },
  createElement() { return makeElement(null); },
  querySelectorAll() { return Object.values(elements).filter(e => e.classList.contains("screen")); },
  body: makeElement("body"),
};
global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
function mockJsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const {
  state, fetchStatements, fetchConsumptionMerged, calculateCost, rateAtSorted,
  runComparison, validateInputs,
} = require("./app_module.js");

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("PASS:", msg); passed++; }
state.apiKey = "sk_test_fakekey123";

const node = (id, charges) => ({ id, startAt: "2025-01-01T00:00:00Z", endAt: "2025-01-31T00:00:00Z", totalCharges: { grossTotal: charges || 1000 } });
function ledgerData(ledgers) { return mockJsonResponse(200, { data: { account: { ledgers } } }); }

(async () => {
  /* ===================== A — statement pagination safety ===================== */
  console.log("\n[A] Statement pagination (per-ledger safety)\n");

  // A1: two ledgers BOTH want another page -> can't page safely -> incomplete, no continuation.
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes("obtainKrakenToken")) return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "t" } } });
    return ledgerData([
      { statements: { pageInfo: { hasNextPage: true, endCursor: "A1" }, edges: [{ node: node(1) }] } },
      { statements: { pageInfo: { hasNextPage: true, endCursor: "B1" }, edges: [{ node: node(2) }] } },
    ]);
  };
  let r = await fetchStatements("t", "A-X");
  ok(r.incomplete === true, "two ledgers both paginating -> flagged incomplete");
  ok(r.statements.length === 2 && new Set(r.statements.map(s => s.id)).size === 2, "first page collected once, no duplication, no skip");

  // A2: two ledgers with statements, only one paginating -> still unsafe (shared cursor) -> incomplete.
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes("obtainKrakenToken")) return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "t" } } });
    return ledgerData([
      { statements: { pageInfo: { hasNextPage: true, endCursor: "A1" }, edges: [{ node: node(1) }] } },
      { statements: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: node(2) }] } },
    ]);
  };
  r = await fetchStatements("t", "A-X");
  ok(r.incomplete === true, "two statement-bearing ledgers (one paginating) -> incomplete (won't reuse one cursor across them)");

  // A3: single ledger paginating -> safe to continue, complete.
  let call = 0;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes("obtainKrakenToken")) return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "t" } } });
    call++;
    if (body.variables.after == null) return ledgerData([{ statements: { pageInfo: { hasNextPage: true, endCursor: "P2" }, edges: [{ node: node(1) }] } }]);
    return ledgerData([{ statements: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: node(2) }] } }]);
  };
  r = await fetchStatements("t", "A-X");
  ok(r.incomplete === false && r.statements.length === 2, "single ledger paginates safely to completion (both pages, not incomplete)");

  /* ===================== B — multi-serial consumption merge ===================== */
  console.log("\n[B] Multi-serial consumption merge\n");
  const day = (d, h) => `2025-06-0${d}T0${h}:00:00Z`;
  global.fetch = async (url) => {
    const u = new URL(url.toString());
    const serial = u.pathname.split("/")[5];
    if (serial === "OLD") return mockJsonResponse(200, { results: [{ interval_start: day(1, 0), interval_end: day(1, 1), consumption: 0.4 }] });
    if (serial === "NEW") return mockJsonResponse(200, { results: [{ interval_start: day(2, 0), interval_end: day(2, 1), consumption: 0.6 }] });
    return mockJsonResponse(200, { results: [] });
  };
  const merged = await fetchConsumptionMerged("1234567890123", ["EMPTY", "OLD", "NEW"], new Date("2025-06-01T00:00:00Z"), new Date("2025-06-03T00:00:00Z"));
  ok(merged.length === 2, "readings merged across serials (old + new meter after an exchange)");
  ok(Math.abs(merged.reduce((s, x) => s + x.kwh, 0) - 1.0) < 1e-9, "merged kWh = 0.4 + 0.6 (both serials' readings kept)");
  ok(merged[0].start < merged[1].start, "merged readings sorted by interval");

  /* ===================== C — rate lookup performance ===================== */
  console.log("\n[C] Rate lookup performance (binary search)\n");
  const YEAR = 365 * 48; // half-hours in a year
  const t0 = new Date("2024-01-01T00:00:00Z").getTime(), step = 30 * 60 * 1000;
  const readings = [], windows = [];
  for (let i = 0; i < YEAR; i++) {
    readings.push({ start: new Date(t0 + i * step), kwh: 0.25 });
    windows.push({ validFrom: new Date(t0 + i * step), validTo: new Date(t0 + (i + 1) * step), value: 10 + (i % 30) });
  }
  const standing = [{ validFrom: new Date("2020-01-01T00:00:00Z"), validTo: null, value: 45 }];
  const started = process.hrtime.bigint();
  const res = calculateCost(readings, new Date(t0), new Date(t0 + YEAR * step), windows, standing);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  ok(res.unmatchedReadings === 0, "a year of half-hourly Agile windows fully matched");
  ok(ms < 1500, `calculateCost over a full year ran in ${ms.toFixed(0)}ms (binary search keeps it well under threshold)`);
  ok(rateAtSorted(windows, new Date(t0 + 100 * step)) === 10 + (100 % 30), "rateAtSorted returns the correct window value");

  /* ===================== D/E/F/G — end-to-end gating ===================== */
  const REGION = "C", FLEX = "VAR-22-11-01", AGILE = "AGILE-24-10-01";
  const winEnd = new Date(); winEnd.setUTCDate(winEnd.getUTCDate() - 10); winEnd.setUTCHours(0, 0, 0, 0);
  const winStart = new Date(winEnd); winStart.setUTCDate(winStart.getUTCDate() - 30);
  function buildConsumption(pf, pt) { const r = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime() + step); r.push({ consumption: 0.3, interval_start: t.toISOString(), interval_end: e.toISOString() }); t = e; } return r; }

  function makeFetch(cfg) {
    return async (url, opts = {}) => {
      const u = new URL(url.toString());
      if (u.pathname.includes("/graphql/")) {
        const body = JSON.parse(opts.body);
        if (body.query.includes("obtainKrakenToken")) return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "t" } } });
        if (body.query.includes("Statements")) return ledgerData([{ statements: { pageInfo: { hasNextPage: false, endCursor: null }, edges: (cfg.statementNodes || []).map(n => ({ node: n })) } }]);
        throw new Error("gql");
      }
      if (u.pathname.includes("/consumption/")) { const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to")); const results = buildConsumption(pf, pt); return mockJsonResponse(200, { count: results.length, next: null, results }); }
      if (u.pathname === "/v1/products/") return mockJsonResponse(200, { count: 2, next: null, results: [
        { code: FLEX, display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_to: null },
        { code: AGILE, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_to: null },
      ] });
      if (u.pathname.match(/\/products\/[^/]+\/$/)) { const pc = u.pathname.split("/")[3]; return mockJsonResponse(200, { code: pc, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: pc === FLEX ? "E-1R-VAR-22-11-01-C" : "E-1R-AGILE-24-10-01-C" } } } }); }
      if (u.pathname.includes(FLEX) && u.pathname.includes("standard-unit-rates")) { const vf = cfg.flexFuture ? "2099-01-01T00:00:00Z" : "2020-01-01T00:00:00Z"; return mockJsonResponse(200, { results: [{ value_inc_vat: 25, valid_from: vf, valid_to: null, payment_method: "DIRECT_DEBIT" }] }); }
      if (u.pathname.includes(FLEX) && u.pathname.includes("standing-charges")) return mockJsonResponse(200, { results: [{ value_inc_vat: 45, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
      if (u.pathname.includes(AGILE) && u.pathname.includes("standard-unit-rates")) { const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to")); const r2 = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime() + step); r2.push({ value_inc_vat: 18, valid_from: t.toISOString(), valid_to: e.toISOString(), payment_method: null }); t = e; } return mockJsonResponse(200, { results: r2 }); }
      if (u.pathname.includes(AGILE) && u.pathname.includes("standing-charges")) return mockJsonResponse(200, { results: [{ value_inc_vat: 50, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
      throw new Error("Unhandled: " + url);
    };
  }
  function setup(agreements) {
    document.getElementById("input-apikey").value = "sk_test_fakekey123"; validateInputs();
    state.accountNumber = "A-X"; state.mpan = "1234567890123"; state.serial = "S1"; state.serials = ["S1"]; state.isExport = false;
    state.accountData = { number: "A-X", properties: [{ postcode: "AB1 2CD", electricity_meter_points: [{ mpan: "1234567890123", gsp: "_C", is_export: false, meters: [{ serial_number: "S1" }], agreements }] }] };
    document.getElementById("results-content").innerHTML = "";
  }
  const elecTxn = (kwh, gross) => ({ transactions: { totalCount: 1, pageInfo: { hasNextPage: false }, edges: [{ node: { __typename: "BillCharge", title: "Electricity", amounts: { gross }, consumption: { quantity: kwh } } }] } });

  console.log("\n[D] No confident periods -> no headline\n");
  // Flexible rates exist but don't cover the readings -> every reading
  // unmatched -> period not confident (no hard error).
  global.fetch = makeFetch({ flexFuture: true, statementNodes: [{ id: 1, startAt: winStart.toISOString(), endAt: winEnd.toISOString(), totalCharges: { grossTotal: 12000 }, ...elecTxn(432, 12000) }] });
  setup([{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }]);
  await runComparison();
  let content = document.getElementById("results-content").innerHTML;
  ok(!content.includes("error-banner"), "no-confident run still renders");
  ok(/enough complete data/i.test(content), "shows a 'not enough complete data' message");
  ok(!/would have been .* cheaper/.test(content), "suppresses the cheaper verdict");
  ok(!content.includes("share-panel"), "suppresses the share panel when no confident data");

  console.log("\n[E] Incomplete transactions -> actual not presented as complete\n");
  global.fetch = makeFetch({ statementNodes: [{ id: 1, startAt: winStart.toISOString(), endAt: winEnd.toISOString(), totalCharges: { grossTotal: 12000 }, transactions: { totalCount: 200, pageInfo: { hasNextPage: true }, edges: [{ node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 6000 }, consumption: { quantity: 200 } } }] } }] });
  setup([{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }]);
  await runComparison();
  content = document.getElementById("results-content").innerHTML;
  ok(/transactions were truncated/i.test(content), "truncated-transactions warning shown");
  ok(/Statement charge<\/div>\s*<div class="value">n\/a</.test(content), "partial statement charge NOT presented — shown as n/a");
  ok(!content.includes("share-panel") || !/below|above my actual/.test(content), "no 'vs actual' share claim on incomplete transactions");

  console.log("\n[F] Long statement split -> vs-statement demoted\n");
  const longStart = new Date(winEnd); longStart.setUTCDate(longStart.getUTCDate() - 90);
  global.fetch = makeFetch({ statementNodes: [{ id: 1, startAt: longStart.toISOString(), endAt: winEnd.toISOString(), totalCharges: { grossTotal: 40000 }, ...elecTxn(90 * 48 * 0.3, 40000) }] });
  setup([{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }]);
  await runComparison();
  content = document.getElementById("results-content").innerHTML;
  ok(content.includes("estimated split"), "long statement shows estimated-split rows");
  ok(content.includes("not directly comparable") || content.includes("display estimates"), "vs-statement comparison demoted/caveated for apportioned split actuals");

  console.log("\n[G] Diagnostics + CSP\n");
  ok(state.diagnostics && Array.isArray(state.diagnostics.statementValidation) && state.diagnostics.statementValidation.length > 0,
    "diagnostics include a statementValidation section");
  ok(state.diagnostics.statementValidation[0].observedKwh !== undefined && state.diagnostics.statementValidation[0].mismatch !== undefined,
    "statementValidation carries observed kWh + mismatch flag");
  const html = fs.readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8");
  ok(/Content-Security-Policy/.test(html) && /connect-src https:\/\/api\.octopus\.energy/.test(html),
    "a CSP restricting connect-src to api.octopus.energy is present");
  ok(!/octopus-export-diag[\s\S]*raw:/.test(html), "export diagnostics do not include a raw per-slot timestamp array");

  console.log(`\nAll ${passed} review-fix assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
