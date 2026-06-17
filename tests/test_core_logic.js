const assert = require('assert');
const { detectGaps, rateAt, calculateCost } = require('./app_module.js');

function makeReadings(startISO, count, kwh) {
  const readings = [];
  let t = new Date(startISO);
  for (let i = 0; i < count; i++) {
    const start = new Date(t);
    const end = new Date(t.getTime() + 30 * 60 * 1000);
    readings.push({ start, end, kwh });
    t = end;
  }
  return readings;
}

// --- Test 1: gap detection, no gaps ---
{
  const readings = makeReadings('2026-01-01T00:00:00Z', 48, 0.5);
  const { gaps, duplicates, earliest, latest } = detectGaps(readings);
  assert.strictEqual(gaps.length, 0, 'expected no gaps');
  assert.strictEqual(duplicates.length, 0, 'expected no duplicates');
  console.log('PASS: no gaps in clean data');
}

// --- Test 2: gap detection, with a 3-slot gap and a duplicate ---
{
  let readings = makeReadings('2026-01-01T00:00:00Z', 200, 0.3);
  // remove slots 50,51,52 (3-slot gap) and 100 (1-slot gap)
  readings = readings.filter((_, i) => ![50, 51, 52, 100].includes(i));
  // add a duplicate of slot 10
  readings.push({ ...readings[10] });

  const { gaps, duplicates } = detectGaps(readings);
  assert.strictEqual(gaps.length, 2, `expected 2 gap ranges, got ${gaps.length}`);
  assert.strictEqual(duplicates.length, 1, `expected 1 duplicate, got ${duplicates.length}`);
  // verify gap sizes
  const gapSizes = gaps.map(g => Math.round((g.end - g.start) / (30 * 60 * 1000)) + 1);
  assert.deepStrictEqual(gapSizes.sort(), [1, 3], `expected gap sizes [1,3], got ${gapSizes}`);
  console.log('PASS: gap detection with known gaps and duplicate');
}

// --- Test 3: rate window matching across boundary ---
{
  const windows = [
    { validFrom: new Date('2025-03-31T23:00:00Z'), validTo: new Date('2025-06-30T23:00:00Z'), value: 26.480 },
    { validFrom: new Date('2025-06-30T23:00:00Z'), validTo: new Date('2025-09-30T23:00:00Z'), value: 25.126 },
  ];
  assert.strictEqual(rateAt(windows, new Date('2025-05-01T00:00:00Z')), 26.480, 'May should use first window');
  assert.strictEqual(rateAt(windows, new Date('2025-07-01T00:00:00Z')), 25.126, 'July should use second window');
  assert.strictEqual(rateAt(windows, new Date('2025-06-30T23:00:00Z')), 25.126, 'exact boundary instant should use new window (validFrom inclusive)');
  assert.strictEqual(rateAt(windows, new Date('2025-06-30T22:59:00Z')), 26.480, 'just before boundary should use old window');
  assert.strictEqual(rateAt(windows, new Date('2024-01-01T00:00:00Z')), null, 'before all windows should be null');
  console.log('PASS: rate window matching at boundaries');
}

// --- Test 4: calculateCost matches hand calculation ---
{
  // 5 days of 0.5kWh every half hour = 120 kWh total
  const readings = makeReadings('2026-01-01T00:00:00Z', 48 * 5, 0.5);
  const unitRateWindows = [{ validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 25.0 }];
  const standingChargeWindows = [{ validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 50.0 }];

  const periodStart = new Date('2026-01-01T00:00:00Z');
  const periodEnd = new Date('2026-01-06T00:00:00Z'); // exclusive, covers 5 days

  const result = calculateCost(readings, periodStart, periodEnd, unitRateWindows, standingChargeWindows);

  assert.strictEqual(result.kwh, 120, `expected 120 kWh, got ${result.kwh}`);
  assert.strictEqual(result.energyCostPence, 120 * 25.0, `expected energy cost ${120*25.0}p, got ${result.energyCostPence}`);
  assert.strictEqual(result.standingChargePence, 5 * 50.0, `expected standing charge ${5*50.0}p, got ${result.standingChargePence}`);
  assert.strictEqual(result.totalPence, 120 * 25.0 + 5 * 50.0, 'total should match sum');
  assert.strictEqual(result.unmatchedReadings, 0, 'all readings should match the rate window');
  console.log(`PASS: calculateCost matches hand calc (£${(result.totalPence/100).toFixed(2)})`);
}

