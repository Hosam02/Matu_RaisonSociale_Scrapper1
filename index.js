import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import levenshtein from "fast-levenshtein";
import config from "./config.js";
import multer from "multer";
import * as XLSX from "xlsx";
import { fetchIceData } from "./icegov.js";
import fs from "fs";
import path from "path";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/status" });

app.use(express.json());

const { username, password } = config.auth;

/* ================================================================
   CONSTANTS & LEGAL NOISE
================================================================ */
const MAX_PAGES = 3;
const PAGE_CHECKOUT_TIMEOUT_MS = 30_000; // max wait for a free page
const SESSION_REFRESH_INTERVAL = 25 * 60 * 1000;
const BROWSER_IDLE_TIMEOUT     = 30 * 60 * 1000;

const LEGAL_NOISE = new Set([
  "SOCIETE","STE","STÉ",
  "SARL","S.A.R.L","S A R L","S. A. R. L","S.A R.L","S A.R.L",
  "SA","S.A","S.A.",
  "SNC","S.N.C","S N C","S.N.C.",
  "SCS","S.C.S","S C S","S.C.S.",
  "SCA","S.C.A","S C A","S.C.A.",
  "EURL","E.U.R.L","E U R L","E.U.R.L.",
  "SC","S.C","S C","S.C.",
  "AE","A.E","A E","A.E.",
  "ABNL","A.B.N.L","A B N L","A.B.N.L.",
  "AU","A.U","A.U.",
]);
const NOISE_PATTERNS = Array.from(LEGAL_NOISE).map(
  (w) => new RegExp(`\\b${w}\\b`, "gi")
);

/* ================================================================
   PAGE POOL  — checkout / checkin pattern
   Every page has one of three states: "free" | "busy" | "dead"
================================================================ */
class PagePool {
  constructor() {
    this._slots   = [];   // [{ page, state: "free"|"busy"|"dead" }]
    this._waiters = [];   // [{ resolve, reject, timer }]
    this._lock    = false; // simple mutex for pool mutations
  }

  /** Called once after browser launch. */
  populate(pages) {
    this._slots = pages.map((page) => ({ page, state: "free" }));
  }

  /** Borrow a page. Waits up to PAGE_CHECKOUT_TIMEOUT_MS if all are busy. */
  checkout() {
    return new Promise((resolve, reject) => {
      const slot = this._slots.find((s) => s.state === "free");
      if (slot) {
        slot.state = "busy";
        return resolve(slot.page);
      }

      // No free page — queue the caller
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex((w) => w.reject === reject);
        if (idx !== -1) this._waiters.splice(idx, 1);
        reject(new Error("Timed out waiting for a free browser page"));
      }, PAGE_CHECKOUT_TIMEOUT_MS);

      this._waiters.push({ resolve, reject, timer });
    });
  }

  /** Return a page to the pool and wake the next waiter (if any). */
  checkin(page) {
    const slot = this._slots.find((s) => s.page === page);
    if (!slot) return;

    if (this._waiters.length > 0) {
      // Give the page directly to the next waiter
      const { resolve, timer } = this._waiters.shift();
      clearTimeout(timer);
      slot.state = "busy"; // stays busy for new owner
      resolve(page);
    } else {
      slot.state = "free";
    }
  }

  /** Mark a page as dead (crashed), reject its slot's waiter if any. */
  markDead(page) {
    const slot = this._slots.find((s) => s.page === page);
    if (slot) slot.state = "dead";
  }

  get size()     { return this._slots.length; }
  get freeCount(){ return this._slots.filter((s) => s.state === "free").length;  }
  get busyCount(){ return this._slots.filter((s) => s.state === "busy").length;  }
  get deadCount(){ return this._slots.filter((s) => s.state === "dead").length;  }
  get isEmpty()  { return this._slots.length === 0; }
}

const pool = new PagePool();

/* ================================================================
   BROWSER & SESSION STATE
================================================================ */
let browser       = null;
let mainPage      = null; // used only for login / verification
let inFlightCount = 0;    // number of requests currently holding a page
let lastUsed      = Date.now();

