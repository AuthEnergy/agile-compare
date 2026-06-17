// Regression test: billing periods that are realistic and fully INSIDE
// the fetched data window (the normal case) should compute correctly
// with NO clamping applied, and should not show the "partial" flag.

const assert = require('assert');

const elements = {};
function makeElement(id) {
  return {
    id, value: "", innerHTML: "", textContent: "", scrollTop: 0, scrollHeight: 0,
    classList: {
      _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    appendChild(child) { (this._children = this._children || []).push(child); },
    addEventListener() {},
  };
}

global.document = {
  getElementById(id) {
    if (!elements[id]) elements[id] = makeElement(id);
    return elements[id];
  },
  createElement() { return makeElement(null); },
  querySelectorAll() { return Object.values(elements).filter(e => e.classList.contains('screen')); },
};

document.getElementById("input-apikey").value = "sk_test_fakekey123";
document.getElementById("input-account").value = "A-TEST0001";
document.getElementById("input-mpan").value = "1234567890123";
document.getElementById("input-serial").value = "12A3456789";

global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

function mockJsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const REGION = "C";
const FLEX_PRODUCT = "VAR-22-11-01";
const AGILE_PRODUCT = "AGILE-24-10-01";
const FLEX_RATE = 25.0, FLEX_STANDING = 45.0;
const AGILE_RATE = 18.0, AGILE_STANDING = 50.0;
const KWH_PER_SLOT = 0.3;

// Compute "now - 7 days" and "now - 1 year - 7 days" the same way the
// app does, so our mock statement dates land realistically inside it.
const now = new Date();
const appPeriodTo = new Date(now); appPeriodTo.setDate(appPeriodTo.getDate() - 7); appPeriodTo.setUTCHours(0,0,0,0);
const appPeriodFrom = new Date(appPeriodTo); appPeriodFrom.setFullYear(appPeriodFrom.getFullYear() - 1);

// One realistic 30-day statement, comfortably inside [appPeriodFrom, appPeriodTo]
const stmtStart = new Date(appPeriodFrom); stmtStart.setDate(stmtStart.getDate() + 10);
const stmtEnd = new Date(stmtStart); stmtEnd.setDate(stmtEnd.getDate() + 30);
const ACTUAL_CHARGE_PENCE = 12345;

global.fetch = async (url, opts = {}) => {
  const u = new URL(url.toString());

  if (u.pathname.includes("/graphql/")) {
    const body = JSON.parse(opts.body);
    if (body.query.includes("obtainKrakenToken")) {
      return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "fake-jwt" } } });
    }
    if (body.query.includes("Statements")) {
      return mockJsonResponse(200, {
        data: { account: { ledgers: [{ statements: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [{ node: { id: 1, startAt: stmtStart.toISOString(), endAt: stmtEnd.toISOString(), totalCharges: { grossTotal: ACTUAL_CHARGE_PENCE }, totalCredits: { grossTotal: 0 } } }],
        } }] } },
      });
    }
    throw new Error("Unhandled GraphQL query");
  }

  if (u.pathname.includes("/accounts/")) {
    return mockJsonResponse(200, { properties: [{ electricity_meter_points: [{ mpan: "1234567890123", gsp: "_" + REGION, agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] }] }] });
  }

  if (u.pathname.includes("/consumption/")) {
    const periodFrom = new Date(u.searchParams.get("period_from"));
    const periodTo = new Date(u.searchParams.get("period_to"));
    const results = [];
    let t = new Date(periodFrom);
    while (t < periodTo) {
      const end = new Date(t.getTime() + 30 * 60 * 1000);
      results.push({ consumption: KWH_PER_SLOT, interval_start: t.toISOString(), interval_end: end.toISOString() });
      t = end;
    }
    return mockJsonResponse(200, { count: results.length, next: null, results });
  }

  if (u.pathname === "/v1/products/") {
    return mockJsonResponse(200, { count: 2, next: null, results: [
      { code: FLEX_PRODUCT, display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_to: null },
      { code: AGILE_PRODUCT, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_to: null },
    ]});
  }

  if (u.pathname.match(/\/products\/[^/]+\/$/)) {
    const productCode = u.pathname.split("/")[3];
    const tariffCode = productCode === FLEX_PRODUCT ? "E-1R-VAR-22-11-01-C" : "E-1R-AGILE-24-10-01-C";
    return mockJsonResponse(200, { code: productCode, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: tariffCode } } } });
  }

  if (u.pathname.includes(FLEX_PRODUCT) && u.pathname.includes("standard-unit-rates")) {
    return mockJsonResponse(200, { count: 1, next: null, results: [{ value_inc_vat: FLEX_RATE, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  }
  if (u.pathname.includes(FLEX_PRODUCT) && u.pathname.includes("standing-charges")) {
    return mockJsonResponse(200, { count: 1, next: null, results: [{ value_inc_vat: FLEX_STANDING, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  }
  if (u.pathname.includes(AGILE_PRODUCT) && u.pathname.includes("standard-unit-rates")) {
    const periodFrom = new Date(u.searchParams.get("period_from"));
    const periodTo = new Date(u.searchParams.get("period_to"));
    const results = [];
    let t = new Date(periodFrom);
    while (t < periodTo) {
      const end = new Date(t.getTime() + 30 * 60 * 1000);
      results.push({ value_inc_vat: AGILE_RATE, valid_from: t.toISOString(), valid_to: end.toISOString(), payment_method: null });
      t = end;
    }
    return mockJsonResponse(200, { count: results.length, next: null, results });
  }
  if (u.pathname.includes(AGILE_PRODUCT) && u.pathname.includes("standing-charges")) {
    return mockJsonResponse(200, { count: 1, next: null, results: [{ value_inc_vat: AGILE_STANDING, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  }

  throw new Error("Unhandled mock fetch URL: " + url);
};

const { runComparison, validateInputs } = require('./app_module.js');

(async () => {
  console.log("Running realistic (non-pathological) billing period regression test...\n");
  console.log(`Mock statement: ${stmtStart.toISOString().slice(0,10)} to ${stmtEnd.toISOString().slice(0,10)} (30 days, fully inside fetch window)\n`);

  const valid = validateInputs();
  if (!valid) throw new Error("validateInputs() failed on known-good test input");

  await runComparison();

  const content = document.getElementById("results-content").innerHTML;

  assert.ok(!content.includes("error-banner"), "should not error");
  assert.ok(!content.includes("partial"), "a fully-contained statement should NOT show the 'partial / outside fetched data' flag");
  console.log("PASS: no error, no spurious 'partial' flag for a well-bounded statement");

  // Hand-calculate expected values: 30 days, 48 slots/day, 0.3 kWh/slot
  const expectedKwh = 30 * 48 * KWH_PER_SLOT;
  const expectedFlexTotal = (expectedKwh * FLEX_RATE + 30 * FLEX_STANDING) / 100;
  const expectedAgileTotal = (expectedKwh * AGILE_RATE + 30 * AGILE_STANDING) / 100;

  console.log(`Expected: kWh=${expectedKwh}, Flexible=£${expectedFlexTotal.toFixed(2)}, Agile=£${expectedAgileTotal.toFixed(2)}, Actual=£${(ACTUAL_CHARGE_PENCE/100).toFixed(2)}`);

  const flexMatch = content.match(/Flexible \(calculated\)<\/div>\s*<div class="value">£([\d.]+)</);
  const agileMatch = content.match(/Agile \(calculated\)<\/div>\s*<div class="value">£([\d.]+)</);
  const actualMatch = content.match(/Actual paid<\/div>\s*<div class="value">£([\d.]+)</);

  assert.ok(flexMatch, "should find a Flexible total in the rendered output");
  assert.ok(agileMatch, "should find an Agile total in the rendered output");
  assert.ok(actualMatch, "should find an Actual total in the rendered output");

  const renderedFlex = parseFloat(flexMatch[1]);
  const renderedAgile = parseFloat(agileMatch[1]);
  const renderedActual = parseFloat(actualMatch[1]);

  console.log(`Rendered: Flexible=£${renderedFlex}, Agile=£${renderedAgile}, Actual=£${renderedActual}`);

  assert.ok(Math.abs(renderedFlex - expectedFlexTotal) < 0.01, `Flexible total mismatch: rendered £${renderedFlex}, expected £${expectedFlexTotal.toFixed(2)}`);
  assert.ok(Math.abs(renderedAgile - expectedAgileTotal) < 0.01, `Agile total mismatch: rendered £${renderedAgile}, expected £${expectedAgileTotal.toFixed(2)}`);
  assert.ok(Math.abs(renderedActual - ACTUAL_CHARGE_PENCE/100) < 0.01, `Actual total mismatch`);

  console.log("\nPASS: all rendered totals match hand-calculated expected values for a realistic billing period.");
  console.log("\nAll regression tests passed.");
})().catch(err => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
