// v2 tests for the ported billed-vs-observed validation, dual-fuel-correct
// statement charge/credit split, tariff classification, missing-data
// estimate, HTML escaping, and a regression test for the diagnostics
// download crash (totals.consistentOnly vs consistentOnlyDiag).

const assert = require("assert");

/* ---------------------------------------------------------------- DOM mock */
const elements = {};
function makeElement(id) {
  return {
    id, value: "", innerHTML: "", textContent: "", href: "", download: "", scrollTop: 0, scrollHeight: 0,
    classList: {
      _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); },
    },
    style: {},
    appendChild(child) { (this._children = this._children || []).push(child); },
    removeChild() {},
    addEventListener() {},
    querySelectorAll() { return []; },
    click() {},
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
  classifyTariffCode, summariseStatementTransactions, billedKwhMismatch,
  estimateMissingKwh, escapeHtml, runComparison, validateInputs, renderError,
  downloadDiagnostics, state,
} = require("./app_module.js");

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("PASS:", msg); passed++; }

/* ===================== SECTION A — classifier ===================== */
(function () {
  console.log("\n[A] Tariff classification\n");
  ok(classifyTariffCode("E-1R-OE-FIX-12M-25-04-05-B").label === "Fixed", "Fixed code -> 'Fixed' (not region 'B')");
  ok(classifyTariffCode("E-1R-OE-FIX-12M-25-04-05-B").label !== "B", "Fixed code never renders as region 'B'");
  ok(classifyTariffCode("E-1R-VAR-22-11-01-B").label === "Flexible", "VAR -> 'Flexible'");
  ok(classifyTariffCode("E-1R-AGILE-24-10-01-B").label === "Agile", "AGILE -> 'Agile'");
  ok(classifyTariffCode("E-1R-GO-VAR-22-10-14-G").label === "Go", "GO-VAR -> 'Go' (not 'Flexible')");
  ok(classifyTariffCode("E-1R-INTELLI-VAR-22-10-14-G").label === "Intelligent Go", "INTELLI-VAR -> 'Intelligent Go'");
  ok(classifyTariffCode("E-1R-OUTGOING-VAR-24-10-26-G").kind === "export", "OUTGOING-VAR -> export");
  ok(classifyTariffCode("E-1R-AGILE-OUTGOING-19-05-13-G").kind === "export", "Agile Outgoing -> export (Outgoing wins)");
  ok(classifyTariffCode("E-1R-OE-COSY-22-12-08-G").label === "Cosy", "COSY -> 'Cosy'");
})();

/* ===================== SECTION B — transactions (dual-fuel) ===================== */
(function () {
  console.log("\n[B] Statement transactions — dual-fuel electricity isolation\n");
  // A real dual-fuel statement: Gas + two Electricity charges (period split) + a referral credit.
  const node = {
    totalCharges: { grossTotal: 21000 }, totalCredits: { grossTotal: 5000 },
    transactions: { totalCount: 4, pageInfo: { hasNextPage: false }, edges: [
      { node: { __typename: "BillCharge", title: "Gas", amounts: { gross: 9000 }, consumption: { quantity: 800, unit: "kWh" } } },
      { node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 7000 }, consumption: { quantity: 350, unit: "kWh" } } },
      { node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 5000 }, consumption: { quantity: 250, unit: "kWh" } } },
      { node: { __typename: "BillCredit", title: "Credit for being referred", reasonCode: "REFERRAL_REWARD", amounts: { gross: 5000 } } },
    ] },
  };
  const s = summariseStatementTransactions(node);
  ok(s.electricityChargePence === 12000, "electricity charge sums the two Electricity charges (£120), EXCLUDING gas");
  ok(Math.abs(s.billedKwh - 600) < 1e-9, "billed kWh sums both Electricity charges (600), excluding gas");
  ok(s.creditsPence === 5000 && s.credits[0].reasonCode === "REFERRAL_REWARD", "referral credit kept separate");
  ok(s.electricityChargePence - s.creditsPence === 7000, "net derives to £70 (electricity charge minus credit)");
  const bare = summariseStatementTransactions({ totalCharges: { grossTotal: 1 } });
  ok(bare.available === false && bare.billedKwh === null, "no transactions -> graceful fallback");
})();

