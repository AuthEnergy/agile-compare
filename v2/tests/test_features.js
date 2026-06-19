// v2 tests for the two new features:
//  - historical product merging (findProductsByDisplayNameOverlapping + fetchMergedRateWindows)
//  - export-tariff comparison (collectMeters export, calculateExportValue, runExportComparison)

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
  state, findProductsByDisplayNameOverlapping, fetchMergedRateWindows, rateAt,
  calculateExportValue, collectMeters, runExportComparison, validateInputs,
} = require("./app_module.js");

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log("PASS:", msg); passed++; }
state.apiKey = "sk_test_fakekey123";

/* ============================================================
   SECTION A — historical product merging
   ============================================================ */
(async () => {
  console.log("\n[A] Historical product merging\n");

  // Two Agile product versions that tile the window: OLD (Jan–Sep 2024),
  // NEW (Sep 2024 onward). Each only has rates within its own lifetime.
  const OLD = "AGILE-22-08-31", NEW = "AGILE-24-10-01";
  const productsList = {
    count: 3, next: null, results: [
      { code: OLD, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_from: "2022-08-31T00:00:00Z", available_to: "2024-09-01T00:00:00Z" },
      { code: NEW, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_from: "2024-09-01T00:00:00Z", available_to: null },
      { code: "VAR-22-11-01", display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_from: "2022-11-01T00:00:00Z", available_to: null },
    ],
  };
  global.fetch = async (url) => {
    const u = new URL(url.toString());
    if (u.pathname === "/v1/products/") return mockJsonResponse(200, productsList); // same list regardless of available_at
    if (u.pathname.match(/\/products\/[^/]+\/$/)) {
      const code = u.pathname.split("/")[3];
      return mockJsonResponse(200, { code, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: `E-1R-${code}-C` } } } });
    }
    if (u.pathname.includes(OLD) && u.pathname.includes("standard-unit-rates"))
      return mockJsonResponse(200, { results: [{ value_inc_vat: 10, valid_from: "2024-01-01T00:00:00Z", valid_to: "2024-09-01T00:00:00Z", payment_method: null }] });
    if (u.pathname.includes(NEW) && u.pathname.includes("standard-unit-rates"))
      return mockJsonResponse(200, { results: [{ value_inc_vat: 20, valid_from: "2024-09-01T00:00:00Z", valid_to: null, payment_method: null }] });
    return mockJsonResponse(200, { results: [] });
  };

  const from = new Date("2024-03-01T00:00:00Z"), to = new Date("2024-12-01T00:00:00Z");
  const products = await findProductsByDisplayNameOverlapping("Agile Octopus", from, to);
  ok(products.length === 2, "both overlapping Agile versions discovered (not just the live one)");
  ok(products[0].code === OLD && products[1].code === NEW, "versions sorted oldest-first");
  ok(!products.some(p => p.code === "VAR-22-11-01"), "Flexible product not mixed into Agile discovery");

  const merged = await fetchMergedRateWindows(products, "C", "standard-unit-rates", from, to);
  ok(merged.used.length === 2 && merged.used.includes(OLD) && merged.used.includes(NEW),
    "rate windows merged across BOTH product versions");
  // Coverage: a March instant resolves via OLD (10p), an October instant via NEW (20p).
  ok(rateAt(merged.windows, new Date("2024-03-15T12:00:00Z")) === 10, "pre-switch instant priced from the older version");
  ok(rateAt(merged.windows, new Date("2024-10-15T12:00:00Z")) === 20, "post-switch instant priced from the newer version — the gap that previously left readings unmatched is closed");

  // Degrade gracefully: no overlapping metadata -> still returns candidates.
  const none = await findProductsByDisplayNameOverlapping("Nonexistent Product", from, to);
  ok(Array.isArray(none) && none.length === 0, "unknown display name yields no products (no throw)");

  /* ============================================================
     SECTION B — export valuation (no standing charge)
     ============================================================ */
  console.log("\n[B] Export valuation\n");
  const readings = [
    { start: new Date("2025-06-01T12:00:00Z"), kwh: 1.0 },
    { start: new Date("2025-06-01T12:30:00Z"), kwh: 0.5 },
  ];
  const win = [{ validFrom: new Date("2020-01-01T00:00:00Z"), validTo: null, value: 15 }];
  const ev = calculateExportValue(readings, new Date("2025-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"), win);
  ok(Math.abs(ev.kwh - 1.5) < 1e-9, "export kWh summed (1.5)");
  ok(ev.valuePence === 1.5 * 15, "export value = kWh x unit rate (no standing charge)");
  ok(ev.unmatchedReadings === 0, "all export readings matched a rate");

  // collectMeters now surfaces export meters (tagged), not silently hidden.
  const acct = { number: "A-X", properties: [{ electricity_meter_points: [
    { mpan: "1111111111111", is_export: false, meters: [{ serial_number: "I1" }], agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] },
    { mpan: "2222222222222", is_export: true, meters: [{ serial_number: "E1" }], agreements: [{ tariff_code: "E-1R-OUTGOING-VAR-24-10-26-C", valid_from: "2024-11-01T00:00:00Z", valid_to: null }] },
  ] }] };
  const meters = collectMeters(acct);
  ok(meters.length === 2, "both import and export meters collected (export no longer hidden)");
  ok(meters.find(m => m.mpan === "2222222222222").isExport === true, "export meter tagged isExport");
  ok(meters.find(m => m.mpan === "1111111111111").isExport === false, "import meter tagged not-export");

  /* ============================================================
     SECTION C — export comparison end-to-end through runExportComparison
     ============================================================ */
  console.log("\n[C] Export comparison end-to-end\n");
  const REGION = "C";
  const EXPORT_MPAN = "2222222222222", EXPORT_SERIAL = "E1";
  const exportProducts = {
    count: 2, next: null, results: [
      { code: "OUTGOING-VAR-24-10-26", display_name: "Outgoing Octopus", is_business: false, is_prepay: false, is_variable: true, direction: "EXPORT", available_from: "2024-10-28T00:00:00Z", available_to: null },
      { code: "AGILE-OUTGOING-19-05-13", display_name: "Agile Outgoing Octopus", is_business: false, is_prepay: false, is_variable: true, direction: "EXPORT", available_from: "2018-01-01T00:00:00Z", available_to: null },
    ],
  };
  global.fetch = async (url) => {
    const u = new URL(url.toString());
    if (u.pathname.includes("/consumption/")) {
      const pf = new Date(u.searchParams.get("period_from")), pt = new Date(u.searchParams.get("period_to"));
      const results = []; let t = new Date(pf); const step = 30 * 60 * 1000;
      while (t < pt) { const e = new Date(t.getTime() + step); results.push({ consumption: 0.2, interval_start: t.toISOString(), interval_end: e.toISOString() }); t = e; }
      return mockJsonResponse(200, { count: results.length, next: null, results });
    }
    if (u.pathname === "/v1/products/") return mockJsonResponse(200, exportProducts);
    if (u.pathname.match(/\/products\/[^/]+\/$/)) {
      const code = u.pathname.split("/")[3];
      return mockJsonResponse(200, { code, single_register_electricity_tariffs: { _C: { direct_debit_monthly: { code: `E-1R-${code}-C` } } } });
    }
    if (u.pathname.includes("OUTGOING-VAR") && u.pathname.includes("standard-unit-rates"))
      return mockJsonResponse(200, { results: [{ value_inc_vat: 12, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: null }] });
    if (u.pathname.includes("AGILE-OUTGOING") && u.pathname.includes("standard-unit-rates"))
      return mockJsonResponse(200, { results: [{ value_inc_vat: 16, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: null }] });
    return mockJsonResponse(200, { results: [] });
  };

  state.accountNumber = "A-X";
  state.mpan = EXPORT_MPAN;
  state.serial = EXPORT_SERIAL;
  state.isExport = true;
  state.accountData = { number: "A-X", properties: [{ electricity_meter_points: [
    { mpan: EXPORT_MPAN, gsp: "_" + REGION, is_export: true, meters: [{ serial_number: EXPORT_SERIAL }], agreements: [{ tariff_code: "E-1R-OUTGOING-VAR-24-10-26-C", valid_from: "2024-11-01T00:00:00Z", valid_to: null }] },
  ] }] };
  document.getElementById("results-content").innerHTML = "";
  await runExportComparison();
  const content = document.getElementById("results-content").innerHTML;

  ok(!content.includes("error-banner"), "export run rendered without an error");
  ok(content.includes("Exported") && /\d+ kWh/.test(content), "exported kWh shown");
  ok(content.includes("Outgoing Octopus (flat)") && content.includes("Agile Outgoing"), "both export tariffs shown as cards");
  ok(/Agile Outgoing<\/strong> would have paid you/.test(content), "verdict names the better-paying export tariff (Agile, at 16p vs 12p)");
  ok(/no standing charge/.test(content), "footnote makes clear export carries no standing charge");
  // Numbers: flat 12p vs Agile 16p on the same kWh -> Agile strictly higher.
  const vals = [...content.matchAll(/£([\d,]+\.\d\d)/g)].map(m => parseFloat(m[1].replace(/,/g, "")));
  ok(vals.length >= 2, "money values rendered for both tariffs");

  // Export diagnostics download must not crash (separate diag shape).
  ok(state.diagnostics && state.diagnostics.mode === "export", "export diagnostics recorded with mode:export");
  let captured = null, threw = null;
  global.Blob = function (parts) { captured = parts.join(""); };
  URL.createObjectURL = () => "blob:x"; URL.revokeObjectURL = () => {};
  const { downloadDiagnostics } = require("./app_module.js");
  try { downloadDiagnostics(); } catch (e) { threw = e.message; }
  ok(!threw, "downloadDiagnostics() does not throw on an export run");
  ok(captured && captured.includes("export diagnostic") && captured.includes("EXPORTED"), "export diagnostics JSON has the export summary");

  console.log(`\nAll ${passed} feature assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