let loginStatus = {
  isLoggedIn:       false,
  status:           "disconnected", // disconnected | connecting | connected | error
  lastLoginAttempt: null,
  error:            null,
  sessionAge:       null,
  browserLaunchTime:null,
};

// Single shared recovery promise — prevents concurrent re-logins
let recoveryPromise = null;

/* ================================================================
   WEBSOCKET
================================================================ */
const wsClients = new Map();

function broadcastStatus(update = {}) {
  if (loginStatus.isLoggedIn && loginStatus.lastLoginAttempt) {
    loginStatus.sessionAge = Math.round(
      (Date.now() - new Date(loginStatus.lastLoginAttempt).getTime()) / 1000
    );
  }
  const msg = JSON.stringify({
    type: "status",
    data: {
      ...loginStatus,
      ...update,
      poolFree:  pool.freeCount,
      poolBusy:  pool.busyCount,
      inFlight:  inFlightCount,
      timestamp: new Date().toISOString(),
    },
  });
  wsClients.forEach((_, client) => {
    if (client.readyState === 1) client.send(msg);
    else if (client.readyState === 3) wsClients.delete(client);
  });
}

function updateLoginStatus(updates) {
  loginStatus = { ...loginStatus, ...updates, lastUpdated: new Date().toISOString() };
  broadcastStatus();
}

wss.on("connection", (ws, req) => {
  const clientId = Date.now() + Math.random().toString(36).substring(7);
  wsClients.set(ws, { id: clientId, ip: req.socket.remoteAddress, lastPing: Date.now() });

  ws.send(JSON.stringify({ type: "welcome", clientId, timestamp: new Date().toISOString() }));
  broadcastStatus();

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const info = wsClients.get(ws);
      if (info) { info.lastPing = Date.now(); wsClients.set(ws, info); }

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      } else if (data.type === "get_status") {
        ws.send(JSON.stringify({ type: "status", data: loginStatus }));
      } else if (data.type === "request_login") {
        ensureSession().catch((e) => updateLoginStatus({ status: "error", error: e.message }));
      }
    } catch { ws.send(JSON.stringify({ type: "error", message: "Invalid message" })); }
  });

  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
});

setInterval(() => {
  wsClients.forEach((info, client) => {
    if (client.readyState === 1) {
      if (Date.now() - info.lastPing > 30_000) client.send(JSON.stringify({ type: "ping" }));
    } else if (client.readyState === 3) wsClients.delete(client);
  });
}, 15_000);

/* ================================================================
   BROWSER LIFECYCLE
================================================================ */

/**
 * Full cold start: closes any existing browser, launches a new one,
 * populates the pool, and logs in.  Only called when truly needed.
 */
async function initializeBrowserAndLogin() {
  // Wait for in-flight requests to finish before wiping the browser
  if (inFlightCount > 0) {
    console.log(`⏳ Waiting for ${inFlightCount} in-flight request(s) before restarting browser...`);
    await waitForIdle();
  }

  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    mainPage = null;
  }
  pool.populate([]); // empty the pool while we rebuild

  console.log("🚀 Launching browser...");
  updateLoginStatus({ status: "connecting" });

  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  });

  const pages = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const p = await context.newPage();
    p.setDefaultTimeout(15_000);
    pages.push(p);
  }
  mainPage = pages[0];

  console.log("🔐 Logging in...");
  await mainPage.goto("https://www.charika.ma/accueil", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await performLogin(mainPage);

  pool.populate(pages);
  lastUsed = Date.now();

  updateLoginStatus({
    isLoggedIn:        true,
    status:            "connected",
    lastLoginAttempt:  new Date().toISOString(),
    error:             null,
    sessionAge:        0,
    browserLaunchTime: new Date().toISOString(),
  });

  console.log("✅ Browser ready with", MAX_PAGES, "pages");
  return { success: true, message: "Login successful", status: loginStatus };
}

