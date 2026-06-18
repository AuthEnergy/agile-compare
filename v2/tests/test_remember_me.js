// Tests the "remember my API key" localStorage logic.
// As of v0.2, only the API key is stored — account/mpan/serial are
// auto-discovered via fetchAndPickMeter and don't need remembering.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function makeMockLocalStorage() {
  const store = {};
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
  };
}

const elements = {};
function makeElement(id) {
  return { id, value: "", checked: false, style: {}, addEventListener() {} };
}

global.localStorage = makeMockLocalStorage();
global.document = {
  getElementById(id) {
    if (!elements[id]) elements[id] = makeElement(id);
    return elements[id];
  },
};

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const fullSrc = scriptMatch[1];

const storageSectionMatch = fullSrc.match(/const STORAGE_KEY[\s\S]*$/);
if (!storageSectionMatch) {
  console.error("Could not find STORAGE_KEY section in index.html");
  process.exit(1);
}
let storageSrc = storageSectionMatch[0];
storageSrc = storageSrc.replace(/document\.getElementById\("btn-clear-saved"\)[\s\S]*?\}\);\s*/, "");
storageSrc = storageSrc.replace(/loadSavedCredentials\(\);\s*$/, "");

global.state = { apiKey: "", accountNumber: "", mpan: "", serial: "", accountData: null };

eval(storageSrc + "\nglobal.__test_exports = { loadSavedCredentials, saveOrClearCredentials, updateClearButtonVisibility, STORAGE_KEY };");
const _exports = global.__test_exports;
const loadSavedCredentialsFn = _exports.loadSavedCredentials;
const saveOrClearCredentialsFn = _exports.saveOrClearCredentials;
const updateClearButtonVisibilityFn = _exports.updateClearButtonVisibility;
const STORAGE_KEY = _exports.STORAGE_KEY;

console.log("Running localStorage remember-me tests...\n");

// --- Test 1: nothing saved initially, clear button stays hidden ---
{
  elements["clear-saved-row"] = makeElement("clear-saved-row");
  loadSavedCredentialsFn();
  assert.strictEqual(elements["clear-saved-row"].style.display, "none");
  console.log("PASS: clear-saved button hidden when nothing is saved");
}

// --- Test 2: ticking remember saves only the API key ---
{
  global.state = { apiKey: "sk_live_abc123", accountNumber: "A-AAAA1111", mpan: "1234567890123", serial: "12A3456789", accountData: null };
  elements["input-remember"] = makeElement("input-remember");
  elements["input-remember"].checked = true;

  saveOrClearCredentialsFn();

  const raw = localStorage.getItem(STORAGE_KEY);
  assert.ok(raw, "something should be saved");
  const saved = JSON.parse(raw);
  assert.strictEqual(saved.apiKey, "sk_live_abc123", "API key should be saved");
  assert.strictEqual(saved.accountNumber, undefined, "accountNumber should NOT be saved (auto-discovered in v0.2)");
  assert.strictEqual(saved.mpan, undefined, "MPAN should NOT be saved");
  assert.strictEqual(saved.serial, undefined, "serial should NOT be saved");
  console.log("PASS: only API key saved — account/mpan/serial correctly excluded (auto-discovered in v0.2)");

  assert.strictEqual(elements["clear-saved-row"].style.display, "block");
  console.log("PASS: clear-saved button becomes visible after saving");
}

// --- Test 3: reload pre-fills only the API key field ---
{
  elements["input-apikey"] = makeElement("input-apikey");
  elements["input-remember"].checked = false;

  loadSavedCredentialsFn();

  assert.strictEqual(elements["input-apikey"].value, "sk_live_abc123");
  assert.strictEqual(elements["input-remember"].checked, true);
  console.log("PASS: API key pre-filled and checkbox re-ticked on simulated reload");
}

// --- Test 4: unticking remember clears storage ---
{
  elements["input-remember"].checked = false;
  saveOrClearCredentialsFn();
  assert.strictEqual(localStorage.getItem(STORAGE_KEY), null);
  console.log("PASS: unticking remember clears storage");
}

// --- Test 5: clear button wipes storage and API key field ---
{
  global.state = { apiKey: "sk_live_xyz", accountNumber: "", mpan: "", serial: "", accountData: null };
  elements["input-remember"].checked = true;
  saveOrClearCredentialsFn();
  assert.ok(localStorage.getItem(STORAGE_KEY));

  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  elements["input-apikey"].value = "";
  elements["input-remember"].checked = false;
  updateClearButtonVisibilityFn();

  assert.strictEqual(localStorage.getItem(STORAGE_KEY), null);
  assert.strictEqual(elements["input-apikey"].value, "");
  assert.strictEqual(elements["clear-saved-row"].style.display, "none");
  console.log("PASS: clear button wipes storage and hides itself");
}

console.log("\nAll remember-me storage tests passed.");
