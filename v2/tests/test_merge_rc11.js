// rc11 integration: collectMeters must KEEP export meters (routing them to the
// export-comparison path), not skip them like rc11 did — while adopting rc11's
// tariff-code export detection (EXPORT/OUTGOING/SEG/GENERATION) for meters whose
// is_export flag isn't set. Serials are merged (newest first) for meter swaps.

const assert = require("assert");
const { collectMeters } = require("./app_module.js");
let passed = 0; function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }

const accountData = {
  number: "A-X",
  properties: [{
    address_line_1: "1 Test St", postcode: "AB1 2CD",
    electricity_meter_points: [
      // Normal import meter.
      { mpan: "1111111111111", gsp: "_C", is_export: false, meters: [{ serial_number: "IMP1" }],
        agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] },
      // Export meter with is_export NOT set — must be detected from the tariff
      // code pattern. Two serials (a meter exchange).
      { mpan: "2222222222222", gsp: "_C", is_export: false, meters: [{ serial_number: "EXOLD" }, { serial_number: "EXNEW" }],
        agreements: [{ tariff_code: "E-1R-OUTGOING-FIX-12M-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] },
      // Export meter via the explicit is_export flag.
      { mpan: "3333333333333", gsp: "_C", is_export: true, meters: [{ serial_number: "EXP3" }],
        agreements: [{ tariff_code: "E-1R-AGILE-OUTGOING-19-05-13-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] },
    ],
  }],
};

(async () => {
  const meters = collectMeters(accountData);
  ok(meters.length === 3, "all three meters collected — export meters are NOT skipped (rc11 skipped them)");

  const imp = meters.find(m => m.mpan === "1111111111111");
  const exPattern = meters.find(m => m.mpan === "2222222222222");
  const exFlag = meters.find(m => m.mpan === "3333333333333");

  ok(imp && imp.isExport === false, "normal import meter -> isExport=false");
  ok(exPattern && exPattern.isExport === true, "export meter with no is_export flag detected via OUTGOING tariff code -> isExport=true");
  ok(exFlag && exFlag.isExport === true, "export meter with is_export flag -> isExport=true");

  ok(exPattern.serial === "EXNEW", "primary serial is the most recent meter after an exchange (newest)");
  ok(Array.isArray(exPattern.serials) && exPattern.serials.length === 2 && exPattern.serials[0] === "EXNEW" && exPattern.serials.includes("EXOLD"),
    "all serials kept (newest first) so consumption can be merged across a meter swap");

  console.log(`\nAll ${passed} rc11-merge integration assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