/** Lightweight session refresh — no browser restart, just re-navigate. */
async function softRefreshSession() {
  if (!mainPage) return false;
  try {
    await mainPage.goto("https://www.charika.ma/accueil", {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });
    const isLoggedIn = await mainPage
      .locator(".user-connected, a.UserConnect-login")
      .first()
      .isVisible()
      .catch(() => false);

    if (!isLoggedIn) await performLogin(mainPage);
    loginStatus.lastLoginAttempt = new Date().toISOString();
    return true;
  } catch (err) {
    console.error("Soft refresh failed:", err.message);
    return false;
  }
}

async function performLogin(page) {
  await page.locator("a.UserConnect-login").click();
  await page.waitForTimeout(500);
  await page.locator('button.btn.btn-sm.btn-blue:has-text("Se connecter")').first().click();
  await page.waitForTimeout(500);
  const form = page.locator("#form-connexion:visible");
  await form.locator("input#username").fill(username);
  await form.locator("input#password").fill(password);
  await form.locator('button[type="submit"]:has-text("Se connecter")').click();
  await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }),
    page.waitForSelector(".user-connected, a.UserConnect-login", { timeout: 10_000 }),
    page.waitForTimeout(5_000),
  ]);
}

/** Resolve once all in-flight requests have returned their pages. */
function waitForIdle(pollMs = 200) {
  return new Promise((resolve) => {
    const id = setInterval(() => {
      if (inFlightCount === 0) { clearInterval(id); resolve(); }
    }, pollMs);
  });
}

/**
 * The single entry point for "I need a working session".
 * All concurrent callers share the SAME promise so only one
 * re-login happens at a time.
 */
async function ensureSession() {
  // Already healthy — just check session age
  if (loginStatus.isLoggedIn && !pool.isEmpty) {
    const age = Date.now() - new Date(loginStatus.lastLoginAttempt).getTime();
    if (age > SESSION_REFRESH_INTERVAL) {
      console.log("🔄 Session aging — soft refresh...");
      await softRefreshSession();
    }
    lastUsed = Date.now();
    return true;
  }

  // Need full recovery — share one promise
  if (!recoveryPromise) {
    recoveryPromise = initializeBrowserAndLogin().finally(() => {
      recoveryPromise = null;
    });
  }
  await recoveryPromise;
  return loginStatus.isLoggedIn;
}

/**
 * Borrow a page, auto-recovering the session if the pool is empty.
 * Releases the page automatically when the caller awaits the returned
 * `release()` function (or on error).
 */
async function withPage(fn) {
  // Ensure session is alive before we try to check out a page
  if (pool.isEmpty || !loginStatus.isLoggedIn) await ensureSession();

  const page = await pool.checkout();
  inFlightCount++;
  lastUsed = Date.now();

  try {
    // Quick liveness check — navigate away is too slow; just ping the JS context
    await page.evaluate(() => true, { timeout: 2_000 }).catch(async () => {
      console.warn("⚠️  Checked-out page is unresponsive, triggering recovery...");
      pool.markDead(page);
      inFlightCount--;
      await ensureSession();
      throw new Error("Page unresponsive — retrying after recovery");
    });

    return await fn(page);
  } finally {
    inFlightCount--;
    pool.checkin(page);
  }
}

/* ================================================================
   STRING UTILITIES  (unchanged from original)
================================================================ */
function normalizeString(str) {
  return str?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim() || "";
}

function cleanName(name) {
  if (!name) return "";
  let cleaned = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[.\-_/]/g, " ")
    .replace(/[^A-Z0-9\s]/g, "");
  for (const pattern of NOISE_PATTERNS) cleaned = cleaned.replace(pattern, "");
  return cleaned.replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const cleanA = cleanName(a);
  const cleanB = cleanName(b);
  const compactA = cleanA.replace(/\s+/g, "");
  const compactB = cleanB.replace(/\s+/g, "");
  const scoreNormal  = 1 - levenshtein.get(cleanA, cleanB)    / Math.max(cleanA.length, cleanB.length);
  const scoreCompact = 1 - levenshtein.get(compactA, compactB) / Math.max(compactA.length, compactB.length);
  return Math.max(scoreNormal, scoreCompact);
}

