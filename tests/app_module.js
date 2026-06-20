
/* ============================================================
   CORE CALCULATION LOGIC
   (mirrors core_logic_test.js, verified separately with Node)
   ============================================================ */

function rateAt(rateWindows, instant) {
  const t = instant.getTime();
  for (const w of rateWindows) {
    const from = w.validFrom.getTime();
    const to = w.validTo ? w.validTo.getTime() : Infinity;
    if (t >= from && t < to) return w.value;
  }
  return null;
}

function detectGaps(readings) {
  if (readings.length === 0) return { gaps: [], duplicates: [], earliest: null, latest: null };
  const sorted = [...readings].sort((a, b) => a.start - b.start);
  const earliest = sorted[0].start;
  const latest = sorted[sorted.length - 1].start;

  const seen = new Map();
  for (const r of sorted) {
    const key = r.start.getTime();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([_, c]) => c > 1).map(([t]) => new Date(t));

  const stepMs = 30 * 60 * 1000;
  const gaps = [];
  let current = earliest.getTime();
  let gapStart = null;
  while (current <= latest.getTime()) {
    if (!seen.has(current)) {
      if (gapStart === null) gapStart = current;
    } else if (gapStart !== null) {
      gaps.push({ start: new Date(gapStart), end: new Date(current - stepMs) });
      gapStart = null;
    }
    current += stepMs;
  }
  if (gapStart !== null) gaps.push({ start: new Date(gapStart), end: new Date(current - stepMs) });

  return { gaps, duplicates, earliest, latest };
}

function calculateCost(readings, periodStart, periodEnd, unitRateWindows, standingChargeWindows) {
  let kwh = 0;
  let energyCostPence = 0;
  let unmatchedReadings = 0;

  for (const r of readings) {
    if (r.start >= periodStart && r.start < periodEnd) {
      kwh += r.kwh;
      const rate = rateAt(unitRateWindows, r.start);
      if (rate === null) unmatchedReadings++;
      else energyCostPence += r.kwh * rate;
    }
  }

  // Defensive guard against a genuinely implausible date range (e.g. an
  // open-ended statement with no real end date, or a date-parsing bug).
  // This function should always be called with periodStart/periodEnd
  // already clamped to the actual data window by the caller, but this
  // check exists as a second line of defense — an unclamped, accidentally
  // huge date range would otherwise silently inflate the standing charge
  // total by iterating the day-counting loop below across however many
  // days the bad range spans, with no visible error. The bound is set
  // generously above the app's own 3-year fetch-window cap (see
  // runComparison), since a real billing period can legitimately span
  // well over a year for an infrequently-switching customer.
  const spanDays = (periodEnd - periodStart) / (24 * 60 * 60 * 1000);
  if (spanDays > 1500) {
    throw new Error(
      `calculateCost called with an implausible date range (${spanDays.toFixed(0)} days, ` +
      `${periodStart.toISOString()} to ${periodEnd.toISOString()}). This is almost certainly a bug ` +
      `(an unclamped statement date) rather than a real billing period.`
    );
  }

  let standingChargePence = 0;
  let cursor = new Date(periodStart);
  cursor.setUTCHours(12, 0, 0, 0);
  if (cursor < periodStart) cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor < periodEnd) {
    const rate = rateAt(standingChargeWindows, cursor);
    if (rate !== null) standingChargePence += rate;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { kwh, energyCostPence, standingChargePence, totalPence: energyCostPence + standingChargePence, unmatchedReadings };
}

/* ============================================================
   API CLIENT
   ============================================================ */

const REST_BASE = "https://api.octopus.energy/v1";
const GRAPHQL_URL = "https://api.octopus.energy/v1/graphql/";

class OctopusApiError extends Error {
  constructor(message, { corsLikely = false, status = null, body = null } = {}) {
    super(message);
    this.corsLikely = corsLikely;
    this.status = status;
    this.body = body;
  }
}

async function restGet(path, params = {}) {
  const url = new URL(path.startsWith("http") ? path : REST_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: { "Authorization": "Basic " + btoa(state.apiKey + ":") }
    });
  } catch (e) {
    // A network-level fetch failure with no response at all is the
    // classic CORS signature in browsers (the actual reason is hidden
    // from JS by design; only the console shows it).
    throw new OctopusApiError(
      "Network request failed before any response was received. This is almost always a CORS block " +
      "(the browser refusing to let this page read api.octopus.energy's response) or a connectivity issue. " +
      "Check the browser console for the specific reason.",
      { corsLikely: true }
    );
  }
  if (!resp.ok) {
    let bodyText = "";
    try { bodyText = await resp.text(); } catch (e) {}
    throw new OctopusApiError(`HTTP ${resp.status} from ${url.pathname}: ${bodyText.slice(0, 300)}`, { status: resp.status, body: bodyText });
  }
  return resp.json();
}