// --- Test 5: calculateCost across a rate boundary mid-period ---
{
  // 10 days of 1 kWh/half-hour, boundary splits day 5/6
  const readings = makeReadings('2026-01-01T00:00:00Z', 48 * 10, 1.0);
  const unitRateWindows = [
    { validFrom: new Date('2020-01-01T00:00:00Z'), validTo: new Date('2026-01-06T00:00:00Z'), value: 20.0 },
    { validFrom: new Date('2026-01-06T00:00:00Z'), validTo: null, value: 30.0 },
  ];
  const standingChargeWindows = [
    { validFrom: new Date('2020-01-01T00:00:00Z'), validTo: new Date('2026-01-06T00:00:00Z'), value: 40.0 },
    { validFrom: new Date('2026-01-06T00:00:00Z'), validTo: null, value: 60.0 },
  ];

  const periodStart = new Date('2026-01-01T00:00:00Z');
  const periodEnd = new Date('2026-01-11T00:00:00Z'); // 10 days

  const result = calculateCost(readings, periodStart, periodEnd, unitRateWindows, standingChargeWindows);

  // 5 days at 20p + 5 days at 30p, 48 half-hours/day * 1kWh = 48kWh/day
  const expectedEnergy = 5 * 48 * 1.0 * 20.0 + 5 * 48 * 1.0 * 30.0;
  // standing charge: days 1-5 at 40p, days 6-10 at 60p (using midday-of-day rate lookup)
  const expectedStanding = 5 * 40.0 + 5 * 60.0;

  assert.strictEqual(result.kwh, 480, `expected 480 kWh total, got ${result.kwh}`);
  assert.strictEqual(result.energyCostPence, expectedEnergy, `expected ${expectedEnergy}p energy, got ${result.energyCostPence}`);
  assert.strictEqual(result.standingChargePence, expectedStanding, `expected ${expectedStanding}p standing, got ${result.standingChargePence}`);
  console.log(`PASS: calculateCost handles mid-period rate boundary correctly (£${(result.totalPence/100).toFixed(2)})`);
}