function generateSearchVariants(name) {
  const cleaned = cleanName(name);
  const words   = cleaned.split(/\s+/).filter(Boolean);
  const variants = new Set([cleaned]);

  if (words.length > 1) {
    variants.add(words.join(""));
    variants.add(words.join("."));
    variants.add(words.join("-"));
  }

  if (words.length === 1) {
    const word = words[0];
    for (let i = 2; i <= word.length - 2; i++) {
      const left = word.slice(0, i);
      const right = word.slice(i);
      if (left.length >= 2 && right.length >= 2) variants.add(`${left} ${right}`);
    }
  }
  return [...variants];
}

/* ================================================================
   SEARCH LOGIC  (page-agnostic — page is always passed in)
================================================================ */
async function safeRunSearch(page, query, normalizedCity, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await runOneSearch(page, query, normalizedCity); }
    catch (err) { if (i === retries) throw err; await sleep(400); }
  }
}

async function runOneSearch(page, query, normalizedCity) {
  await page.goto("https://www.charika.ma/accueil", {
    waitUntil: "domcontentloaded",
    timeout: 10_000,
  });

  const searchInput = await page.waitForSelector(
    'input.rq-form-element[name="sDenomination"]:visible, input[placeholder*="raison sociale"]:visible',
    { timeout: 5_000 }
  );
  await searchInput.fill("");
  await searchInput.type(query, { delay: 20 });
  await searchInput.press("Enter");
  await page.waitForURL("**/societe-rechercher**", { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});

  const results = await page.$$eval("div.text-soc", (items) =>
    items.map((item) => {
      const link = item.querySelector("h5 a");
      const addressLabels = Array.from(
        item.querySelectorAll("div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label")
      ).map((l) => l.innerText.trim());
      return { name: link?.innerText.trim() || "", href: link?.getAttribute("href") || "", address: addressLabels.join(" ") };
    })
  );

  const queryClean = cleanName(query);
  let bestMatch = { index: -1, score: 0, name: "", href: "", address: "" };

  for (let i = 0; i < results.length; i++) {
    const r     = results[i];
    const score = similarity(queryClean, cleanName(r.name));
    const cityOk = !normalizedCity || normalizeString(r.address).includes(normalizedCity);
    if (score === 1 && (!normalizedCity || cityOk)) {
      bestMatch = { index: i, score: 1, ...r };
      break;
    }
    if (score > bestMatch.score) bestMatch = { index: i, score, ...r };
  }

  return { results, bestMatch };
}

