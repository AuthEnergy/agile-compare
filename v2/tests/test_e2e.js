// End-to-end test: mock fetch + minimal DOM, then run the actual
// extracted app logic to verify the full orchestration produces
// correct numbers against known-good mock API responses.

const assert = require('assert');

// ---- Minimal DOM mock ----
const elements = {};
function makeElement(id) {
  return {
    id,
    value: "",
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    innerHTML: "",
    textContent: "",
    appendChild(child) {
      this._children = this._children || [];
      this._children.push(child);
    },
    scrollTop: 0,
    scrollHeight: 0,
    addEventListener(evt, fn) {
      this._listeners = this._listeners || {};
      this._listeners[evt] = fn;
    },
  };
}

global.document = {
  _elements: elements,
  getElementById(id) {
    if (!elements[id]) elements[id] = makeElement(id);
    return elements[id];
  },
  createElement(tag) {
    return makeElement(null);
  },
  querySelectorAll(sel) {
    return Object.values(elements).filter(e => e.classList && e.classList.contains('screen'));
  },
};

// Pre-seed input fields with valid test values
document.getElementById("input-apikey").value = "sk_test_fakekey123";
document.getElementById("input-account").value = "A-TEST0001";
document.getElementById("input-mpan").value = "1234567890123";
document.getElementById("input-serial").value = "12A3456789";

global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

// ---- Mock fetch ----
// We simulate the real Octopus API response shapes (confirmed via live
// introspection/testing earlier in this project) for each endpoint.

const REGION = "C";
const FLEX_PRODUCT = "VAR-22-11-01";
const AGILE_PRODUCT = "AGILE-24-10-01";

function buildConsumptionResults(periodFrom, periodTo, kwhPerSlot) {
  const results = [];
  let t = new Date(periodFrom);
  while (t < periodTo) {
    const end = new Date(t.getTime() + 30 * 60 * 1000);
    results.push({
      consumption: kwhPerSlot,
      interval_start: t.toISOString(),
      interval_end: end.toISOString(),
    });
    t = end;
  }
  return results;
}

let fetchLog = [];

global.fetch = async (url, opts = {}) => {
  fetchLog.push(url.toString());
  const u = new URL(url.toString());

  // --- Account endpoint ---
  if (u.pathname.includes("/accounts/")) {
    return mockJsonResponse(200, {
      number: "A-TEST0001",
      properties: [{
        electricity_meter_points: [{
          mpan: "1234567890123",
          gsp: "_" + REGION,
          agreements: [
            { tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null },
          ],
        }],
      }],
    });
  }

  // --- Consumption endpoint ---
  if (u.pathname.includes("/consumption/")) {
    const periodFrom = new Date(u.searchParams.get("period_from"));
    const periodTo = new Date(u.searchParams.get("period_to"));
    const results = buildConsumptionResults(periodFrom, periodTo, 0.4); // 0.4 kWh per half hour, constant
    return mockJsonResponse(200, { count: results.length, next: null, results });
  }

  // --- Products list ---
  if (u.pathname === "/v1/products/") {
    return mockJsonResponse(200, {
      count: 2,
      next: null,
      results: [
        { code: FLEX_PRODUCT, display_name: "Flexible Octopus", is_business: false, is_prepay: false, available_to: null },
        { code: AGILE_PRODUCT, display_name: "Agile Octopus", is_business: false, is_prepay: false, available_to: null },
      ],
    });
  }

  // --- Product detail (tariff code lookup) ---
  if (u.pathname.match(/\/products\/[^/]+\/$/)) {
    const productCode = u.pathname.split("/")[3];
    const tariffCode = productCode === FLEX_PRODUCT ? "E-1R-VAR-22-11-01-C" : "E-1R-AGILE-24-10-01-C";
    return mockJsonResponse(200, {
      code: productCode,
      single_register_electricity_tariffs: {
        _C: { direct_debit_monthly: { code: tariffCode } },
      },
    });
  }

  // --- Flexible standard-unit-rates ---
  if (u.pathname.includes(`${FLEX_PRODUCT}/electricity-tariffs`) && u.pathname.includes("standard-unit-rates")) {
    return mockJsonResponse(200, {
      count: 1, next: null,
      results: [
        { value_inc_vat: 25.0, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" },
      ],
    });
  }

  // --- Flexible standing-charges ---
  if (u.pathname.includes(`${FLEX_PRODUCT}/electricity-tariffs`) && u.pathname.includes("standing-charges")) {
    return mockJsonResponse(200, {
      count: 1, next: null,
      results: [
        { value_inc_vat: 45.0, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" },
      ],
    });
  }

  // --- Agile standard-unit-rates (half-hourly, flat 20p for simplicity) ---
  if (u.pathname.includes(`${AGILE_PRODUCT}/electricity-tariffs`) && u.pathname.includes("standard-unit-rates")) {
    const periodFrom = new Date(u.searchParams.get("period_from"));
    const periodTo = new Date(u.searchParams.get("period_to"));
    const results = [];
    let t = new Date(periodFrom);
    while (t < periodTo) {
      const end = new Date(t.getTime() + 30 * 60 * 1000);
      results.push({ value_inc_vat: 20.0, valid_from: t.toISOString(), valid_to: end.toISOString(), payment_method: null });
      t = end;
    }
    return mockJsonResponse(200, { count: results.length, next: null, results });
  }

  // --- Agile standing-charges ---
  if (u.pathname.includes(`${AGILE_PRODUCT}/electricity-tariffs`) && u.pathname.includes("standing-charges")) {
    return mockJsonResponse(200, {
      count: 1, next: null,
      results: [
        { value_inc_vat: 50.0, valid_from: "2020-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" },
      ],
    });
  }

  throw new Error("Unhandled mock fetch URL: " + url);
};

function mockJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// --- Mock the GraphQL POST endpoint specifically (different shape) ---
const originalFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (url.toString().includes("/graphql/")) {
    const body = JSON.parse(opts.body);
    if (body.query.includes("obtainKrakenToken")) {
      return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "fake-jwt-token" } } });
    }
    if (body.query.includes("Statements")) {
      // Two statement periods covering a 60-day test window
      return mockJsonResponse(200, {
        data: {
          account: {
            ledgers: [{
              statements: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  { node: { id: 1, startAt: TEST_PERIOD_FROM_ISO, endAt: TEST_PERIOD_MID_ISO, totalCharges: { grossTotal: 5000 }, totalCredits: { grossTotal: 0 } } },
                  { node: { id: 2, startAt: TEST_PERIOD_MID_ISO, endAt: TEST_PERIOD_TO_ISO, totalCharges: { grossTotal: 6000 }, totalCredits: { grossTotal: 0 } } },
                ],
              },
            }],
          },
        },
      });
    }
    throw new Error("Unhandled mock GraphQL query");
  }
  return originalFetch(url, opts);
};