/* ===================== SECTION C/D/E — thresholds, estimate, escaping ===================== */
(function () {
  console.log("\n[C/D/E] Mismatch threshold, missing estimate, escaping\n");
  ok(billedKwhMismatch(600, 432) === true, "168 kWh gap flagged");
  ok(billedKwhMismatch(1000, 1015) === false, "15 kWh gap (<50, <2%) not flagged");
  ok(billedKwhMismatch(null, 5) === false, "missing quantity never mismatches");

  const readings = [];
  const base = new Date("2025-06-01T00:00:00Z").getTime(), step = 30 * 60 * 1000;
  for (let d = 0; d < 3; d++) for (let i = 0; i < 48; i++) readings.push({ start: new Date(base + d*48*step + i*step), kwh: 0.5 });
  const est = estimateMissingKwh(readings, [{ start: new Date(base + 10*48*step), end: new Date(base + 10*48*step + step) }]);
  ok(est.slots === 2 && Math.abs(est.totalKwh - 1.0) < 1e-9, "median-profile estimate = 0.5 x 2 = 1.0 kWh");

  ok(!escapeHtml("<script>alert(1)</script>").includes("<script>"), "escapeHtml neutralises <script>");
  renderError(Object.assign(new Error("boom <b>x</b>"), {}));
  ok(document.getElementById("results-content").innerHTML.includes("boom &lt;b&gt;x&lt;/b&gt;"), "renderError escapes the message");
})();

/* ===================== SECTION F/G — end-to-end through v2 runComparison ===================== */
const REGION = "B", FLEX_PRODUCT = "VAR-22-11-01", AGILE_PRODUCT = "AGILE-24-10-01";
const winEnd = new Date(); winEnd.setUTCDate(winEnd.getUTCDate() - 10); winEnd.setUTCHours(0,0,0,0);
const winStart = new Date(winEnd); winStart.setUTCDate(winStart.getUTCDate() - 30);

function buildConsumption(pf, pt, kwhPerSlot) {
  const r = []; let t = new Date(pf); const step = 30*60*1000;
  while (t < pt) { const e = new Date(t.getTime()+step); r.push({ consumption: kwhPerSlot, interval_start: t.toISOString(), interval_end: e.toISOString() }); t = e; }
  return r;
}