async function restGetAllPages(path, params = {}) {
  let results = [];
  let nextUrl = REST_BASE + path;
  let nextParams = params;
  let guard = 0;
  while (nextUrl && guard < 50) {
    const url = new URL(nextUrl);
    for (const [k, v] of Object.entries(nextParams || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const page = await restGetRaw(url.toString());
    results = results.concat(page.results || []);
    nextUrl = page.next;
    nextParams = null;
    guard++;
  }
  return results;
}

async function restGetRaw(fullUrl) {
  let resp;
  try {
    resp = await fetch(fullUrl, {
      headers: { "Authorization": "Basic " + btoa(state.apiKey + ":") }
    });
  } catch (e) {
    throw new OctopusApiError(
      "Network request failed before any response was received (likely CORS). Check the browser console.",
      { corsLikely: true }
    );
  }
  if (!resp.ok) {
    let bodyText = "";
    try { bodyText = await resp.text(); } catch (e) {}
    throw new OctopusApiError(`HTTP ${resp.status}: ${bodyText.slice(0, 300)}`, { status: resp.status, body: bodyText });
  }
  return resp.json();
}

async function graphqlRequest(query, variables = {}, token = null) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (token) headers["Authorization"] = token;

  let resp;
  try {
    resp = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new OctopusApiError(
      "GraphQL request failed before any response was received (likely CORS). Check the browser console.",
      { corsLikely: true }
    );
  }
  if (!resp.ok) {
    let bodyText = "";
    try { bodyText = await resp.text(); } catch (e) {}
    throw new OctopusApiError(`HTTP ${resp.status} from GraphQL endpoint: ${bodyText.slice(0, 300)}`, { status: resp.status, body: bodyText });
  }
  const data = await resp.json();
  if (data.errors) {
    throw new OctopusApiError("GraphQL error: " + data.errors.map(e => e.message).join("; "));
  }
  return data.data;
}

async function obtainKrakenToken(apiKey) {
  const query = `
    mutation ObtainKrakenToken($input: ObtainJSONWebTokenInput!) {
      obtainKrakenToken(input: $input) { token }
    }`;
  const data = await graphqlRequest(query, { input: { APIKey: apiKey } });
  return data.obtainKrakenToken.token;
}

async function fetchAccount(accountNumber) {
  return restGetRaw(`${REST_BASE}/accounts/${accountNumber}/`);
}

function getRegionLetterFromAccount(accountData, mpan) {
  for (const prop of accountData.properties || []) {
    for (const em of prop.electricity_meter_points || []) {
      if (em.mpan === mpan) {
        // The documented `gsp` field (e.g. "_C") is not reliably present
        // on real account responses — it was absent entirely in testing
        // against a live account, despite appearing in Octopus's own
        // example docs. The tariff_code on each agreement always ends in
        // a region letter (e.g. "E-1R-VAR-22-11-01-A" -> "A"), so that's
        // used as the primary source, with gsp kept as a fallback in case
        // it IS present for some accounts.
        if (em.gsp) return em.gsp.replace(/^_/, "");
        const agreements = em.agreements || [];
        for (const a of agreements) {
          const match = (a.tariff_code || "").match(/-([A-Z])$/);
          if (match) return match[1];
        }
        return "MPAN_FOUND_NO_REGION"; // distinguishes from "MPAN not found" below
      }
    }
  }
  return null;
}

function getAgreementsForMpan(accountData, mpan) {
  for (const prop of accountData.properties || []) {
    for (const em of prop.electricity_meter_points || []) {
      if (em.mpan === mpan) {
        return em.agreements || [];
      }
    }
  }
  return [];
}

function getPostcodeAreaForMpan(accountData, mpan) {
  // Returns only the OUTWARD part of the postcode (e.g. "N15" from
  // "N15 4FZ") — never the full postcode, which is far more specific
  // to an individual address. This is deliberately the coarsest useful
  // location signal for the optional results-email feature.
  for (const prop of accountData.properties || []) {
    for (const em of prop.electricity_meter_points || []) {
      if (em.mpan === mpan) {
        const postcode = (prop.postcode || "").trim();
        if (!postcode) return null;
        // UK postcodes split as "outward inward", e.g. "N15 4FZ" -> "N15".
        // If there's no space (unusual formatting), fall back to everything
        // before the last 3 characters, which is the inward code's fixed length.
        const spaceIdx = postcode.indexOf(" ");
        if (spaceIdx > 0) return postcode.slice(0, spaceIdx);
        return postcode.length > 3 ? postcode.slice(0, -3) : postcode;
      }
    }
  }
  return null;
}

async function fetchConsumption(mpan, serial, periodFrom, periodTo) {
  const path = `/electricity-meter-points/${mpan}/meters/${serial}/consumption/`;
  const results = await restGetAllPages(path, {
    period_from: periodFrom.toISOString(),
    period_to: periodTo.toISOString(),
    page_size: 25000,
    order_by: "period",
  });
  return results.map(r => ({
    start: new Date(r.interval_start),
    end: new Date(r.interval_end),
    kwh: r.consumption,
  }));
}

async function fetchProductTariffCode(productCode, regionLetter) {
  const detail = await restGetRaw(`${REST_BASE}/products/${productCode}/`);
  const regionKey = "_" + regionLetter;
  const regionTariffs = (detail.single_register_electricity_tariffs || {})[regionKey];
  if (!regionTariffs) return null;
  const tariff = regionTariffs.direct_debit_monthly || Object.values(regionTariffs)[0];
  return tariff ? tariff.code : null;
}

async function findLiveProductCodeByDisplayName(displayName) {
  // Discovers the currently-live product code rather than relying on a
  // hardcoded version string, since Octopus periodically retires and
  // replaces product codes (this happened to the email/password login
  // flow elsewhere in this build, so hardcoded identifiers are treated
  // as a liability throughout this app).
  const results = await restGetAllPages("/products/", { brand: "OCTOPUS_ENERGY", is_variable: "true" });
  const candidates = results.filter(p =>
    p.display_name === displayName && !p.is_business && !p.is_prepay
  );
  if (candidates.length === 0) return null;
  // Prefer one with no available_to (still live) if present
  const live = candidates.find(p => !p.available_to);
  return (live || candidates[0]).code;
}

async function fetchRateWindows(productCode, tariffCode, kind, periodFrom, periodTo) {
  // kind: "standard-unit-rates" or "standing-charges"
  const path = `/products/${productCode}/electricity-tariffs/${tariffCode}/${kind}/`;
  const results = await restGetAllPages(path, {
    period_from: periodFrom.toISOString(),
    period_to: periodTo.toISOString(),
    page_size: 1500,
  });
  return results
    .filter(r => r.payment_method === "DIRECT_DEBIT" || !r.payment_method)
    .map(r => ({
      validFrom: new Date(r.valid_from),
      validTo: r.valid_to ? new Date(r.valid_to) : null,
      value: r.value_inc_vat,
    }));
}

async function fetchStatements(token, accountNumber) {
  const query = `
    query Statements($accountNumber: String!, $after: String) {
      account(accountNumber: $accountNumber) {
        ledgers {
          statements(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                startAt
                endAt
                totalCharges { grossTotal }
                totalCredits { grossTotal }
              }
            }
          }
        }
      }
    }`;
  let statements = [];
  let after = null;
  let guard = 0;
  while (guard < 30) {
    const data = await graphqlRequest(query, { accountNumber, after }, token);
    let anyNext = false;
    for (const ledger of data.account.ledgers || []) {
      const stmts = ledger.statements;
      if (!stmts) continue;
      for (const edge of stmts.edges) statements.push(edge.node);
      if (stmts.pageInfo.hasNextPage) {
        anyNext = true;
        after = stmts.pageInfo.endCursor;
      }
    }
    guard++;
    if (!anyNext) break;
  }
  return statements;
}

/* ============================================================
   ORCHESTRATION
   ============================================================ */

const state = {
  apiKey: "",
  accountNumber: "",
  mpan: "",
  serial: "",
  diagnostics: null, // populated after each successful run
};

function log(message, cls = "") {
  const el = document.getElementById("progress-log");
  const line = document.createElement("div");
  line.className = "line " + cls;
  line.textContent = message;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  return line;
}

function setActiveLine(line, message, cls) {
  line.className = "line " + cls;
  line.textContent = message;
}

function setProgress(pct) {
  document.getElementById("progress-bar").style.width = pct + "%";
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function fmtMoney(pence) {
  return "£" + (pence / 100).toFixed(2);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function validateInputs() {
  let ok = true;
  const apiKey = document.getElementById("input-apikey").value.trim();
  const account = document.getElementById("input-account").value.trim();
  const mpan = document.getElementById("input-mpan").value.trim();
  const serial = document.getElementById("input-serial").value.trim();

  function setError(fieldId, errorId, isValid) {
    const field = document.getElementById(fieldId);
    const error = document.getElementById(errorId);
    if (isValid) {
      field.classList.remove("invalid");
      error.classList.remove("show");
    } else {
      field.classList.add("invalid");
      error.classList.add("show");
      ok = false;
    }
  }

  setError("input-apikey", "error-apikey", apiKey.length > 0);
  setError("input-account", "error-account", /^A-[A-Z0-9]+$/i.test(account));
  setError("input-mpan", "error-mpan", /^\d{13}$/.test(mpan));
  setError("input-serial", "error-serial", serial.length > 0);

  if (ok) {
    state.apiKey = apiKey;
    state.accountNumber = account.toUpperCase();
    state.mpan = mpan;
    state.serial = serial;
  }
  return ok;
}

async function runComparison() {
  showScreen("screen-progress");
  document.getElementById("progress-log").innerHTML = "";
  setProgress(2);

  try {
    // --- Step 1: account info, region, agreements ---
    let line = log("Fetching account details...", "active");
    const accountData = await fetchAccount(state.accountNumber);
    const regionLetter = getRegionLetterFromAccount(accountData, state.mpan);
    if (regionLetter === null) {
      throw new Error(`Could not find MPAN ${state.mpan} on account ${state.accountNumber}. Double check the MPAN matches this account.`);
    }
    if (regionLetter === "MPAN_FOUND_NO_REGION") {
      throw new Error(`Found MPAN ${state.mpan} on this account, but could not determine its region from either the meter point data or its tariff codes. This is unexpected — please check the account JSON manually.`);
    }
    setActiveLine(line, `Account verified. Region ${regionLetter}.`, "ok");
    setProgress(8);

    const agreements = getAgreementsForMpan(accountData, state.mpan);
    const currentAgreement = agreements.find(a => !a.valid_to) || agreements[agreements.length - 1];
    log(`Current tariff on this meter: ${currentAgreement ? currentAgreement.tariff_code : "unknown"}`, "ok");
    const postcodeArea = getPostcodeAreaForMpan(accountData, state.mpan);
    // --- Step 2: real billing periods + invoice totals ---
    // Fetched BEFORE the consumption window is decided, so the window can
    // be built around your actual bill dates rather than an arbitrary
    // calendar year that your bills then get clamped against.
    line = log("Authenticating to fetch your real billing periods...", "active");
    const token = await obtainKrakenToken(state.apiKey);
    setActiveLine(line, "Authenticated.", "ok");
    setProgress(15);

    line = log("Fetching statements (real bill periods + amounts)...", "active");
    const allStatements = await fetchStatements(token, state.accountNumber);
    if (allStatements.length === 0) {
      throw new Error("No statements found on this account. Your account may not have statement history available via the API.");
    }
    setActiveLine(line, `Found ${allStatements.length} statement(s) on this account.`, "ok");
    setProgress(20);

    // --- Step 3: date window, derived from real statement boundaries ---
    // Data settles a few days after the fact, and consumption typically
    // isn't available before the meter's smart-meter agreements began, so
    // the window is clamped to "now minus 7 days" at the top and to
    // roughly the last 12 months at the bottom — but the actual edges
    // come from your real statements, not a guessed calendar year.
    const dataAvailableTo = new Date();
    dataAvailableTo.setDate(dataAvailableTo.getDate() - 7);
    dataAvailableTo.setUTCHours(0, 0, 0, 0);

    const earliestApprox = new Date(dataAvailableTo);
    earliestApprox.setFullYear(earliestApprox.getFullYear() - 3); // generous ceiling: protects against an extreme edge case (a very long-standing account) without clamping a normal 1-2 year billing history, which is what caused "partial" periods previously

    const statementStarts = allStatements.map(s => new Date(s.startAt));
    const statementEnds = allStatements.map(s => new Date(s.endAt));
    const earliestStatement = new Date(Math.min(...statementStarts));
    const latestStatement = new Date(Math.max(...statementEnds));

    // periodFrom/periodTo bound the actual data we'll fetch: never later
    // than "today minus 7 days" (data needs to have settled), and reaching
    // back to whichever is later — your earliest statement, or a year ago
    // — so a long billing history doesn't balloon the half-hourly fetch.
    const periodTo = latestStatement < dataAvailableTo ? latestStatement : dataAvailableTo;
    const periodFrom = earliestStatement > earliestApprox ? earliestStatement : earliestApprox;

    log(`Comparison window: ${fmtDate(periodFrom)} to ${fmtDate(periodTo)} (aligned to your real billing history)`, "ok");
    setProgress(25);

    // --- Step 4: consumption ---
    line = log("Fetching half-hourly consumption (this is the slow part)...", "active");
    const readings = await fetchConsumption(state.mpan, state.serial, periodFrom, periodTo);
    if (readings.length === 0) {
      throw new Error("No consumption data was returned for this window. Either this meter has no smart-meter data yet, or the MPAN/serial don't match a meter with readings.");
    }
    setActiveLine(line, `Fetched ${readings.length} half-hourly readings.`, "ok");
    setProgress(40);

    // --- Step 5: gap check ---
    line = log("Checking for gaps...", "active");
    const gapInfo = detectGaps(readings);
    const totalExpectedSlots = Math.round((gapInfo.latest - gapInfo.earliest) / (30 * 60 * 1000)) + 1;
    const missingSlots = gapInfo.gaps.reduce((sum, g) => sum + Math.round((g.end - g.start) / (30*60*1000)) + 1, 0);
    setActiveLine(line, `${gapInfo.gaps.length} gap range(s), ${missingSlots} missing slots out of ${totalExpectedSlots} expected.`, gapInfo.gaps.length > 0 ? "err" : "ok");
    setProgress(45);

    // --- Step 6: turn statements into billing periods for costing ---
    // periodFrom/periodTo were built FROM these same statements above, so
    // clamping here is now just a safety net (e.g. a statement that's
    // still open-ended with no endAt yet) rather than the normal case.
    const billingPeriods = allStatements
      .filter(s => new Date(s.startAt) >= periodFrom || new Date(s.endAt) > periodFrom)
      .map(s => {
        const rawStart = new Date(s.startAt);
        const rawEnd = new Date(s.endAt);
        return {
          // displayStart/displayEnd preserve the real statement dates for
          // labeling, so the table still shows your actual bill period.
          displayStart: rawStart,
          displayEnd: rawEnd,
          // start/end are clamped to the fetched consumption window before
          // being used in any cost calculation. Without this clamp, a
          // statement whose dates extend outside the data we actually have
          // (e.g. an open-ended current bill, or any date mismatch) would
          // make calculateCost's day-by-day standing charge loop run over
          // a far wider span than intended, hugely inflating the result.
          start: rawStart < periodFrom ? periodFrom : rawStart,
          end: rawEnd > periodTo ? periodTo : rawEnd,
          actualChargePence: s.totalCharges && s.totalCharges.grossTotal != null
            ? s.totalCharges.grossTotal - (s.totalCredits && s.totalCredits.grossTotal != null ? s.totalCredits.grossTotal : 0)
            : null,
          actualChargesPence: s.totalCharges && s.totalCharges.grossTotal != null ? s.totalCharges.grossTotal : null,
          actualCreditsPence: s.totalCredits && s.totalCredits.grossTotal != null ? s.totalCredits.grossTotal : null,
        };
      })
      .filter(p => p.end > periodFrom && p.start < periodTo && p.end > p.start)
      .sort((a, b) => a.start - b.start);

    if (billingPeriods.length === 0) {
      throw new Error("No statements found covering this window. Your account may not have statement history available via the API.");
    }
    setActiveLine(line, `Found ${billingPeriods.length} billing period(s) in this window.`, "ok");
    setProgress(50);

    // --- Step 6: Flexible Octopus historical rates ---
    line = log("Discovering current Flexible Octopus product...", "active");
    const flexProductCode = await findLiveProductCodeByDisplayName("Flexible Octopus");
    if (!flexProductCode) throw new Error("Could not find a live Flexible Octopus product via the API.");
    setActiveLine(line, `Flexible Octopus product: ${flexProductCode}`, "ok");
    const flexTariffCode = await fetchProductTariffCode(flexProductCode, regionLetter);
    if (!flexTariffCode) throw new Error(`Could not find a Flexible Octopus tariff for region ${regionLetter}.`);
    line = log("Fetching Flexible Octopus historical rates...", "active");
    const flexUnitRates = await fetchRateWindows(flexProductCode, flexTariffCode, "standard-unit-rates", periodFrom, periodTo);
    const flexStandingCharges = await fetchRateWindows(flexProductCode, flexTariffCode, "standing-charges", periodFrom, periodTo);
    setActiveLine(line, `Flexible Octopus: ${flexUnitRates.length} rate window(s), ${flexStandingCharges.length} standing charge window(s).`, "ok");
    setProgress(60);

    // --- Step 7: Agile Octopus historical rates ---
    line = log("Discovering current Agile Octopus product...", "active");
    const agileProductCode = await findLiveProductCodeByDisplayName("Agile Octopus");
    let agileTariffCode = agileProductCode ? await fetchProductTariffCode(agileProductCode, regionLetter) : null;
    let agileUnitRates = [];
    let agileStandingCharges = [];
    let agileAvailable = true;
    if (!agileTariffCode) {
      agileAvailable = false;
      setActiveLine(line, "Could not resolve a live Agile Octopus tariff for this region — Agile comparison will be skipped.", "err");
    } else {
      setActiveLine(line, `Agile Octopus product: ${agileProductCode}`, "ok");
      line = log("Fetching Agile Octopus historical half-hourly rates (many calls, may take a moment)...", "active");
      try {
        agileUnitRates = await fetchRateWindows(agileProductCode, agileTariffCode, "standard-unit-rates", periodFrom, periodTo);
        agileStandingCharges = await fetchRateWindows(agileProductCode, agileTariffCode, "standing-charges", periodFrom, periodTo);
        setActiveLine(line, `Agile Octopus: ${agileUnitRates.length} rate window(s) fetched.`, "ok");
        if (agileUnitRates.length === 0) {
          agileAvailable = false;
          log("No Agile rate history returned for this window — this product may not have existed for the full comparison period. Agile comparison will be skipped.", "err");
        }
      } catch (e) {
        agileAvailable = false;
        setActiveLine(line, "Agile rate history fetch failed — Agile comparison will be skipped: " + e.message, "err");
      }
    }
    setProgress(85);

    // --- Step 8: calculate per period ---
    line = log("Calculating costs per billing period...", "active");
    const results = billingPeriods.map(period => {
      const flex = calculateCost(readings, period.start, period.end, flexUnitRates, flexStandingCharges);
      const agile = agileAvailable
        ? calculateCost(readings, period.start, period.end, agileUnitRates, agileStandingCharges)
        : null;
      const wasClamped = period.start.getTime() !== period.displayStart.getTime() || period.end.getTime() !== period.displayEnd.getTime();

      // Detect implausible actual charges — typically a short reconciliation
      // or admin statement generated at a tariff switch, not a real energy bill.
      // Strategy: compute an implied unit rate from (actual - standing charge) / kWh.
      // Anything over 150p/kWh is beyond any real tariff (Agile peak is ~100p,
      // Flexible peak is ~35p). Suspect periods are excluded from totals and
      // flagged in the table rather than silently distorting the comparison.
      let suspectActual = false;
      if (period.actualChargePence != null && flex.kwh > 0) {
        const standingApprox = agile ? agile.standingChargePence : flex.standingChargePence;
        const impliedUnitRate = (period.actualChargePence - standingApprox) / flex.kwh;
        if (impliedUnitRate > 150 || impliedUnitRate < -20) suspectActual = true;
      }

      return { period, flex, agile, wasClamped, suspectActual };
    });
    setActiveLine(line, "Done.", "ok");
    setProgress(100);

    // --- Capture diagnostics (no PII — no address, MPAN, keys, or raw readings) ---
    const rateWindowSummary = (windows, label) => {
      if (!windows || windows.length === 0) return `${label}: none fetched`;
      const sorted = [...windows].sort((a, b) => a.validFrom - b.validFrom);
      const earliest = sorted[0].validFrom;
      const lastWindow = sorted[sorted.length - 1];
      const latestStr = lastWindow.validTo ? lastWindow.validTo.toISOString().slice(0,10) : "open";
      // Check for gaps between windows
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        const prevEnd = sorted[i-1].validTo;
        if (prevEnd && sorted[i].validFrom - prevEnd > 60000) { // >1 min gap
          gaps.push(`${prevEnd.toISOString().slice(0,16)} to ${sorted[i].validFrom.toISOString().slice(0,16)}`);
        }
      }
      return `${label}: ${windows.length} window(s), ${earliest.toISOString().slice(0,10)} to ${latestStr}, values ${sorted[0].value}p to ${sorted[sorted.length-1].value}p${gaps.length ? `, GAPS: ${gaps.join('; ')}` : ', no gaps'}`;
    };

    const totalFlexUnmatched = results.reduce((s, r) => s + r.flex.unmatchedReadings, 0);
    const totalAgileUnmatched = agileAvailable ? results.reduce((s, r) => s + (r.agile ? r.agile.unmatchedReadings : 0), 0) : 0;
    const totalKwhDiag = results.reduce((s, r) => s + r.flex.kwh, 0);
    const clampedPeriods = results.filter(r => r.wasClamped).length;

    // Per-period tariff classification — needed for the diagnostic summary
    // and for computing Agile-only subtotals, same logic as renderResults.
    const diagTariffAtDate = makeTariffAtDateFn(agreements);
    const diagBillingPeriods = results.map(r => {
      const mid = new Date((r.period.start.getTime() + r.period.end.getTime()) / 2);
      const actualTariffCode = diagTariffAtDate(mid);
      const preSwitch = !!(actualTariffCode && !actualTariffCode.includes("AGILE"));
      return {
        displayPeriod: `${fmtDate(r.period.displayStart)} to ${fmtDate(r.period.displayEnd)}`,
        calculationPeriod: `${fmtDate(r.period.start)} to ${fmtDate(r.period.end)}`,
        actualTariffCode: actualTariffCode || "unknown",
        preSwitch,
        clamped: r.wasClamped,
        kwh: r.flex.kwh.toFixed(2),
        actualPence: r.period.actualChargePence != null ? r.period.actualChargePence.toFixed(0) : "n/a",
        actualChargesPence: r.period.actualChargesPence != null ? r.period.actualChargesPence.toFixed(0) : "n/a",
        actualCreditsPence: r.period.actualCreditsPence != null ? r.period.actualCreditsPence.toFixed(0) : "n/a",
        suspectActual: r.suspectActual || false,
        flexEnergyPence: r.flex.energyCostPence.toFixed(0),
        flexStandingPence: r.flex.standingChargePence.toFixed(0),
        flexTotalPence: r.flex.totalPence.toFixed(0),
        flexUnmatched: r.flex.unmatchedReadings,
        agileEnergyPence: r.agile ? r.agile.energyCostPence.toFixed(0) : "n/a",
        agileStandingPence: r.agile ? r.agile.standingChargePence.toFixed(0) : "n/a",
        agileTotalPence: r.agile ? r.agile.totalPence.toFixed(0) : "n/a",
        agileUnmatched: r.agile ? r.agile.unmatchedReadings : "n/a",
      };
    });

    // Agile-only subtotals (periods where actual bill was on Agile)
    const onAgileOnly = diagBillingPeriods.filter(p => !p.preSwitch && p.actualPence !== "n/a");
    const agileOnlyTotals = {
      periodCount: onAgileOnly.length,
      actualPence: onAgileOnly.reduce((s, p) => s + parseInt(p.actualPence), 0),
      flexTotalPence: onAgileOnly.reduce((s, p) => s + parseInt(p.flexTotalPence), 0),
      agileTotalPence: onAgileOnly.filter(p => p.agileTotalPence !== "n/a").reduce((s, p) => s + parseInt(p.agileTotalPence), 0),
    };

    state.diagnostics = {
      generatedAt: new Date().toISOString(),
      appVersion: `agile-compare v0.1.2 / github.com/AuthEnergy/agile-compare`,
      comparisonWindow: { from: periodFrom.toISOString(), to: periodTo.toISOString() },
      region: regionLetter,
      currentTariffCode: currentAgreement ? currentAgreement.tariff_code : "unknown",
      postcodeArea: postcodeArea || "not available",
      agreements: (agreements || []).map(a => ({
        tariffCode: a.tariff_code,
        validFrom: a.valid_from,
        validTo: a.valid_to || null,
      })),
      readings: {
        count: readings.length,
        earliest: gapInfo.earliest ? gapInfo.earliest.toISOString() : "none",
        latest: gapInfo.latest ? gapInfo.latest.toISOString() : "none",
        totalKwh: totalKwhDiag.toFixed(2),
        raw: readings.map(r => ({ t: r.start.toISOString(), kwh: r.kwh })),
      },
      gaps: {
        rangeCount: gapInfo.gaps.length,
        duplicateCount: gapInfo.duplicates.length,
        missingSlots: gapInfo.gaps.reduce((s, g) => s + Math.round((g.end - g.start) / (30*60*1000)) + 1, 0),
        ranges: gapInfo.gaps.map(g => `${g.start.toISOString().slice(0,16)} to ${g.end.toISOString().slice(0,16)}`),
      },
      products: {
        flexProductCode: flexProductCode || "not found",
        flexTariffCode: flexTariffCode || "not found",
        agileProductCode: agileAvailable ? (agileProductCode || "not found") : "skipped",
        agileTariffCode: agileAvailable ? (agileTariffCode || "not found") : "skipped",
      },
      rateWindows: {
        flexUnitRates: rateWindowSummary(flexUnitRates, "Flexible unit rates"),
        flexStandingCharges: rateWindowSummary(flexStandingCharges, "Flexible standing charges"),
        agileUnitRates: agileAvailable ? rateWindowSummary(agileUnitRates, "Agile unit rates") : "Agile skipped",
        agileStandingCharges: agileAvailable ? rateWindowSummary(agileStandingCharges, "Agile standing charges") : "Agile skipped",
        rawFlexUnitRates: flexUnitRates.map(w => ({ from: w.validFrom.toISOString(), to: w.validTo ? w.validTo.toISOString() : null, p: w.value })),
        rawFlexStandingCharges: flexStandingCharges.map(w => ({ from: w.validFrom.toISOString(), to: w.validTo ? w.validTo.toISOString() : null, p: w.value })),
        rawAgileUnitRates: agileAvailable ? agileUnitRates.map(w => ({ from: w.validFrom.toISOString(), to: w.validTo ? w.validTo.toISOString() : null, p: w.value })) : [],
        rawAgileStandingCharges: agileAvailable ? agileStandingCharges.map(w => ({ from: w.validFrom.toISOString(), to: w.validTo ? w.validTo.toISOString() : null, p: w.value })) : [],
      },
      billingPeriods: diagBillingPeriods,
      totals: {
        allPeriods: {
          flexUnmatchedReadings: totalFlexUnmatched,
          agileUnmatchedReadings: totalAgileUnmatched,
          clampedPeriods,
        },
        onAgileOnly: agileOnlyTotals,
      },
    };

    renderResults({ results, gapInfo, regionLetter, currentAgreement, agreements, periodFrom, periodTo, agileAvailable, postcodeArea });
    showScreen("screen-results");

  } catch (err) {
    renderError(err);
    showScreen("screen-results");
  }
}

function renderError(err) {
  const container = document.getElementById("results-content");
  let extra = "";
  if (err instanceof OctopusApiError && err.corsLikely) {
    extra = `<p>This specific failure pattern (no HTTP status, request just fails) is the signature of a CORS block: the browser is refusing to let this page read the response from api.octopus.energy. Open the browser console (F12 or Cmd+Option+J) for the exact reason &mdash; it will say something like "blocked by CORS policy" if that's what happened. If so, this tool cannot work as a pure browser page against this API unless Octopus's API sends the right CORS headers for direct browser access.</p>`;
  } else if (err instanceof OctopusApiError && err.status) {
    extra = `<p>HTTP status: ${err.status}</p><p style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);">${(err.body || "").slice(0, 400)}</p>`;
  }
  container.innerHTML = `
    <div class="error-banner">
      <div class="title">Something went wrong</div>
      <p>${err.message}</p>
      ${extra}
    </div>
  `;
}

function makeTariffAtDateFn(agreements) {
  const sorted = [...(agreements || [])].sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));
  return function tariffAtDate(date) {
    for (const a of sorted) {
      const from = new Date(a.valid_from);
      const to = a.valid_to ? new Date(a.valid_to) : null;
      if (date >= from && (!to || date < to)) return a.tariff_code;
    }
    return null;
  };
}