async function performSearch(companyName, city, page) {
  const normalizedCity = city ? normalizeString(city) : null;

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
  } catch {
    await page.goto("https://www.charika.ma/accueil", { waitUntil: "domcontentloaded", timeout: 15_000 });
  }

  let { results, bestMatch } = await safeRunSearch(page, companyName, normalizedCity);
  let usedQuery = companyName;
  const clean   = cleanName(companyName);

  if (bestMatch.score < 0.92 && results.length > 0) {
    for (const variant of generateSearchVariants(clean)) {
      const attempt = await safeRunSearch(page, variant, normalizedCity);
      if (attempt.bestMatch.score > bestMatch.score) {
        ({ results, bestMatch } = attempt);
        usedQuery = variant;
      }
      if (bestMatch.score >= 0.93) break;
    }
  }

  if (results.length === 0) {
    return { InputRaisonSociale: companyName, Status: "Not Found", Message: "No results found." };
  }

  if (bestMatch.score >= 0.95 && bestMatch.index !== -1) {
    await page.goto(`https://www.charika.ma/${bestMatch.href}`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });

    const info = await page.evaluate(
      ({ companyName, foundName, bestScore, usedQuery }) => {
        const result = {
          InputRaisonSociale: companyName,
          FoundRaisonSociale: foundName,
          Status:             "Found",
          MatchScore:         bestScore,
          IsExactMatch:       bestScore >= 0.95,
          UsedQuery:          usedQuery,
        };
        const table = document.querySelector("div.col-md-7 table.informations-entreprise");
        if (table) {
          table.querySelectorAll("tbody tr").forEach((row) => {
            const cells = row.querySelectorAll("td");
            if (cells.length < 2) return;
            const field = cells[0].innerText.trim();
            const value = cells[1].innerText.trim();
            if      (field.includes("RC") || field.includes("Registre")) {
              const m = value.match(/^(\d+)\s*\((.+)\)$/);
              result.RCNumber = m ? m[1] : value;
              result.RCTribunal = m ? m[2] : null;
            }
            else if (field.includes("ICE"))             result.ICE            = value;
            else if (field.includes("Forme juridique")) result.FormeJuridique = value;
            else if (field.includes("Capital"))         result.Capital        = value;
            else if (field.includes("Activite") || field.includes("Activité")) result.Activite = value;
            else if (field.includes("Adresse"))         result.Address        = value;
            else if (field.includes("Tel") || field.includes("Tél")) result.Telephone = value;
            else if (field.includes("Fax"))             result.Fax            = value;
            else if (field.includes("Email"))           result.Email          = value;
            else if (field.includes("Site web"))        result.SiteWeb        = value;
            else result[field] = value;
          });
        }
        return result;
      },
      { companyName, foundName: bestMatch.name, bestScore: bestMatch.score, usedQuery }
    );

    if (!info.Address) info.Address = bestMatch.address || "";
    if (normalizedCity && info.Address) {
      info.CityMatches = normalizeString(info.Address).includes(normalizedCity);
    }
    return info;
  }

  // --- Low score: top-3 recommendations ---
  const topResults = results.filter((r) => similarity(companyName, r.name) > 0.5).slice(0, 3);
  const recommendations = [];

  for (const result of topResults) {
    await page.goto(`https://www.charika.ma/${result.href}`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });

    const details = await page.evaluate(() => {
      const r = {};
      const h1 = document.querySelector("h1");
      if (h1) r.NomCommercial = h1.innerText.trim();
      const table = document.querySelector("div.col-md-7 table.informations-entreprise");
      if (table) {
        table.querySelectorAll("tbody tr").forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length < 2) return;
          const field = cells[0].innerText.trim();
          const value = cells[1].innerText.trim();
          if      (field.includes("RC") || field.includes("Registre")) {
            const m = value.match(/^(\d+)\s*\((.+)\)$/);
            r.RCNumber = m ? m[1] : value; r.RCTribunal = m ? m[2] : null;
          }
          else if (field.includes("ICE"))             r.ICE            = value;
          else if (field.includes("Forme juridique")) r.FormeJuridique = value;
          else if (field.includes("Capital"))         r.Capital        = value;
          else if (field.includes("Activite") || field.includes("Activité")) r.Activite = value;
          else if (field.includes("Adresse"))         r.Adresse        = value;
          else if (field.includes("Tel") || field.includes("Tél")) r.Telephone = value;
          else if (field.includes("Fax"))             r.Fax            = value;
          else if (field.includes("Email"))           r.Email          = value;
          else if (field.includes("Site web"))        r.SiteWeb        = value;
          else r[field.replace(/[^a-zA-Z0-9]/g, "")] = value;
        });
      }
      if (!r.Adresse) {
        const labels = Array.from(document.querySelectorAll(
          "div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label"
        )).map((l) => l.innerText.trim());
        if (labels.length) r.Adresse = labels.join(" ");
      }
      return r;
    });

    recommendations.push({
      name:       result.name,
      url:        `https://www.charika.ma/${result.href}`,
      position:   topResults.indexOf(result) + 1,
      matchScore: similarity(companyName, result.name),
      cityMatches: !normalizedCity || normalizeString(result.address).includes(normalizedCity),
      details:    { ...details, adresse_complete: result.address },
    });
    await sleep(300);
  }

  return {
    InputRaisonSociale: companyName,
    InputCity:          city || null,
    Status:             "Not Found - Showing Search Results",
    Message:            `No exact match. Best score: ${bestMatch.score.toFixed(2)}. Showing top ${topResults.length} result(s).`,
    BestMatchScore:     bestMatch.score,
    TotalResultsFound:  results.length,
    Recommendations:    recommendations,
  };
}