// Test window: 60 days, split into two 30-day statement periods
const TEST_PERIOD_FROM = new Date("2026-01-01T00:00:00Z");
const TEST_PERIOD_MID = new Date("2026-01-31T00:00:00Z");
const TEST_PERIOD_TO = new Date("2026-03-02T00:00:00Z");
const TEST_PERIOD_FROM_ISO = TEST_PERIOD_FROM.toISOString();
const TEST_PERIOD_MID_ISO = TEST_PERIOD_MID.toISOString();
const TEST_PERIOD_TO_ISO = TEST_PERIOD_TO.toISOString();

// We need these constants available before the fetch mock closure above runs,
// so redeclare with var hoisting workaround: re-assign global fetch now that consts exist.
global.fetch = async (url, opts = {}) => {
  if (url.toString().includes("/graphql/")) {
    const body = JSON.parse(opts.body);
    if (body.query.includes("obtainKrakenToken")) {
      return mockJsonResponse(200, { data: { obtainKrakenToken: { token: "fake-jwt-token" } } });
    }
    if (body.query.includes("Statements")) {
      return mockJsonResponse(200, {
        data: {
          account: {
            ledgers: [{
              statements: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  { node: { id: 1, startAt: TEST_PERIOD_FROM_ISO, endAt: TEST_PERIOD_MID_ISO, totalCharges: { grossTotal: 5000 }, totalCredits: { grossTotal: 0 } } },
                  { node: { id: 2, startAt: TEST_PERIOD_MID_ISO, endAt: TEST_PERIOD_TO_ISO, totalCharges: { grossTotal: 6000 }, totalCredits: { grossTotal: 0 } } },
                ],
              },
            }],
          },
        },
      });
    }
    throw new Error("Unhandled mock GraphQL query");
  }
  return originalFetch(url, opts);
};

// Override the "1 year back, minus 7 days" date logic isn't directly testable
// without editing the source, so instead we just verify the pure functions
// work correctly when invoked the way runComparison invokes them, by loading
// the actual extracted source and calling its internals directly.

const {
  state, fetchAccount, getRegionLetterFromAccount, fetchConsumption, detectGaps,
  findLiveProductCodeByDisplayName, fetchProductTariffCode, fetchRateWindows, calculateCost
} = require('./app_module.js');