function renderResults({ results, gapInfo, regionLetter, currentAgreement, agreements, periodFrom, periodTo, agileAvailable, postcodeArea }) {
  const container = document.getElementById("results-content");

  // Determine which tariff was active at the midpoint of each billing
  // period, so we can flag periods where the actual bill was charged
  // on a different tariff than the one being compared.
  const tariffAtDate = makeTariffAtDateFn(agreements);

  const totalActual = results.reduce((s, r) => s + (r.flex.kwh > 0 && r.period.actualChargePence != null && !r.suspectActual ? r.period.actualChargePence : 0), 0);
  const totalFlex = results.reduce((s, r) => s + r.flex.totalPence, 0);
  const totalAgile = agileAvailable ? results.reduce((s, r) => s + (r.agile ? r.agile.totalPence : 0), 0) : null;
  const totalKwh = results.reduce((s, r) => s + r.flex.kwh, 0);

  // For the verdict and summary cards, only count periods where the user
  // was actually on Agile — mixing pre-switch Flexible bills into the
  // "actual paid" total against a calculated Agile total is misleading.
  const agileResults = results.filter(r => {
    const mid = new Date((r.period.start.getTime() + r.period.end.getTime()) / 2);
    return tariffAtDate(mid) && tariffAtDate(mid).includes("AGILE");
  });
  const hasAgileResults = agileResults.length > 0;
  const agileActual = agileResults.reduce((s, r) => s + (r.period.actualChargePence != null && !r.suspectActual ? r.period.actualChargePence : 0), 0);
  const agileFlex = agileResults.reduce((s, r) => s + r.flex.totalPence, 0);
  const agileCalc = agileAvailable ? agileResults.reduce((s, r) => s + (r.agile ? r.agile.totalPence : 0), 0) : null;
  const agileKwh = agileResults.reduce((s, r) => s + r.flex.kwh, 0);

  const hasActual = results.some(r => r.period.actualChargePence != null && !r.suspectActual);

  let gapHtml = "";

  const totalFlexUnmatched = results.reduce((s, r) => s + r.flex.unmatchedReadings, 0);
  const totalAgileUnmatched = agileAvailable ? results.reduce((s, r) => s + (r.agile ? r.agile.unmatchedReadings : 0), 0) : 0;
  let rateCoverageHtml = "";
  if (totalFlexUnmatched > 0 || totalAgileUnmatched > 0) {
    rateCoverageHtml = `
      <div class="gap-warning">
        <div class="title">Rate history didn't fully cover the comparison window</div>
        <div>${totalFlexUnmatched > 0 ? `${totalFlexUnmatched} half-hour reading(s) had no matching Flexible rate window. ` : ""}${totalAgileUnmatched > 0 ? `${totalAgileUnmatched} half-hour reading(s) had no matching Agile rate window. ` : ""}This usually means the product changed code at some point in the window and an older version's history wasn't picked up &mdash; the totals below will understate the true cost for the affected period(s).</div>
      </div>`;
  }

  if (gapInfo.gaps.length > 0) {
    const missingSlots = gapInfo.gaps.reduce((sum, g) => sum + Math.round((g.end - g.start) / (30*60*1000)) + 1, 0);
    gapHtml = `
      <div class="gap-warning">
        <div class="title">${gapInfo.gaps.length} gap${gapInfo.gaps.length > 1 ? "s" : ""} found in your consumption data (${missingSlots} missing half-hour slots)</div>
        <div>Costs below will be slightly understated for any billing period overlapping these dates, since missing slots contribute zero consumption rather than an estimate.</div>
        <ul>
          ${gapInfo.gaps.slice(0, 10).map(g => `<li>${g.start.toISOString().slice(0,16).replace("T"," ")} to ${g.end.toISOString().slice(0,16).replace("T"," ")}</li>`).join("")}
          ${gapInfo.gaps.length > 10 ? `<li>...and ${gapInfo.gaps.length - 10} more</li>` : ""}
        </ul>
      </div>`;
  }

  // Use Agile-period-only totals if we can identify them, since mixing
  // pre-switch Flexible bills into the summary gives a meaningless total.
  const useAgileOnly = hasAgileResults && agileResults.length < results.length;
  const summaryActual = useAgileOnly ? agileActual : totalActual;
  const summaryFlex = useAgileOnly ? agileFlex : totalFlex;
  const summaryAgile = useAgileOnly ? agileCalc : totalAgile;
  const summaryLabel = useAgileOnly ? `On-Agile periods only (${agileResults.length} of ${results.length})` : "Full period";

  let verdictHtml = "";
  if (hasActual && summaryAgile !== null) {
    const cheaper = summaryFlex < summaryAgile ? "Flexible" : "Agile";
    const cheaperPence = Math.abs(summaryFlex - summaryAgile);
    const scopeNote = useAgileOnly ? ` Excludes ${results.length - agileResults.length} pre-switch period(s) where your actual bill was on a different tariff.` : "";
    verdictHtml = `<div class="verdict">Over ${useAgileOnly ? "the periods you were on Agile" : "this period"}, <strong>${cheaper}</strong> would have been ${fmtMoney(cheaperPence)} cheaper than the other.${scopeNote} ${currentAgreement ? `You're currently on <strong>${currentAgreement.tariff_code}</strong>.` : ""}</div>`;
  }

  const summaryHtml = `
    <div class="summary-row">
      <div class="summary-card actual">
        <div class="label">Actual paid</div>
        <div class="value">${hasActual ? fmtMoney(summaryActual) : "n/a"}</div>
        <div class="delta">${summaryLabel}</div>
      </div>
      <div class="summary-card flexible">
        <div class="label">Flexible (calculated)</div>
        <div class="value">${fmtMoney(summaryFlex)}</div>
        <div class="delta">${hasActual ? (summaryFlex >= summaryActual ? "+" : "") + fmtMoney(summaryFlex - summaryActual) + " vs actual" : ""}</div>
      </div>
      <div class="summary-card agile">
        <div class="label">Agile (calculated)</div>
        <div class="value">${summaryAgile !== null ? fmtMoney(summaryAgile) : "n/a"}</div>
        <div class="delta">${hasActual && summaryAgile !== null ? (summaryAgile >= summaryActual ? "+" : "") + fmtMoney(summaryAgile - summaryActual) + " vs actual" : ""}</div>
      </div>
    </div>
  `;

  const rowsHtml = results.map(r => {
    const periodLabel = fmtDate(r.period.displayStart) + " to " + fmtDate(r.period.displayEnd);
    const actualStr = r.period.actualChargePence != null
      ? r.suspectActual
        ? `<span class="suspect-actual">${fmtMoney(r.period.actualChargePence)}</span>`
        : fmtMoney(r.period.actualChargePence)
      : "n/a";
    const flexStr = fmtMoney(r.flex.totalPence);
    const agileStr = r.agile ? fmtMoney(r.agile.totalPence) : "n/a";

    // What tariff was actually in force at the midpoint of this period?
    const periodMid = new Date((r.period.start.getTime() + r.period.end.getTime()) / 2);
    const actualTariff = tariffAtDate(periodMid);
    // Classify: on Agile, on Flexible, or on something else (e.g. tracker, fixed)
    const onAgile = actualTariff && actualTariff.includes("AGILE");
    const onFlex = actualTariff && (actualTariff.includes("VAR") || actualTariff.includes("FLEX"));
    const tariffFlag = !actualTariff ? "" :
      onAgile ? "" : // on Agile — actual bill IS the Agile bill, no flag needed
      onFlex ? `<span class="tariff-flag">actual on Flexible</span>` :
      `<span class="tariff-flag">actual on ${actualTariff.split("-").pop()}</span>`;

    const staleFlag = r.flex.unmatchedReadings > 0
      ? `<span class="stale-flag">${r.flex.unmatchedReadings} flex unmatched</span>`
      : "";
    const agileStaleFlag = r.agile && r.agile.unmatchedReadings > 0
      ? `<span class="stale-flag">${r.agile.unmatchedReadings} agile unmatched</span>`
      : "";
    const clampedFlag = r.wasClamped
      ? `<span class="stale-flag">partial &mdash; outside fetched data</span>`
      : "";
    const suspectFlag = r.suspectActual
      ? `<span class="stale-flag">actual excluded &mdash; likely reconciliation charge</span>`
      : "";
    return `<tr${!onAgile && actualTariff ? ' class="pre-switch"' : ''}>
      <td>${periodLabel}${tariffFlag}${staleFlag}${agileStaleFlag}${clampedFlag}${suspectFlag}</td>
      <td>${r.flex.kwh.toFixed(1)}</td>
      <td>${actualStr}</td>
      <td>${flexStr}</td>
      <td>${agileStr}</td>
    </tr>`;
  }).join("");

  const tableHtml = `
    <table class="results">
      <thead>
        <tr><th>Period</th><th>kWh</th><th>Actual</th><th>Flexible</th><th>Agile</th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr>
          <td>Total (all periods)</td>
          <td>${results.reduce((s,r)=>s+r.flex.kwh,0).toFixed(1)}</td>
          <td>${hasActual ? fmtMoney(totalActual) : "n/a"}</td>
          <td>${fmtMoney(totalFlex)}</td>
          <td>${totalAgile !== null ? fmtMoney(totalAgile) : "n/a"}</td>
        </tr>
        ${useAgileOnly ? `<tr>
          <td>Total (on-Agile periods only)</td>
          <td>${agileKwh.toFixed(1)}</td>
          <td>${fmtMoney(agileActual)}</td>
          <td>${fmtMoney(agileFlex)}</td>
          <td>${agileCalc !== null ? fmtMoney(agileCalc) : "n/a"}</td>
        </tr>` : ""}
      </tfoot>
    </table>
  `;

  const emailSubject = "Octopus Tariff Check Results";
  const emailBodyLines = [
    `Postcode area: ${postcodeArea || "not available"}`,
    `Period: ${fmtDate(periodFrom)} to ${fmtDate(periodTo)}`,
    `Total consumption: ${totalKwh.toFixed(1)} kWh`,
    `Actual paid: ${hasActual ? fmtMoney(totalActual) : "n/a"}`,
    `Flexible (calculated): ${fmtMoney(totalFlex)}`,
    `Agile (calculated): ${totalAgile !== null ? fmtMoney(totalAgile) : "n/a"}`,
  ];
  const emailBody = emailBodyLines.join("\n");
  const mailtoHref = `mailto:hello@auth.energy?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;

  // --- Share panel ---
  const shareLines = [];
  if (useAgileOnly && hasActual) {
    const saved = summaryFlex - summaryAgile;
    const vsActual = summaryAgile - summaryActual;
    const savedPct = (summaryFlex - summaryAgile) / summaryFlex * 100;
    const vsActualPct = (summaryAgile - summaryActual) / summaryActual * 100;
    shareLines.push(`I ran my Octopus usage through the auth.energy tariff checker (${fmtDate(periodFrom)} – ${fmtDate(periodTo)}, ${agileKwh.toFixed(0)} kWh):`);
    shareLines.push(``);
    if (saved > 0) {
      shareLines.push(`Agile saved me ${savedPct.toFixed(1)}% vs Flexible over this period.`);
      shareLines.push(`Calculated Agile was ${Math.abs(vsActualPct).toFixed(1)}% ${vsActualPct <= 0 ? "below" : "above"} my actual bills.`);
    } else {
      shareLines.push(`Flexible would have been ${Math.abs(savedPct).toFixed(1)}% cheaper than Agile over this period.`);
      shareLines.push(`Calculated Agile was ${Math.abs(vsActualPct).toFixed(1)}% ${vsActualPct <= 0 ? "below" : "above"} my actual bills.`);
    }
    shareLines.push(``);
    shareLines.push(`Try it: authenergy.github.io/agile-compare  #DynamicTariffCheck`);
  } else if (hasActual) {
    shareLines.push(`I ran my Octopus usage through the auth.energy tariff checker (${fmtDate(periodFrom)} – ${fmtDate(periodTo)}, ${totalKwh.toFixed(0)} kWh):`);
    shareLines.push(``);
    const cheaperAmt = totalAgile !== null ? Math.abs(totalFlex - totalAgile) : null;
    if (cheaperAmt !== null) {
      const cheaperPct = cheaperAmt / Math.max(totalFlex, totalAgile) * 100;
      shareLines.push(`${totalFlex < totalAgile ? "Flexible" : "Agile"} would have been ${cheaperPct.toFixed(1)}% cheaper over this period.`);
    }
    shareLines.push(``);
    shareLines.push(`Try it: authenergy.github.io/agile-compare  #DynamicTariffCheck`);
  }

  const shareText = shareLines.join("\n");
  const sharePanelHtml = shareLines.length > 0 ? `
    <div class="share-panel" id="share-panel">
      <div class="share-label">Share on social media</div>
      <div class="share-text" id="share-text">${shareText.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>
      <button class="copy-btn" id="btn-copy-share">Copy to clipboard</button>
    </div>
  ` : "";

  container.innerHTML = `
    ${gapHtml}
    ${rateCoverageHtml}
    ${summaryHtml}
    ${verdictHtml}
    ${sharePanelHtml}
    ${tableHtml}
    <p class="footnote">Region ${regionLetter}. Comparison window ${fmtDate(periodFrom)} to ${fmtDate(periodTo)}. Flexible and Agile costs are calculated using each tariff's real historical rates for the exact dates of each billing period, including correctly splitting any period that spans a rate change. "Actual paid" comes directly from your real statement totals where available.</p>
    <div class="actions-block">
      <div class="action-row">
        <a class="secondary" href="${mailtoHref}">Email summary</a>
        <span class="action-desc">Opens your email app with a pre-filled draft — never sends automatically. Only sends postcode area, period, total kWh, and the three totals. No API key, address, or raw data.</span>
      </div>
      <div class="action-row">
        <button class="secondary" id="btn-diagnostics">Download diagnostics</button>
        <span class="action-desc">Saves a JSON file with all rate windows, half-hourly readings, agreements history, and per-period calculations. No address, MPAN, or API key included.</span>
      </div>
      <div class="action-row">
        <button class="secondary" id="btn-restart">Run again</button>
        <span class="action-desc">Return to the input screen to run a new comparison.</span>
      </div>
    </div>
  `;

  document.getElementById("btn-diagnostics").addEventListener("click", downloadDiagnostics);
  document.getElementById("btn-restart").addEventListener("click", () => showScreen("screen-input"));
  const copyBtn = document.getElementById("btn-copy-share");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const text = document.getElementById("share-text").innerText;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy to clipboard";
          copyBtn.classList.remove("copied");
        }, 2000);
      }).catch(() => {
        // Fallback: select the text so user can copy manually
        const range = document.createRange();
        range.selectNodeContents(document.getElementById("share-text"));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      });
    });
  }
}