function makeFetch(cfg) {
  return async (url, opts = {}) => {
    const u = new URL(url.toString());
    if (u.pathname.includes("/graphql/")) {
      const body = JSON.parse(opts.body);
      if (body.query.includes("obtainKrakenToken")) return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "t" } } });
      if (body.query.includes("Statements")) return mockJsonResponse(200, { data: { account: { ledgers: [{ statements: {
        pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: cfg.statementNode }],
      } }] } } });
      throw new Error("unhandled gql");
    }
    if (u.pathname.includes("/consumption/")) {
      const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to"));
      const results = buildConsumption(pf, pt, 0.3);
      return mockJsonResponse(200, { count: results.length, next: null, results });
    }
    if (u.pathname === "/v1/products/") return mockJsonResponse(200, { count: 2, next: null, results: [
      { code: FLEX_PRODUCT, display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_to: null },
      { code: AGILE_PRODUCT, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_to: null },
    ] });
    if (u.pathname.match(/\/products\/[^/]+\/$/)) {
      const pc = u.pathname.split("/")[3];
      return mockJsonResponse(200, { code: pc, single_register_electricity_tariffs: { _B: { direct_debit_monthly: { code: pc === FLEX_PRODUCT ? "E-1R-VAR-22-11-01-B" : "E-1R-AGILE-24-10-01-B" } } } });
    }
    if (u.pathname.includes(FLEX_PRODUCT) && u.pathname.includes("standard-unit-rates")) return mockJsonResponse(200, { results: [{ value_inc_vat: 25, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    if (u.pathname.includes(FLEX_PRODUCT) && u.pathname.includes("standing-charges")) return mockJsonResponse(200, { results: [{ value_inc_vat: 45, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    if (u.pathname.includes(AGILE_PRODUCT) && u.pathname.includes("standard-unit-rates")) {
      const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to"));
      const r = []; let t = new Date(pf); while (t < pt) { const e = new Date(t.getTime()+30*60*1000); r.push({ value_inc_vat: 18, valid_from: t.toISOString(), valid_to: e.toISOString(), payment_method: null }); t = e; }
      return mockJsonResponse(200, { results: r });
    }
    if (u.pathname.includes(AGILE_PRODUCT) && u.pathname.includes("standing-charges")) return mockJsonResponse(200, { results: [{ value_inc_vat: 50, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
    throw new Error("Unhandled mock fetch URL: " + url);
  };
}

function setupState(cfg) {
  document.getElementById("input-apikey").value = "sk_test_fakekey123";
  validateInputs();
  state.accountNumber = "A-TEST0001";
  state.mpan = "1234567890123";
  state.serial = "12A3456789";
  state.accountData = { number: "A-TEST0001", properties: [{ postcode: "AB12 3CD", electricity_meter_points: [{
    mpan: "1234567890123", gsp: "_" + REGION, is_export: false,
    meters: [{ serial_number: "12A3456789" }],
    agreements: cfg.agreements || [{ tariff_code: "E-1R-OE-FIX-12M-25-04-05-B", valid_from: new Date(winStart.getTime() - 10*864e5).toISOString(), valid_to: null }],
  }] }] };
}

(async () => {
  console.log("\n[F1] Dual-fuel mismatch + electricity-only charge/credit split + Fixed labelling\n");
  // Electricity billed 600 kWh, gas 800 kWh; returned readings 30*48*0.3 = 432 kWh.
  const statementNode = {
    id: 1, startAt: winStart.toISOString(), endAt: winEnd.toISOString(),
    totalCharges: { grossTotal: 21000 }, totalCredits: { grossTotal: 5000 },
    transactions: { totalCount: 4, pageInfo: { hasNextPage: false }, edges: [
      { node: { __typename: "BillCharge", title: "Gas", amounts: { gross: 9000 }, consumption: { quantity: 800, unit: "kWh" } } },
      { node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 12000 }, consumption: { quantity: 600, unit: "kWh" } } },
      { node: { __typename: "BillCredit", title: "Referral <img src=x onerror=alert(1)>", reasonCode: "REFERRAL_REWARD", amounts: { gross: 5000 } } },
    ] },
  };
  global.fetch = makeFetch({ statementNode });
  setupState({});
  document.getElementById("results-content").innerHTML = "";
  await runComparison();
  let content = document.getElementById("results-content").innerHTML;

  ok(!content.includes("error-banner"), "renders without error");
  ok(content.includes("mismatch-warning") && content.includes("600.0 kWh") && content.includes("432.0 kWh"),
    "billed-vs-observed mismatch warning shows billed 600.0 and returned 432.0 kWh");
  ok(content.includes("not directly comparable"), "vs-statement deltas demoted under mismatch");
  ok(content.includes("Statement electricity charge") && content.includes("£120.00"),
    "statement charge is electricity-only (£120), gas excluded");
  ok(!content.includes("£210.00"), "the gas-inclusive total (£210) is NOT presented as the statement charge");
  ok(content.includes("Net statement charge") && content.includes("£70.00"), "net statement charge £70 (after £50 credit)");
  ok(content.includes("REFERRAL_REWARD"), "referral credit itemised by reason code");
  ok(/was on <strong>Fixed<\/strong>/.test(content), "period tariff labelled 'Fixed', not region 'B'");
  ok(content.includes("&lt;img src=x onerror=alert(1)&gt;"), "credit title markup is escaped to text");
  ok(!content.includes("<img src=x onerror=alert(1)>"), "credit title markup not rendered as a tag");

  console.log("\n[G] Diagnostics download regression (consistentOnly vs consistentOnlyDiag)\n");
  ok(state.diagnostics && state.diagnostics.totals && state.diagnostics.totals.consistentOnlyDiag,
    "diagnostics stores totals.consistentOnlyDiag (the key the download reads)");
  ok(state.diagnostics.billingPeriods.every(p => typeof p.confident === "boolean"),
    "diagnostics records the same confidence flag used by the UI summary");
  let captured = null;
  global.Blob = function (parts) { this.parts = parts; captured = parts.join(""); };
  // Override unconditionally — Node's real URL.createObjectURL rejects the
  // fake Blob above, so we stub both static methods for the test.
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
  let threw = false;
  try { downloadDiagnostics(); } catch (e) { threw = true; console.error("  download threw:", e.message); }
  ok(!threw, "downloadDiagnostics() does not throw (the consistentOnlyDiag crash is fixed)");
  ok(captured && captured.includes("current tariff periods only"), "diagnostics JSON includes the current-tariff totals block");

  console.log("\n[F2] Near-match -> no warning, comparable deltas\n");
  const near = {
    id: 2, startAt: winStart.toISOString(), endAt: winEnd.toISOString(),
    totalCharges: { grossTotal: 12000 }, totalCredits: { grossTotal: 0 },
    transactions: { totalCount: 1, pageInfo: { hasNextPage: false }, edges: [
      { node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 12000 }, consumption: { quantity: 433, unit: "kWh" } } },
    ] },
  };
  global.fetch = makeFetch({ statementNode: near });
  setupState({});
  document.getElementById("results-content").innerHTML = "";
  await runComparison();
  content = document.getElementById("results-content").innerHTML;
  ok(!content.includes("mismatch-warning"), "near-match billed kWh shows no mismatch warning");
  ok(content.includes("vs statement"), "near-match keeps comparable 'vs statement' deltas");

  console.log(`\nAll ${passed} v2 billing-validation assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