/* ================================================================
   UTILITIES
================================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractRowFields(row) {
  const keys = Object.keys(row);
  const find = (...candidates) =>
    keys.find((k) => candidates.some((c) => k.toLowerCase().trim() === c.toLowerCase()));

  const idKey   = find("idclients","id_clients","idclient","id_client","id");
  const nameKey = find("raisonsociale","raison_sociale","name","nom","company","société")
    || keys.find((k) => k !== idKey) || keys[0];
  const cityKey = find("ville","city","wilaya","region","localite","localité");

  return {
    idClients: idKey   ? row[idKey]?.toString().trim()   || "" : "",
    name:      row[nameKey]?.toString().trim()            || "",
    city:      cityKey ? row[cityKey]?.toString().trim()  || "" : "",
  };
}

function buildResultWorkbook(results) {
  const wb = XLSX.utils.book_new();
  const resultRows = [];

  for (const r of results) {
    const base = {
      IdClients:              r.input.idClients || "",
      "Input Raison Sociale": r.input.name,
      "Input City":           r.input.city || "",
    };

    if (r.error) {
      resultRows.push({ ...base, Status: "Error", "Found Raison Sociale": "", "Suggestion #": "", "Match Score": "", ICE: "", RC: "", "RC Tribunal": "", "Forme Juridique": "", Capital: "", Adresse: "", "Error / Message": r.error, "Response Time (ms)": r.responseTime || "" });
      continue;
    }

    const res = r.result;
    if (res.Status === "Found") {
      resultRows.push({ ...base, Status: "Found", "Found Raison Sociale": res.FoundRaisonSociale || "", "Suggestion #": "", "Match Score": res.MatchScore != null ? (res.MatchScore * 100).toFixed(1) + "%" : "", ICE: res.ICE || "", RC: res.RCNumber || "", "RC Tribunal": res.RCTribunal || "", "Forme Juridique": res.FormeJuridique || "", Capital: res.Capital || "", Adresse: res.Address || res.Adresse || "", "Error / Message": "", "Response Time (ms)": r.responseTime || "" });
    } else if (res.Recommendations?.length) {
      res.Recommendations.forEach((rec, j) => {
        resultRows.push({ ...base, Status: "Not Found – Suggestion", "Found Raison Sociale": rec.name || "", "Suggestion #": j + 1, "Match Score": rec.matchScore != null ? (rec.matchScore * 100).toFixed(1) + "%" : "", ICE: rec.details?.ICE || "", RC: rec.details?.RCNumber || "", "RC Tribunal": rec.details?.RCTribunal || "", "Forme Juridique": rec.details?.FormeJuridique || "", Capital: rec.details?.Capital || "", Adresse: rec.details?.Adresse || rec.details?.adresse_complete || "", "Error / Message": "", "Response Time (ms)": j === 0 ? r.responseTime || "" : "" });
      });
    } else {
      resultRows.push({ ...base, Status: res.Status || "Not Found", "Found Raison Sociale": "", "Suggestion #": "", "Match Score": "", ICE: "", RC: "", "RC Tribunal": "", "Forme Juridique": "", Capital: "", Adresse: "", "Error / Message": res.Message || "", "Response Time (ms)": r.responseTime || "" });
    }
  }

  const ws = XLSX.utils.json_to_sheet(resultRows);
  ws["!cols"] = [15,35,18,28,35,12,12,18,12,20,20,15,45,45,16].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, "Results");

  const errorRows = results.filter((r) => r.error).map((r) => ({
    IdClients: r.input.idClients || "", "Input Raison Sociale": r.input.name, "Input City": r.input.city || "", Error: r.error, "Response Time (ms)": r.responseTime || "",
  }));
  if (errorRows.length) {
    const es = XLSX.utils.json_to_sheet(errorRows);
    es["!cols"] = [15,35,18,60,16].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, es, "Errors");
  }

  return wb;
}

const RESULTS_DIR = path.resolve("./bulk-results");
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

function getNextResultFilename() {
  const existing = fs.readdirSync(RESULTS_DIR)
    .filter((f) => /^results_\d+\.xlsx$/.test(f))
    .map((f) => parseInt(f.match(/^results_(\d+)\.xlsx$/)[1], 10));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return path.join(RESULTS_DIR, `results_${next}.xlsx`);
}

/* ================================================================
   ROUTES
================================================================ */