(async () => {
  console.log("Running mocked end-to-end orchestration...\n");

  // Directly test the API client + calc pipeline using the test window,
  // mirroring what runComparison does internally.
  state.apiKey = "sk_test_fakekey123";
  state.accountNumber = "A-TEST0001";
  state.mpan = "1234567890123";
  state.serial = "12A3456789";

  const accountData = await fetchAccount(state.accountNumber);
  const regionLetter = getRegionLetterFromAccount(accountData, state.mpan);
  assert.strictEqual(regionLetter, "C", "region should resolve to C");
  console.log("PASS: region resolved correctly:", regionLetter);

  const readings = await fetchConsumption(state.mpan, state.serial, TEST_PERIOD_FROM, TEST_PERIOD_TO);
  const expectedSlots = (TEST_PERIOD_TO - TEST_PERIOD_FROM) / (30 * 60 * 1000);
  assert.strictEqual(readings.length, expectedSlots, `expected ${expectedSlots} readings, got ${readings.length}`);
  console.log(`PASS: fetched ${readings.length} readings (0.4 kWh each)`);

  const gapInfo = detectGaps(readings);
  assert.strictEqual(gapInfo.gaps.length, 0, "mock data should have no gaps");
  console.log("PASS: no gaps detected in clean mock data");

  const flexProductCode = await findLiveProductCodeByDisplayName("Flexible Octopus");
  assert.strictEqual(flexProductCode, FLEX_PRODUCT);
  const flexTariffCode = await fetchProductTariffCode(flexProductCode, regionLetter);
  assert.strictEqual(flexTariffCode, "E-1R-VAR-22-11-01-C");
  console.log("PASS: Flexible product/tariff discovery:", flexProductCode, flexTariffCode);

  const flexUnitRates = await fetchRateWindows(flexProductCode, flexTariffCode, "standard-unit-rates", TEST_PERIOD_FROM, TEST_PERIOD_TO);
  const flexStandingCharges = await fetchRateWindows(flexProductCode, flexTariffCode, "standing-charges", TEST_PERIOD_FROM, TEST_PERIOD_TO);
  assert.strictEqual(flexUnitRates.length, 1);
  assert.strictEqual(flexUnitRates[0].value, 25.0);
  console.log("PASS: Flexible rate windows fetched correctly");

  const agileProductCode = await findLiveProductCodeByDisplayName("Agile Octopus");
  assert.strictEqual(agileProductCode, AGILE_PRODUCT);
  const agileTariffCode = await fetchProductTariffCode(agileProductCode, regionLetter);
  const agileUnitRates = await fetchRateWindows(agileProductCode, agileTariffCode, "standard-unit-rates", TEST_PERIOD_FROM, TEST_PERIOD_TO);
  const agileStandingCharges = await fetchRateWindows(agileProductCode, agileTariffCode, "standing-charges", TEST_PERIOD_FROM, TEST_PERIOD_TO);
  assert.strictEqual(agileUnitRates.length, expectedSlots, "agile should have one rate window per half-hour slot");
  console.log(`PASS: Agile rate windows fetched correctly (${agileUnitRates.length} half-hourly windows)`);

  // Now calculate cost for period 1 (Jan 1 - Jan 31, 30 days)
  const flexCalc = calculateCost(readings, TEST_PERIOD_FROM, TEST_PERIOD_MID, flexUnitRates, flexStandingCharges);
  const expectedKwh = 30 * 48 * 0.4; // 30 days * 48 half-hours * 0.4kwh
  const expectedFlexEnergy = expectedKwh * 25.0;
  const expectedFlexStanding = 30 * 45.0;
  assert.ok(Math.abs(flexCalc.kwh - expectedKwh) < 0.0001, `expected ~${expectedKwh} kWh, got ${flexCalc.kwh}`);
  assert.ok(Math.abs(flexCalc.energyCostPence - expectedFlexEnergy) < 0.0001, `expected ~${expectedFlexEnergy}p energy`);
  assert.ok(Math.abs(flexCalc.standingChargePence - expectedFlexStanding) < 0.0001, `expected ~${expectedFlexStanding}p standing`);
  assert.strictEqual(flexCalc.unmatchedReadings, 0, "no readings should be unmatched");
  console.log(`PASS: Flexible cost for period 1 = £${(flexCalc.totalPence/100).toFixed(2)} (expected £${((expectedFlexEnergy+expectedFlexStanding)/100).toFixed(2)})`);

  const agileCalc = calculateCost(readings, TEST_PERIOD_FROM, TEST_PERIOD_MID, agileUnitRates, agileStandingCharges);
  const expectedAgileEnergy = expectedKwh * 20.0; // flat 20p in our mock
  const expectedAgileStanding = 30 * 50.0;
  assert.ok(Math.abs(agileCalc.energyCostPence - expectedAgileEnergy) < 0.0001, `expected ~${expectedAgileEnergy}p agile energy`);
  assert.strictEqual(agileCalc.unmatchedReadings, 0, "no agile readings should be unmatched");
  console.log(`PASS: Agile cost for period 1 = £${(agileCalc.totalPence/100).toFixed(2)} (expected £${((expectedAgileEnergy+expectedAgileStanding)/100).toFixed(2)})`);

  console.log("\nAll end-to-end mock tests passed.");
})().catch(err => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