// --- Test 6: unmatched readings are flagged, not silently dropped ---
{
  const readings = makeReadings('2026-01-01T00:00:00Z', 48, 1.0);
  const unitRateWindows = [{ validFrom: new Date('2027-01-01T00:00:00Z'), validTo: null, value: 25.0 }]; // starts AFTER our readings
  const standingChargeWindows = [{ validFrom: new Date('2027-01-01T00:00:00Z'), validTo: null, value: 50.0 }];

  const result = calculateCost(readings, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'), unitRateWindows, standingChargeWindows);
  assert.strictEqual(result.unmatchedReadings, 48, 'all 48 readings should be unmatched since rate window starts later');
  assert.strictEqual(result.energyCostPence, 0, 'no energy cost should accrue for unmatched readings');
  console.log('PASS: unmatched readings correctly flagged rather than silently miscalculated');
}

// --- Test 7: region detection from a REAL account response shape ---
// This is a regression test for a real bug: Octopus's documented example
// responses show a `gsp` field on each electricity_meter_point (e.g.
// "_C"), but a real account fetched during development had NO such
// field at all. getRegionLetterFromAccount must fall back to parsing
// the region letter off the end of the tariff_code in that case.
{
  const { getRegionLetterFromAccount } = require('./app_module.js');
  const realShapeNoGsp = {
    number: "A-1FC1B997",
    properties: [{
      electricity_meter_points: [{
        mpan: "1050001523469",
        // deliberately no `gsp` field, matching the real response
        agreements: [
          { tariff_code: "E-1R-VAR-22-11-01-A", valid_from: "2025-05-31T00:00:00+01:00", valid_to: "2025-06-24T00:00:00+01:00" },
          { tariff_code: "E-1R-AGILE-24-10-01-A", valid_from: "2025-06-24T00:00:00+01:00", valid_to: "2026-06-24T00:00:00+01:00" },
        ],
        is_export: false,
      }],
      gas_meter_points: [],
    }],
  };
  const region = getRegionLetterFromAccount(realShapeNoGsp, "1050001523469");
  assert.strictEqual(region, "A", `expected region A parsed from tariff_code suffix, got ${region}`);
  console.log("PASS: region correctly derived from tariff_code when gsp field is absent (real-world regression case)");
}

// --- Test 8: gsp field still works as a fallback when present ---
{
  const { getRegionLetterFromAccount } = require('./app_module.js');
  const withGsp = {
    properties: [{
      electricity_meter_points: [{ mpan: "9999999999999", gsp: "_M", agreements: [] }],
    }],
  };
  const region = getRegionLetterFromAccount(withGsp, "9999999999999");
  assert.strictEqual(region, "M", `expected region M from gsp field, got ${region}`);
  console.log("PASS: gsp field still used correctly when present");
}

// --- Test 9: MPAN genuinely not on the account returns null (not the sentinel) ---
{
  const { getRegionLetterFromAccount } = require('./app_module.js');
  const noMatch = {
    properties: [{ electricity_meter_points: [{ mpan: "1111111111111", gsp: "_C", agreements: [] }] }],
  };
  const region = getRegionLetterFromAccount(noMatch, "9999999999999");
  assert.strictEqual(region, null, `expected null for a genuinely absent MPAN, got ${region}`);
  console.log("PASS: a truly absent MPAN returns null, distinct from the 'found but no region' sentinel");
}

// --- Test 10: calculateCost accepts a realistic long billing period (14 months) ---
// This is a real scenario for an infrequently-switching customer, and was
// previously broken by an overly tight 400-day guard.
{
  const longReadings = makeReadings('2025-01-01T00:00:00Z', 48 * 420, 0.3); // ~420 days of data
  const unitRateWindows = [{ validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 25.0 }];
  const standingChargeWindows = [{ validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, value: 45.0 }];
  const periodStart = new Date('2025-01-01T00:00:00Z');
  const periodEnd = new Date('2026-02-25T00:00:00Z'); // ~420 days later

  let threw = false;
  let result;
  try {
    result = calculateCost(longReadings, periodStart, periodEnd, unitRateWindows, standingChargeWindows);
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, "a realistic 420-day billing period should NOT trip the defensive guard");
  assert.ok(result.kwh > 0, "a realistic long period should still calculate a real cost");
  console.log(`PASS: calculateCost accepts a realistic 420-day billing period (£${(result.totalPence/100).toFixed(2)})`);
}

// --- Test 11: calculateCost still rejects a genuinely implausible date range ---
// Guards against a regression where the guard is widened so far it stops
// catching real bugs (e.g. an unclamped statement with a 2000-2099 span).
{
  let threw = false;
  let message = "";
  try {
    calculateCost([], new Date('2000-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z'), [], []);
  } catch (e) {
    threw = true;
    message = e.message;
  }
  assert.strictEqual(threw, true, "a ~36000-day range should still trip the defensive guard");
  assert.ok(message.includes("implausible"), "the error should clearly explain this looks like a bug");
  console.log("PASS: calculateCost still rejects a genuinely implausible (~36000-day) date range");
}

console.log('\nAll tests passed.');
