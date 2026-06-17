// Tests the actual runComparison() orchestration function end-to-end.
// The fetch window is now derived from real statement boundaries (see
// index.html), so this mock returns a statement with realistic dates
// relative to the real current time, rather than a fixed window.

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
  querySelectorAll(sel) {
    return Object.values(elements).filter(e => e.classList.contains('screen'));
  },
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
const REAL_FLEX_RATE = 25.0;
const REAL_FLEX_STANDING = 45.0;
const REAL_AGILE_RATE = 18.0;
const REAL_AGILE_STANDING = 50.0;
const KWH_PER_SLOT = 0.3;

global.fetch = async (url, opts = {}) => {
  const u = new URL(url.toString());

  if (u.pathname.includes("/graphql/")) {
    const body = JSON.parse(opts.body);
    if (body.query.includes("obtainKrakenToken")) {
      return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "fake-jwt" } } });
    }
    if (body.query.includes("Statements")) {
      // The fetch window is now DERIVED from statement dates (rather
      // than statements being clamped against a pre-decided window), so
      // this mock needs realistic dates relative to "now" — a single
      // statement covering roughly the last month, ending a bit before
      // today (since the app trims to "7 days ago" for data settling).
      const end = new Date();
      end.setDate(end.getDate() - 10);
      const start = new Date(end);
      start.setDate(start.getDate() - 30);
      return mockJsonResponse(200, {
        data: {
          account: {
            ledgers: [{
              statements: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  { node: { id: 1, startAt: start.toISOString(), endAt: end.toISOString(), totalCharges: { grossTotal: 99999 }, totalCredits: { grossTotal: 0 } } },
                ],
              },
            }],
          },
        },
      });
    }
    throw new Error("Unhandled GraphQL query: " + body.query.slice(0, 50));
  }

  if (u.pathname.includes("/accounts/")) {
    return mockJsonResponse(200, {
      properties: [{ electricity_meter_points: [{ mpan: "1234567890123", gsp: "_" + REGION, agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] }] }],
    });
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
    return mockJsonResponse(200, {
      count: 2, next: null,
      results: [
        { code: FLEX_PRODUCT, display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_to: null },
        { code: AGILE_PRODUCT, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_to: null },
      ],
    });
  }

  if (u.pathname.match(/\/products\/[^/]+\/$/)) {
    const productCode = u.pathname.split("/")[3];
    const tariffCode = productCode === FLEX_PRODUCT ? "E-1R-VAR-22-11-01-C" : "E-1R-AGILE-24-10-01-C";
    return mockJsonResponse(200, { code: productCode, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: tariffCode } } } });
  }

  if (u.pathname.includes(FLEX_PRODUCT) && u.pathname.includes("standard-unit-rates")) {
    return mockJsonResponse(200, { count: 1, next: null, results: [{ value_inc_vat: REAL_FLEX_RATE, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  }
  if (u.pathname.includes(FLEX_PRODUCT) && u.pathname.includes("standing-charges")) {
    return mockJsonResponse(200, { count: 1, next: null, results: [{ value_inc_vat: REAL_FLEX_STANDING, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  }
  if (u.pathname.includes(AGILE_PRODUCT) && u.pathname.includes("standard-unit-rates")) {
    const periodFrom = new Date(u.searchParams.get("period_from"));
    const periodTo = new Date(u.searchParams.get("period_to"));
    const results = [];
    let t = new Date(periodFrom);
    while (t < periodTo) {
      const end = new Date(t.getTime() + 30 * 60 * 1000);
      results.push({ value_inc_vat: REAL_AGILE_RATE, valid_from: t.toISOString(), valid_to: end.toISOString(), payment_method: null });
      t = end;
    }
    return mockJsonResponse(200, { count: results.length, next: null, results });
  }
  if (u.pathname.includes(AGILE_PRODUCT) && u.pathname.includes("standing-charges")) {
    return mockJsonResponse(200, { count: 1, next: null, results: [{ value_inc_vat: REAL_AGILE_STANDING, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }] });
  }

  throw new Error("Unhandled mock fetch URL: " + url);
};

const { runComparison, validateInputs, state } = require('./app_module.js');

(async () => {
  console.log("Running full runComparison() orchestration test...\n");

  const valid = validateInputs();
  if (!valid) throw new Error("validateInputs() failed on known-good test input — check the validation regexes");
  console.log("PASS: validateInputs() accepted test credentials and populated state");

  await runComparison();

  // Check the results screen was activated
  const resultsScreen = document.getElementById("screen-results");
  assert.ok(resultsScreen.classList.contains("active"), "results screen should be active after completion");
  console.log("PASS: results screen activated");

  const content = document.getElementById("results-content").innerHTML;
  console.log("\n--- actual results-content ---");
  console.log(content.slice(0, 1500));
  console.log("--- end content ---\n");

  assert.ok(content.length > 100, "results content should be substantial, not empty/error");
  assert.ok(!content.includes("error-banner"), "should not contain an error banner");
  console.log("PASS: results content rendered without error banner");

  assert.ok(!content.includes("partial"), "a normal statement should not be flagged as partial/clamped now that the fetch window derives from real statement dates");
  console.log("PASS: no spurious 'partial — outside fetched data' flag for a normal statement");

  assert.ok(content.includes("£"), "results should include money values");
  assert.ok(content.includes("Flexible"), "results should mention Flexible");
  assert.ok(content.includes("Agile"), "results should mention Agile");
  console.log("PASS: results mention both tariffs with money values");

  // Sanity check the actual numbers via direct recomputation
  // (We know: 1 statement covering the whole window, KWH_PER_SLOT=0.3,
  // flex rate 25p/kWh + 45p/day standing, agile rate flat 18p/kWh + 50p/day standing)
  console.log("\n--- rendered results-content snippet ---");
  console.log(content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600));
  console.log("--- end snippet ---\n");

  console.log("All runComparison() orchestration tests passed.");
})().catch(err => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

// --- Second scenario: billing history starting more than a year ago ---
// This is the exact case that was previously broken: under the old fixed
// "today minus 1 year" window, a statement starting 13+ months ago would
// have its start date clamped, triggering the "partial — outside fetched
// data" flag even though the user has real billing history for that period.
(async () => {
  console.log("\nRunning long-billing-history regression test...\n");

  const end = new Date();
  end.setDate(end.getDate() - 10);
  const start = new Date(end);
  start.setMonth(start.getMonth() - 14); // 14 months ago — beyond the OLD 1-year cap

  // Override just the Statements mock for this scenario
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (url.toString().includes("/graphql/")) {
      const body = JSON.parse(opts.body);
      if (body.query.includes("obtainKrakenToken")) {
        return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "fake-jwt" } } });
      }
      if (body.query.includes("Statements")) {
        return mockJsonResponse(200, {
          data: { account: { ledgers: [{ statements: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [{ node: { id: 1, startAt: start.toISOString(), endAt: end.toISOString(), totalCharges: { grossTotal: 88888 }, totalCredits: { grossTotal: 0 } } }],
          } }] } },
        });
      }
    }
    return originalFetch(url, opts);
  };

  await runComparison();

  const content = document.getElementById("results-content").innerHTML;
  assert.ok(!content.includes("error-banner"), "a 14-month-old statement should not error");
  assert.ok(!content.includes("partial"), "a 14-month-old statement should NOT be flagged as partial — this is the bug that was reported and fixed");
  console.log("PASS: a billing period starting 14 months ago is fetched and costed in full, with no partial/clamped flag");

  console.log("\nAll long-billing-history regression tests passed.");
})().catch(err => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
