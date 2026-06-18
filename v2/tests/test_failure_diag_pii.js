// Failure-diagnostic PII + the empty-readings error path:
//  - error messages interpolate the MPAN; the DOWNLOADED failure diagnostic must
//    NOT carry it (redactPII), per the "no MPAN in saved files" promise.
//  - the empty-readings branch must produce the intended "no data" message, NOT
//    a ReferenceError (regression guard for the dropped usedSerial variable).

const assert = require("assert");

const elements = {};
function mk(id) {
  return { id, value: "", innerHTML: "", textContent: "", href: "", download: "", scrollTop: 0, scrollHeight: 0, _children: [], firstChild: null,
    classList: { _set: new Set(id === "screen-input" ? ["screen", "active"] : (id && id.startsWith("screen-") ? ["screen"] : [])), add(c){this._set.add(c)}, remove(c){this._set.delete(c)}, contains(c){return this._set.has(c)} },
    style: {}, appendChild(c){this._children.push(c);this.firstChild=this._children[0]}, insertBefore(n){this._children.unshift(n);this.firstChild=this._children[0]}, removeChild(){}, addEventListener(){}, querySelectorAll(){return[]}, click(){} };
}
global.document = { getElementById(id){if(!elements[id])elements[id]=mk(id);return elements[id]}, createElement(){return mk(null)}, querySelectorAll(){return Object.values(elements).filter(e=>e.classList.contains("screen"))}, body: mk("body") };
global.btoa = s => Buffer.from(s, "binary").toString("base64");
function mj(s, b) { return { ok: s >= 200 && s < 300, status: s, json: async () => b, text: async () => JSON.stringify(b) }; }
function ledgerData(l) { return mj(200, { data: { account: { ledgers: l } } }); }

const { state, runComparison, validateInputs, redactPII } = require("./app_module.js");
let passed = 0; function ok(c, m) { assert.ok(c, m); console.log("PASS:", m); passed++; }
const MPAN = "1234567890123";