function downloadDiagnostics() {
  if (!state.diagnostics) return;

  const d = state.diagnostics;

  // Human-readable summary as first key — readable at a glance
  // before anyone loads the raw arrays into a tool.
  const summaryLines = [
    `Octopus Tariff Check — diagnostic export`,
    `Generated: ${d.generatedAt}`,
    ``,
    `COMPARISON WINDOW:  ${d.comparisonWindow.from.slice(0,10)} to ${d.comparisonWindow.to.slice(0,10)}`,
    `REGION:             ${d.region}`,
    `POSTCODE AREA:      ${d.postcodeArea}`,
    `CURRENT TARIFF:     ${d.currentTariffCode}`,
    ``,
    `AGREEMENTS:`,
    ...(d.agreements || []).map(a =>
      `  ${a.tariffCode}  from ${a.validFrom.slice(0,10)}${a.validTo ? ` to ${a.validTo.slice(0,10)}` : " (current)"}`
    ),
    ``,
    `READINGS:           ${d.readings.count} half-hour slots, ${d.readings.totalKwh} kWh total`,
    `                    ${d.readings.earliest.slice(0,16)} to ${d.readings.latest.slice(0,16)}`,
    ``,
    `GAPS:               ${d.gaps.rangeCount} range(s), ${d.gaps.missingSlots} missing slots`,
    ...(d.gaps.ranges.length ? d.gaps.ranges.map(r => `                    ${r}`) : [`                    none`]),
    ``,
    `PRODUCTS:`,
    `  Flexible:         ${d.products.flexProductCode} / ${d.products.flexTariffCode}`,
    `  Agile:            ${d.products.agileProductCode} / ${d.products.agileTariffCode}`,
    ``,
    `RATE WINDOWS:`,
    `  ${d.rateWindows.flexUnitRates}`,
    `  ${d.rateWindows.flexStandingCharges}`,
    `  ${d.rateWindows.agileUnitRates}`,
    `  ${d.rateWindows.agileStandingCharges}`,
    ``,
    `BILLING PERIODS:`,
    ...d.billingPeriods.map(p => {
      const creditNote = p.actualCreditsPence && p.actualCreditsPence !== "n/a" && parseInt(p.actualCreditsPence) > 0
        ? ` (charges=${p.actualChargesPence}p credits=${p.actualCreditsPence}p)`
        : "";
      return `  ${p.displayPeriod}  ${p.kwh} kWh  [${p.preSwitch ? `PRE-SWITCH on ${p.actualTariffCode}` : p.actualTariffCode}]` +
        `  actual=${p.actualPence}p${creditNote}${p.suspectActual ? " [SUSPECT]" : ""}` +
        `  flex=${p.flexTotalPence}p (energy=${p.flexEnergyPence} sc=${p.flexStandingPence} unmatched=${p.flexUnmatched})` +
        `  agile=${p.agileTotalPence}p (energy=${p.agileEnergyPence} sc=${p.agileStandingPence} unmatched=${p.agileUnmatched})` +
        (p.clamped ? `  [PARTIAL]` : ``);
    }),
    ``,
    `TOTALS (all periods):`,
    `  Flex unmatched readings:  ${d.totals.allPeriods.flexUnmatchedReadings}`,
    `  Agile unmatched readings: ${d.totals.allPeriods.agileUnmatchedReadings}`,
    `  Clamped periods:          ${d.totals.allPeriods.clampedPeriods}`,
    ``,
    `TOTALS (on-Agile periods only — ${d.totals.onAgileOnly.periodCount} periods):`,
    `  Actual paid:              ${d.totals.onAgileOnly.actualPence}p (£${(d.totals.onAgileOnly.actualPence/100).toFixed(2)})`,
    `  Flexible calculated:      ${d.totals.onAgileOnly.flexTotalPence}p (£${(d.totals.onAgileOnly.flexTotalPence/100).toFixed(2)})`,
    `  Agile calculated:         ${d.totals.onAgileOnly.agileTotalPence}p (£${(d.totals.onAgileOnly.agileTotalPence/100).toFixed(2)})`,
    `  Agile vs actual:          ${((d.totals.onAgileOnly.agileTotalPence - d.totals.onAgileOnly.actualPence)/100).toFixed(2)} (${d.totals.onAgileOnly.agileTotalPence <= d.totals.onAgileOnly.actualPence ? "calculated lower" : "calculated higher"})`,
    `  Agile vs flex:            £${((d.totals.onAgileOnly.flexTotalPence - d.totals.onAgileOnly.agileTotalPence)/100).toFixed(2)} ${d.totals.onAgileOnly.agileTotalPence <= d.totals.onAgileOnly.flexTotalPence ? "saved on Agile" : "more expensive on Agile"}`,
  ];

  const output = JSON.stringify({ _summary: summaryLines.join("\n"), ...d }, null, 2);

  const blob = new Blob([output], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `octopus-tariff-diag-${d.generatedAt.slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


module.exports = { state, validateInputs, fetchAccount, getRegionLetterFromAccount, fetchConsumption, detectGaps, findLiveProductCodeByDisplayName, fetchProductTariffCode, fetchRateWindows, calculateCost, getAgreementsForMpan, getPostcodeAreaForMpan, obtainKrakenToken, fetchStatements, runComparison, renderResults, renderError, rateAt };
