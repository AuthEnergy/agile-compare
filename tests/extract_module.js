#!/usr/bin/env node
/**
 * extract_module.js
 *
 * Pulls the inline <script> block out of ../index.html and writes it
 * to app_module.js as a CommonJS module, so the test files in this
 * folder always run against the REAL app source rather than a copy
 * that can silently drift out of sync.
 *
 * Everything from the "DOM WIRING" marker comment onward is cut,
 * since that code references real DOM elements and localStorage
 * that only exist in a browser — the tests call the underlying
 * functions (validateInputs, runComparison, etc.) directly instead.
 * Cutting at an explicit marker (rather than matching specific
 * button-handler text) keeps this robust as the wiring code changes
 * shape over time — a regex tied to today's exact handlers silently
 * stops stripping correctly the moment that code is restructured.
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

const markerIndex = src.indexOf("DOM WIRING");
if (markerIndex === -1) {
  console.error(
    "Could not find the 'DOM WIRING' marker comment in index.html's script block. " +
    "If that comment was removed or renamed, update the marker text here and in index.html, " +
    "or the test module will include browser-only code that breaks in Node."
  );
  process.exit(1);
}
// Walk back to the start of the comment block (the /* that opens it)
// so the cut removes the marker comment itself too, not just the code after it.
const commentStart = src.lastIndexOf("/*", markerIndex);
src = src.slice(0, commentStart === -1 ? markerIndex : commentStart);

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

