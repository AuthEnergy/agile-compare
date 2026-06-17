#!/usr/bin/env node
/**
 * extract_module.js
 *
 * Pulls the inline <script> block out of ../index.html and writes it
 * to app_module.js as a CommonJS module, so the test files in this
 * folder always run against the REAL app source rather than a copy
 * that can silently drift out of sync.
 *
 * The two DOM event-listener registrations at the bottom of the
 * script (the actual button click wiring) are stripped, since they
 * reference real DOM elements that only exist in a browser — the
 * tests call the underlying functions (validateInputs, runComparison)
 * directly instead.
 *
 * Run this any time index.html changes, before running the tests:
 *   node tests/extract_module.js && node tests/test_core_logic.js (etc.)
 */

const fs = require("fs");
const path = require("path");

const htmlPath = path.join(__dirname, "..", "index.html");
const outPath = path.join(__dirname, "app_module.js");

const html = fs.readFileSync(htmlPath, "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  console.error("Could not find a <script> block in index.html — has the file structure changed?");
  process.exit(1);
}

let src = match[1];

// Strip the button click handlers at the bottom (they reference real
// DOM elements not present in the Node test environment).
src = src.replace(
  /document\.getElementById\("btn-submit"\)[\s\S]*?\}\);\s*document\.getElementById\("btn-restart"\)[\s\S]*?\}\);\s*$/,
  ""
);

const exported = [
  "state", "validateInputs", "fetchAccount", "getRegionLetterFromAccount",
  "fetchConsumption", "detectGaps", "findLiveProductCodeByDisplayName",
  "fetchProductTariffCode", "fetchRateWindows", "calculateCost",
  "getAgreementsForMpan", "obtainKrakenToken", "fetchStatements",
  "runComparison", "renderResults", "renderError", "rateAt",
];

const output = `${src}\nmodule.exports = { ${exported.join(", ")} };\n`;

fs.writeFileSync(outPath, output);
console.log(`Wrote ${outPath} (${output.length} chars) from index.html`);