// ── Login ──────────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  try {
    updateLoginStatus({ status: "connecting", error: null });
    const result = await initializeBrowserAndLogin();
    res.json(result);
  } catch (error) {
    console.error("Login failed:", error);
    updateLoginStatus({ isLoggedIn: false, status: "error", error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Single search ──────────────────────────────────────────────────
app.post("/api/search", async (req, res) => {
  const { name, city } = req.body;
  if (!name) return res.status(400).json({ error: "Company name is required" });

  const t0 = Date.now();

  try {
    const ok = await ensureSession();
    if (!ok) return res.status(401).json({ error: "Could not establish session. Call /api/login first." });

    // withPage handles checkout, liveness, checkin, and inFlightCount
    const result = await withPage((page) => performSearch(name, city, page));
    result.ResponseTime = Date.now() - t0;
    res.json(result);
  } catch (error) {
    console.error(`Search error for "${name}":`, error.message);
    res.status(500).json({ InputRaisonSociale: name, Status: "Error", ErrorMessage: error.message, ResponseTime: Date.now() - t0 });
  }
});

// ── Bulk search ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.includes("spreadsheetml") || file.mimetype.includes("ms-excel")
      || file.originalname.endsWith(".xlsx") || file.originalname.endsWith(".xls");
    cb(ok ? null : new Error("Only Excel files accepted"), ok);
  },
});

app.post("/api/bulk-search", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded (field name: "file").' });

  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  } catch { return res.status(400).json({ success: false, error: "Could not parse Excel file." }); }

  if (!rows.length) return res.status(400).json({ success: false, error: "Excel file is empty." });

  const ok = await ensureSession();
  if (!ok) return res.status(401).json({ success: false, error: "Not authenticated. Call /api/login first." });

  const concurrency  = Math.min(parseInt(req.query.concurrency || "1", 10), MAX_PAGES);
  const stopOnError  = req.query.stopOnError === "true";
  const outputFormat = (req.query.format || "excel").toLowerCase();

  console.log(`📊 Bulk search: ${rows.length} rows, concurrency=${concurrency}, format=${outputFormat}`);

  const results   = new Array(rows.length);
  let processed=0, found=0, notFound=0, errors=0;

  async function processRow(row, index) {
    const { idClients, name, city } = extractRowFields(row);
    if (!name) {
      results[index] = { input: { idClients, name: "", city }, error: "Empty company name – skipped", responseTime: 0 };
      errors++; processed++; return;
    }

    const t0 = Date.now();
    let lastErr;

    // Up to 3 attempts per row — auto-recovers if pool dies mid-batch
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await withPage((page) => performSearch(name, city || undefined, page));
        const responseTime = Date.now() - t0;
        results[index] = { input: { idClients, name, city }, result, responseTime };

        if (result.Status === "Found") found++;
        else notFound++;

        console.log(`  [${index+1}/${rows.length}] "${name}" → ${result.Status} (${responseTime}ms)`);
        processed++;
        return;
      } catch (err) {
        lastErr = err;
        const isPageErr = /goto|undefined|Target closed|closed|unresponsive/i.test(err.message);
        if (isPageErr && attempt < 3) {
          console.warn(`  [${index+1}] Attempt ${attempt} failed (${err.message}), retrying...`);
          await sleep(500 * attempt);
          continue;
        }
        break;
      }
    }

    const responseTime = Date.now() - t0;
    results[index] = { input: { idClients, name, city }, error: lastErr.message, responseTime };
    errors++;
    console.error(`  [${index+1}/${rows.length}] "${name}" → ERROR: ${lastErr.message}`);
    processed++;
    if (stopOnError) throw lastErr;
  }

  try {
    if (concurrency === 1) {
      for (let i = 0; i < rows.length; i++) await processRow(rows[i], i);
    } else {
      for (let i = 0; i < rows.length; i += concurrency) {
        const batch = rows.slice(i, i + concurrency).map((row, j) => processRow(row, i + j));
        await Promise.all(batch);
        await sleep(200);
      }
    }
  } catch (abortErr) {
    console.warn("⚠️  Bulk search aborted early:", abortErr.message);
  }

  const summary = { total: rows.length, processed, found, notFound, errors };
  console.log("✅ Bulk search complete —", summary);

  if (outputFormat === "json") return res.json({ success: true, summary, results });

  try {
    const wb       = buildResultWorkbook(results);
    const buffer   = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filePath = getNextResultFilename();
    fs.writeFileSync(filePath, buffer);
    console.log(`💾 Saved: ${filePath}`);
    return res.json({ success: true, summary, savedAs: path.basename(filePath), savedPath: filePath });
  } catch (xlErr) {
    console.error("Failed to save Excel output:", xlErr);
    return res.status(500).json({ success: false, error: "Search completed but Excel save failed.", summary });
  }
});