(async () => {
  console.log("\n[A] redactPII strips MPAN / serial / API key, keeps other text\n");
  state.apiKey = "sk_test_secretkey"; state.mpan = MPAN; state.serial = "99Z9999999"; state.serials = ["99Z9999999"];
  const red = redactPII(`No data for MPAN ${MPAN} on serial 99Z9999999 (key sk_test_secretkey)`);
  ok(!red.includes(MPAN), "MPAN digits removed");
  ok(!red.includes("99Z9999999"), "serial removed");
  ok(!red.includes("sk_test_secretkey"), "API key removed");
  ok(/\[MPAN redacted\]/.test(red) && /No data for MPAN/.test(red), "surrounding text preserved, placeholder inserted");
  ok(redactPII(null) === null, "null passes through");

  console.log("\n[B] Empty consumption -> intended 'no data' error (NOT a ReferenceError), and the saved failure diag carries no MPAN\n");
  const winEnd = new Date(); winEnd.setUTCDate(winEnd.getUTCDate() - 10); winEnd.setUTCHours(0, 0, 0, 0);
  const winStart = new Date(winEnd); winStart.setUTCDate(winStart.getUTCDate() - 30);
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url.toString());
    if (u.pathname.includes("/graphql/")) {
      const b = JSON.parse(opts.body);
      if (b.query.includes("obtainKrakenToken")) return mj(200, { data: { obtainKrakenToken: { token: "t" } } });
      if (b.query.includes("Statements")) return ledgerData([{ statements: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: 1, startAt: winStart.toISOString(), endAt: winEnd.toISOString(), totalCharges: { grossTotal: 12000 }, transactions: { totalCount: 1, pageInfo: { hasNextPage: false }, edges: [{ node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 12000 }, consumption: { quantity: 432 } } }] } } }] } }]);
      throw new Error("gql");
    }
    // Every consumption call (the windowed fetch AND the page_size=1 probe)
    // returns nothing -> drives the empty-readings branch + its follow-up probe.
    if (u.pathname.includes("/consumption/")) return mj(200, { count: 0, next: null, results: [] });
    return mj(200, { count: 0, next: null, results: [] });
  };
  document.getElementById("input-apikey").value = "sk_test_secretkey"; validateInputs();
  state.accountNumber = "A-X"; state.mpan = MPAN; state.serial = "99Z9999999"; state.serials = ["99Z9999999"]; state.isExport = false;
  state.failureDiag = null;
  state.accountData = { number: "A-X", properties: [{ postcode: "AB1 2CD", electricity_meter_points: [{ mpan: MPAN, gsp: "_C", is_export: false, meters: [{ serial_number: "99Z9999999" }], agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2023-01-01T00:00:00Z", valid_to: null }] }] }] };
  document.getElementById("results-content").innerHTML = "";

  await runComparison();

  ok(state.failureDiag != null, "a failure diagnostic was captured");
  const msg = state.failureDiag.error.message;
  ok(/no half-hourly consumption data/i.test(msg), "the intended 'no data' message was produced (not a ReferenceError from a dropped variable)");
  ok(!/ReferenceError|is not defined/.test(msg), "the empty-readings branch did NOT throw a ReferenceError");
  ok(!msg.includes(MPAN), "error.message no longer contains the raw MPAN (redacted at capture)");
  ok(/\[MPAN redacted\]/.test(msg), "error.message shows the [MPAN redacted] placeholder");
  // The whole serialised failure diagnostic (what gets downloaded) must be MPAN-free.
  const serialised = JSON.stringify(state.failureDiag);
  ok(!serialised.includes(MPAN), "the serialised failure diagnostic contains NO MPAN digits anywhere");
  ok(!serialised.includes("99Z9999999"), "the serialised failure diagnostic contains no meter serial");

  console.log("\n[C] In-window readings empty but data exists earlier -> 'predate' message (not a ReferenceError)\n");
  // Windowed fetch (has period_from) returns nothing; the page_size=1 probe
  // (no period_from) returns one OLD reading -> the "data exists but predates
  // the window" branch, which references state.serial (was the orphaned
  // usedSerial). This drives the OTHER sub-branch of readings.length===0.
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url.toString());
    if (u.pathname.includes("/graphql/")) {
      const b = JSON.parse(opts.body);
      if (b.query.includes("obtainKrakenToken")) return mj(200, { data: { obtainKrakenToken: { token: "t" } } });
      if (b.query.includes("Statements")) return ledgerData([{ statements: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: 1, startAt: winStart.toISOString(), endAt: winEnd.toISOString(), totalCharges: { grossTotal: 12000 }, transactions: { totalCount: 1, pageInfo: { hasNextPage: false }, edges: [{ node: { __typename: "BillCharge", title: "Electricity", amounts: { gross: 12000 }, consumption: { quantity: 432 } } }] } } }] } }]);
      throw new Error("gql");
    }
    if (u.pathname.includes("/consumption/")) {
      if (u.searchParams.has("period_from")) return mj(200, { count: 0, next: null, results: [] });
      return mj(200, { count: 1, next: null, results: [{ interval_start: "2020-03-15T00:00:00Z", interval_end: "2020-03-15T00:30:00Z", consumption: 0.5 }] });
    }
    return mj(200, { count: 0, next: null, results: [] });
  };
  state.failureDiag = null;
  document.getElementById("results-content").innerHTML = "";
  await runComparison();
  const msgC = state.failureDiag && state.failureDiag.error.message;
  ok(state.failureDiag != null, "a failure diagnostic was captured for the predate case");
  ok(/predate your smart meter readings/i.test(msgC || ""), "the 'comparison window may predate your smart meter readings' message is produced (the branch that used usedSerial)");
  ok(/data from 2020-03-15/.test(msgC || ""), "the message reports the earliest available data date from the probe");
  ok(!/ReferenceError|is not defined/.test(msgC || ""), "no ReferenceError in the predate branch");

  console.log(`\nAll ${passed} failure-diag PII assertions passed.`);
})().catch(err => { console.error("TEST FAILED:", err); process.exit(1); });