// ── ICE lookup ─────────────────────────────────────────────────────
app.post("/api/ice", async (req, res) => {
  const ice = (req.body?.ice || "").trim();
  if (!ice || !/^\d+$/.test(ice)) return res.status(400).json({ success: false, error: "ICE must be numeric" });
  try {
    const data = await fetchIceData(ice);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Session / health ───────────────────────────────────────────────
app.get("/api/session", (_req, res) => {
  if (loginStatus.isLoggedIn && loginStatus.lastLoginAttempt) {
    loginStatus.sessionAge = Math.round((Date.now() - new Date(loginStatus.lastLoginAttempt).getTime()) / 1000);
  }
  res.json({
    ...loginStatus,
    browserActive: !!browser,
    pool: { size: pool.size, free: pool.freeCount, busy: pool.busyCount, dead: pool.deadCount },
    inFlight: inFlightCount,
    wsClients: wsClients.size,
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    status:      "OK",
    browserActive: !!browser,
    loggedIn:    loginStatus.isLoggedIn,
    pool:        { size: pool.size, free: pool.freeCount, busy: pool.busyCount },
    inFlight:    inFlightCount,
    uptime:      process.uptime(),
    memory:      process.memoryUsage(),
    wsConnections: wsClients.size,
  });
});

// ── Logout ─────────────────────────────────────────────────────────
app.post("/api/logout", async (_req, res) => {
  if (inFlightCount > 0) {
    console.log(`⏳ Logout waiting for ${inFlightCount} in-flight request(s)...`);
    await waitForIdle();
  }
  if (browser) { await browser.close().catch(() => {}); browser = null; mainPage = null; }
  pool.populate([]);
  updateLoginStatus({ isLoggedIn: false, status: "disconnected", lastLoginAttempt: null, error: null, sessionAge: null, browserLaunchTime: null });
  res.json({ success: true, message: "Logged out" });
});

/* ================================================================
   IDLE BROWSER CLEANUP
================================================================ */
setInterval(async () => {
  if (browser && inFlightCount === 0 && Date.now() - lastUsed > BROWSER_IDLE_TIMEOUT) {
    console.log("🧹 Closing idle browser...");
    await browser.close().catch(() => {});
    browser = null; mainPage = null;
    pool.populate([]);
    updateLoginStatus({ isLoggedIn: false, status: "disconnected" });
  }
}, 60_000);

/* ================================================================
   START
================================================================ */
const PORT = 3005;
server.listen(PORT, () => {
  console.log(`🚀 HTTP  → http://localhost:${PORT}`);
  console.log(`📡 WS    → ws://localhost:${PORT}/status`);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  if (inFlightCount > 0) await waitForIdle();
  if (browser) await browser.close();
  wss.close();
  server.close();
  process.exit(0);
});