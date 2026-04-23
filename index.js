import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import levenshtein from "fast-levenshtein";
import config from "./config.js";
import multer from "multer";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import cors from "cors";
import { EventEmitter } from "events";
import { searchCache } from "./cache/searchCache.js";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/status" });

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CONCURRENCY = {
  MAX_BROWSER_CONTEXTS: parseInt(process.env.MAX_CONTEXTS || "25"),
  PAGES_PER_CONTEXT: parseInt(process.env.PAGES_PER_CONTEXT || "1"),
  MAX_QUEUE_SIZE: parseInt(process.env.MAX_QUEUE_SIZE || "100"),
  REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT || "30000"),
  BROWSER_IDLE_TIMEOUT: 30 * 60 * 1000,
  SESSION_REFRESH_INTERVAL: 25 * 60 * 1000,
};

const BATCH_SIZE = 50;
const PROGRESS_FILE = path.resolve("./bulk-results/progress.json");
const PARTIAL_FILE = path.resolve("./bulk-results/partial_results.xlsx");
const RESULTS_DIR = path.resolve("./bulk-results");

// ═══════════════════════════════════════════════════════════════
// LOGGING UTILITIES
// ═══════════════════════════════════════════════════════════════

function timestamp() {
  return new Date().toISOString();
}

function log(level, component, message, data = null) {
  const prefix = `[${timestamp()}] [${level.padEnd(5)}] [${component.padEnd(20)}]`;
  const dataStr = data ? ` | ${JSON.stringify(data)}` : "";
  console.log(`${prefix} ${message}${dataStr}`);
}

const LOG = {
  debug: (comp, msg, data) => log("DEBUG", comp, msg, data),
  info: (comp, msg, data) => log("INFO", comp, msg, data),
  warn: (comp, msg, data) => log("WARN", comp, msg, data),
  error: (comp, msg, data) => log("ERROR", comp, msg, data),
  search: (msg, data) => log("SEARCH", "SearchEngine", msg, data),
  session: (msg, data) => log("SESSION", "ContextManager", msg, data),
  pool: (msg, data) => log("POOL", "ContextPool", msg, data),
};

// ═══════════════════════════════════════════════════════════════
// LEGAL NOISE & UTILS
// ═══════════════════════════════════════════════════════════════
const LEGAL_NOISE = new Set([
  "SOCIETE", "STE", "STÉ", "SARL", "S.A.R.L", "S A R L", "S. A. R. L", "S.A.R.L", "S A.R.L",
  "SA", "S.A", "S A", "S.A.", "SNC", "S.N.C", "S N C", "S.N.C.", "SCS", "S.C.S", "S C S", "S.C.S.",
  "SCA", "S.C.A", "S C A", "S.C.A.", "EURL", "E.U.R.L", "E U R L", "E.U.R.L.", "SC", "S.C", "S C", "S.C.",
  "AE", "A.E", "A E", "A.E.", "ABNL", "A.B.N.L", "A B N L", "A.B.N.L.", "au", "AU", "A.U", "A.U.",
]);

const NOISE_PATTERNS = Array.from(LEGAL_NOISE).map(
  (word) => new RegExp(`\\b${word}\\b`, "gi")
);

function normalizeString(str) {
  return (
    str
      ?.normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Z0-9\s]/gi, " ")
      .replace(/\s+/g, " ")
      .toUpperCase()
      .trim() || ""
  );
}

// ═══════════════════════════════════════════════════════════════
// FIXED cleanName — handles Charika's "NAME (NAME)" duplicate format
// ═══════════════════════════════════════════════════════════════

function cleanName(name) {
  if (!name) return "";

  let cleaned = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[.\-_/]/g, " ")
    .replace(/[^A-Z0-9\s\(\)]/g, ""); // Keep () for now

  // 🔥 CRITICAL FIX: Remove parenthetical duplicates like "GOLDEN STAR (GOLDEN STAR)"
  // This is how Charika displays results — the name repeated in parentheses
  const parenMatch = cleaned.match(/^([A-Z0-9\s]+)\s*\(\s*([A-Z0-9\s]+)\s*\)$/);
  if (parenMatch) {
    const before = parenMatch[1].trim().replace(/\s+/g, " ");
    const inside = parenMatch[2].trim().replace(/\s+/g, " ");
    // If inside is same as outside (ignoring legal noise), use just the name
    const beforeClean = before.replace(/[^A-Z0-9]/g, "");
    const insideClean = inside.replace(/[^A-Z0-9]/g, "");
    if (beforeClean === insideClean || insideClean.includes(beforeClean)) {
      cleaned = before;
    }
  }

  // remove legal noise
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Merge consecutive initials
  const words = cleaned.split(/\s+/);
  const mergedWords = [];
  let i = 0;
  while (i < words.length) {
    if (words[i].length === 1 && i + 1 < words.length) {
      let initials = words[i];
      let j = i + 1;
      while (j < words.length && words[j].length === 1) {
        initials += words[j];
        j++;
      }
      mergedWords.push(initials);
      i = j;
    } else {
      mergedWords.push(words[i]);
      i++;
    }
  }

  return mergedWords.join(" ");
}
function similarity(a, b) {
  if (!a || !b) return 0;
  const cleanA = cleanName(a);
  const cleanB = cleanName(b);
  const compactA = cleanA.replace(/\s+/g, "");
  const compactB = cleanB.replace(/\s+/g, "");
  const scoreNormal =
    1 - levenshtein.get(cleanA, cleanB) / Math.max(cleanA.length, cleanB.length);
  const scoreCompact =
    1 -
    levenshtein.get(compactA, compactB) / Math.max(compactA.length, compactB.length);
  return Math.max(scoreNormal, scoreCompact);
}

function compactString(str) {
  return cleanName(str).replace(/\s+/g, "");
}

function parseRC(rcText) {
  if (!rcText) return { RCNumber: null, RCTribunal: null };

  const match = rcText.match(/^(\d+)\s*\((.+)\)$/);

  let RCNumber = match ? match[1] : rcText;
  let RCTribunal = match ? match[2] : null;

  if (isInvalidRC(RCNumber)) {
    return { RCNumber: null, RCTribunal: null };
  }

  return { RCNumber, RCTribunal };
}

function isInvalidRC(rc) {
  if (!rc) return true;

  const normalized = rc.toLowerCase();

  return (
    normalized.includes("afficher") || // "Afficher RC"
    !/^\d+$/.test(rc)                  // not numeric
  );
}
function cityMatches(address, city, rcTribunal = null) {
  if (!city) return true;
  const normalizedCity = normalizeString(city);
  const normalizedAddress = normalizeString(address || "");
  const normalizedRC = rcTribunal ? normalizeString(rcTribunal) : "";
  const tokens = normalizedCity.split(" ");
  return tokens.every(
    (t) => normalizedAddress.includes(t) || normalizedRC.includes(t)
  );
}

function generateSearchVariants(name) {
  const cleaned = cleanName(name);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const variants = new Set();
  variants.add(cleaned);
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
      if (left.length < 2 || right.length < 2) continue;
      variants.add(`${left} ${right}`);
    }
  }
  return [...variants];
}

// ═══════════════════════════════════════════════════════════════
// BROWSER CONTEXT MANAGER (with detailed session logging)
// ═══════════════════════════════════════════════════════════════

class BrowserContextManager extends EventEmitter {
  constructor(contextId) {
    super();
    this.id = contextId;
    this.browser = null;
    this.context = null;
    this.pages = [];
    this.pageIndex = 0;
    this.isLoggedIn = false;
    this.status = "disconnected";
    this.lastUsed = Date.now();
    this.lastLoginAttempt = null;
    this.error = null;
    this.lock = Promise.resolve();
    this.loginPromise = null;
    this.searchCount = 0; // Track searches per context
    LOG.session(`Context ${this.id.slice(0, 8)} created`);
  }
  async forceRelogin() {
  this.isLoggedIn = false;
  return this.initialize();
}

  async acquire() {
    let resolveLock;
    const newLock = new Promise((r) => (resolveLock = r));
    const prevLock = this.lock;
    this.lock = newLock;
    await prevLock;
    return () => resolveLock();
  }

  async initialize() {
    const release = await this.acquire();
    try {
      if (this.loginPromise) {
        LOG.session(`Deduplicating login for ${this.id.slice(0, 8)}`);
        release();
        return this.loginPromise;
      }

      LOG.session(`Starting initialization for ${this.id.slice(0, 8)}`);
      this.loginPromise = this._doInitialize();
      const result = await this.loginPromise;
      return result;
    } finally {
      release();
      this.loginPromise = null;
    }
  }

  async _doInitialize() {
    LOG.session(`Tearing down old browser for ${this.id.slice(0, 8)}`);
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.pages = [];
    }

    this.status = "connecting";
    this.emit("statusChange", this.getStatus());

    LOG.session(`Launching Chromium for ${this.id.slice(0, 8)}`);
    this.browser = await chromium.launch({
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

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });

    LOG.session(`Creating ${CONCURRENCY.PAGES_PER_CONTEXT} pages for ${this.id.slice(0, 8)}`);
    for (let i = 0; i < CONCURRENCY.PAGES_PER_CONTEXT; i++) {
      const p = await this.context.newPage();
      p.setDefaultTimeout(15000);
      this.pages.push(p);
    }

    const mainPage = this.pages[0];
    LOG.session(`Navigating to charika.ma for ${this.id.slice(0, 8)}`);
    await mainPage.goto("https://www.charika.ma/accueil", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    LOG.session(`Performing login for ${this.id.slice(0, 8)}`);
    await this._performLogin(mainPage);

    const verified = await this._verifyLogin(mainPage);
    if (!verified) {
      LOG.error("ContextManager", `Login verification FAILED for ${this.id.slice(0, 8)}`);
      throw new Error("Login verification failed");
    }

    this.isLoggedIn = true;
    this.status = "connected";
    this.lastLoginAttempt = new Date().toISOString();
    this.lastUsed = Date.now();
    this.error = null;
    this.searchCount = 0;

    LOG.session(`✅ Context ${this.id.slice(0, 8)} READY (login verified)`);
    this.emit("statusChange", this.getStatus());
    return { success: true, contextId: this.id };
  }

  async _performLogin(page) {
    LOG.session(`Clicking login button...`);
    await page.locator("a.UserConnect-login").click();
    await page.waitForTimeout(500);
    
    LOG.session(`Clicking "Se connecter"...`);
    await page
      .locator('button.btn.btn-sm.btn-blue:has-text("Se connecter")')
      .first()
      .click();
    await page.waitForTimeout(500);

    LOG.session(`Filling credentials...`);
    const loginForm = page.locator("#form-connexion:visible");
    await loginForm.locator("input#username").fill(config.auth.username);
    await loginForm.locator("input#password").fill(config.auth.password);
    
    LOG.session(`Submitting login form...`);
    await loginForm
      .locator('button[type="submit"]:has-text("Se connecter")')
      .click();

    LOG.session(`Waiting for login navigation...`);
    await Promise.race([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 10000,
      }),
      page.waitForSelector(".user-connected, a.UserConnect-login", {
        timeout: 10000,
      }),
      page.waitForTimeout(5000),
    ]);
    LOG.session(`Login navigation complete`);
  }

  async _verifyLogin(page) {
    try {
      LOG.session(`Verifying login state...`);
      await page
        .locator(".user-connected, a.UserConnect-login")
        .first()
        .isVisible()
        .catch(() => false);
      await page.goto("https://www.charika.ma/accueil", {
        waitUntil: "domcontentloaded",
        timeout: 5000,
      });
      LOG.session(`✅ Login verified`);
      return true;
    } catch (err) {
      LOG.error("ContextManager", `Login verification error: ${err.message}`);
      return false;
    }
  }

  getPage() {
    this.lastUsed = Date.now();
    this.searchCount++;
    const p = this.pages[this.pageIndex % this.pages.length];
    this.pageIndex++;
    LOG.session(`Assigning page ${this.pageIndex % this.pages.length} (search #${this.searchCount})`);
    return p;
  }

  async ensureFreshSession() {
    const now = Date.now();
    const sessionAge = this.lastLoginAttempt
      ? now - new Date(this.lastLoginAttempt).getTime()
      : Infinity;

    LOG.session(`Session age check: ${Math.round(sessionAge / 1000)}s / ${CONCURRENCY.SESSION_REFRESH_INTERVAL / 1000}s limit`);

    if (sessionAge > CONCURRENCY.SESSION_REFRESH_INTERVAL) {
      LOG.session(`⏰ Session expired (${Math.round(sessionAge / 1000)}s), refreshing...`);
      this.status = "connecting";
      this.emit("statusChange", this.getStatus());
      const refreshed = await this._refreshSession();
      this.status = refreshed ? "connected" : "error";
      this.emit("statusChange", this.getStatus());
      LOG.session(`Refresh result: ${refreshed ? "SUCCESS" : "FAILED"}`);
      return refreshed;
    }

    try {
      LOG.session(`Pinging page health...`);
      await this.pages[0].evaluate(() => document.title, { timeout: 2000 });
      this.lastUsed = now;
      LOG.session(`✅ Page responsive, session OK`);
      return true;
    } catch (err) {
      LOG.warn("ContextManager", `Page unresponsive: ${err.message}`);
      this.status = "connecting";
      this.emit("statusChange", this.getStatus());
      const refreshed = await this._refreshSession();
      this.status = refreshed ? "connected" : "error";
      this.emit("statusChange", this.getStatus());
      return refreshed;
    }
  }

  async _refreshSession() {
    try {
      if (!this.browser || !this.pages[0]) {
        LOG.error("ContextManager", "No browser/page available for refresh");
        return false;
      }
      const mainPage = this.pages[0];
      LOG.session(`Navigating to home for refresh...`);
      await mainPage.goto("https://www.charika.ma/accueil", {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
      
      LOG.session(`Checking if still logged in...`);
      const isLoggedIn = await mainPage
        .locator(".user-connected, a.UserConnect-login")
        .first()
        .isVisible()
        .catch(() => false);
      
      if (isLoggedIn) {
        LOG.session(`✅ Still logged in, updating timestamp`);
        this.lastLoginAttempt = new Date().toISOString();
        return true;
      }
      
      LOG.session(`🔐 Logged out detected, re-logging in...`);
      await this._performLogin(mainPage);
      this.lastLoginAttempt = new Date().toISOString();
      LOG.session(`✅ Re-login successful`);
      return true;
    } catch (error) {
      LOG.error("ContextManager", `Refresh failed: ${error.message}`);
      this.error = error.message;
      return false;
    }
  }

  async close() {
    const release = await this.acquire();
    try {
      LOG.session(`Closing context ${this.id.slice(0, 8)} (searches: ${this.searchCount})`);
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
      this.browser = null;
      this.context = null;
      this.pages = [];
      this.isLoggedIn = false;
      this.status = "disconnected";
      this.emit("statusChange", this.getStatus());
    } finally {
      release();
    }
  }

  getStatus() {
    const now = Date.now();
    const sessionAge = this.lastLoginAttempt
      ? Math.round((now - new Date(this.lastLoginAttempt).getTime()) / 1000)
      : null;
    return {
      contextId: this.id,
      isLoggedIn: this.isLoggedIn,
      status: this.status,
      lastLoginAttempt: this.lastLoginAttempt,
      error: this.error,
      sessionAge,
      lastUsed: this.lastUsed,
      searchCount: this.searchCount,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT POOL MANAGER (with pool logging)
// ═══════════════════════════════════════════════════════════════

class ContextPool {
  constructor() {
    this.contexts = new Map();
    this.available = new Set();
    this.waiting = [];
    this.maxContexts = CONCURRENCY.MAX_BROWSER_CONTEXTS;
    LOG.pool(`Initialized (max=${this.maxContexts})`);
  }
  async acquireContext(preferredId = null) {
  LOG.pool(`Acquire request (preferred=${preferredId ? preferredId.slice(0, 8) : "none"})`);

  // 1. If preferred context is available → use it
  if (preferredId && this.available.has(preferredId)) {
    LOG.pool(`Reusing preferred context ${preferredId.slice(0, 8)}`);
    this.available.delete(preferredId);
    return this.contexts.get(preferredId);
  }

  // 2. 🔥 NEW: reuse ANY available context
  const availableId = this.available.values().next().value;
  if (availableId) {
    LOG.pool(`♻️ Reusing idle context ${availableId.slice(0, 8)}`);
    this.available.delete(availableId);
    return this.contexts.get(availableId);
  }

  // 3. create new only if pool not full
  if (this.contexts.size < this.maxContexts) {
    const id = uuidv4();
    LOG.pool(`Creating NEW context ${id.slice(0, 8)} (${this.contexts.size + 1}/${this.maxContexts})`);
    const ctx = new BrowserContextManager(id);
    this.contexts.set(id, ctx);
    await ctx.initialize();
    return ctx;
  }
  if (this.waiting.length > MAX_QUEUE_SIZE) {
  throw new Error("Server overloaded");
}
  // 4. queue fallback unchanged
  LOG.pool(`At capacity (${this.contexts.size}/${this.maxContexts}), queueing...`);}




  releaseContext(context) {
    if (!this.contexts.has(context.id)) {
      LOG.warn("ContextPool", `Release failed: context ${context.id.slice(0, 8)} not found`);
      return;
    }

    if (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      LOG.pool(`Passing context ${context.id.slice(0, 8)} to queued request (${this.waiting.length} remaining)`);
      waiter.resolve(context);
      return;
    }

    LOG.pool(`Context ${context.id.slice(0, 8)} returned to pool (available=${this.available.size + 1})`);
    this.available.add(context.id);
  }

  removeContext(id) {
    LOG.pool(`Removing context ${id.slice(0, 8)}`);
    this.available.delete(id);
    const ctx = this.contexts.get(id);
    if (ctx) {
      ctx.close();
      this.contexts.delete(id);
    }
  }

  getStatus() {
    return {
      total: this.contexts.size,
      available: this.available.size,
      waiting: this.waiting.length,
      maxContexts: this.maxContexts,
      contexts: Array.from(this.contexts.values()).map((c) => c.getStatus()),
    };
  }

  async cleanupIdle() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, ctx] of this.contexts) {
      if (this.available.has(id) && now - ctx.lastUsed > CONCURRENCY.BROWSER_IDLE_TIMEOUT) {
        LOG.pool(`🧹 Cleaning idle context ${id.slice(0, 8)} (idle=${Math.round((now - ctx.lastUsed) / 1000)}s)`);
        this.removeContext(id);
        cleaned++;
      }
    }
    if (cleaned > 0) LOG.pool(`Cleaned ${cleaned} idle contexts`);
  }
}

const pool = new ContextPool();

// ═══════════════════════════════════════════════════════════════
// SEARCH LOGIC (with detailed step-by-step logging)
// ═══════════════════════════════════════════════════════════════

async function safeRunSearch(page, query, normalizedCity, retries = 2) {
  LOG.search(`safeRunSearch START (query="${query}", city="${normalizedCity}", retries=${retries})`);
  
  for (let i = 0; i <= retries; i++) {
    try {
      LOG.search(`Attempt ${i + 1}/${retries + 1}...`);
      const result = await runOneSearch(page, query, normalizedCity);
      LOG.search(`✅ Attempt ${i + 1} SUCCESS`);
      return result;
    } catch (err) {
      LOG.error("SearchEngine", `Attempt ${i + 1} FAILED: ${err.message}`);
      if (i === retries) {
        LOG.error("SearchEngine", `All ${retries + 1} attempts exhausted`);
        throw err;
      }
      LOG.search(`Waiting 400ms before retry...`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function runOneSearch(page, query, normalizedCity) {
  const searchId = Math.random().toString(36).substring(2, 8);
  LOG.search(`[${searchId}] runOneSearch START (query="${query}")`);

  LOG.search(`[${searchId}] Navigating to charika.ma/accueil...`);
  await page.goto("https://www.charika.ma/accueil", {
    waitUntil: "domcontentloaded",
    timeout: 10000,
  });
  LOG.search(`[${searchId}] Page loaded`);

  LOG.search(`[${searchId}] Looking for search input...`);
  const searchInput = await page.waitForSelector(
    'input.rq-form-element[name="sDenomination"]:visible, input[placeholder*="raison sociale"]:visible',
    { timeout: 5000 }
  );
  LOG.search(`[${searchId}] Search input found`);

  LOG.search(`[${searchId}] Clearing input and typing "${query}"...`);
  await searchInput.fill("");
  await searchInput.type(query, { delay: 20 });
  
  LOG.search(`[${searchId}] Pressing Enter...`);
  await searchInput.press("Enter");
  
  LOG.search(`[${searchId}] Waiting for results page...`);
  await page
    .waitForURL("**/societe-rechercher**", { timeout: 10000 })
    .catch(() => {});
  await page
    .waitForLoadState("domcontentloaded", { timeout: 10000 })
    .catch(() => {});
  LOG.search(`[${searchId}] Results page loaded`);

  LOG.search(`[${searchId}] Extracting results from DOM...`);
  const results = await page.$$eval("div.text-soc", (items) =>
    items.map((item) => {
      const link = item.querySelector("h5 a");
      const addressLabels = Array.from(
        item.querySelectorAll(
          "div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label"
        )
      ).map((l) => l.innerText.trim());
      return {
        name: link?.innerText.trim() || "",
        href: link?.getAttribute("href") || "",
        address: addressLabels.join(" "),
      };
    })
  );

  LOG.search(`[${searchId}] Found ${results.length} raw results`, {
    results: results.map((r, i) => ({ index: i, name: r.name, address: r.address.slice(0, 50) }))
  });

  const queryClean = cleanName(query);
  LOG.search(`[${searchId}] Cleaned query: "${queryClean}"`);

  let bestMatch = {
    index: -1,
    score: 0,
    name: "",
    href: "",
    address: "",
  };

  LOG.search(`[${searchId}] Scoring results...`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const score = similarity(queryClean, cleanName(r.name));
    const cityOk =
      !normalizedCity || normalizeString(r.address).includes(normalizedCity);

    LOG.search(`[${searchId}] Result ${i}: "${r.name}" score=${score.toFixed(4)} cityOk=${cityOk}`);

    if (score === 1 && (!normalizedCity || cityOk)) {
      LOG.search(`[${searchId}] 🎯 PERFECT MATCH found at index ${i}`);
      bestMatch = {
        index: i,
        score: 1,
        name: r.name,
        href: r.href,
        address: r.address,
      };
      break;
    }
    if (score > bestMatch.score) {
      bestMatch = {
        index: i,
        score,
        name: r.name,
        href: r.href,
        address: r.address,
      };
    }
  }

  LOG.search(`[${searchId}] Best match: "${bestMatch.name}" score=${bestMatch.score.toFixed(4)} index=${bestMatch.index}`);
  return { results, bestMatch };
}
async function runOneSearchFast(page, query, normalizedCity) {
  const searchId = Math.random().toString(36).substring(2, 6);
  LOG.search(`[${searchId}] FAST runOneSearch (query="${query}")`);

  // REUSE current page if already on charika — skip navigation
  const currentUrl = page.url();
  const needsNav = !currentUrl.includes('charika.ma');
  
  if (needsNav) {
    await page.goto("https://www.charika.ma/accueil", {
      waitUntil: "domcontentloaded",
      timeout: 8000,
    });
  } else {
    // Just ensure we're on accueil or search page
    await page.goto("https://www.charika.ma/accueil", {
      waitUntil: "domcontentloaded",
      timeout: 5000,
    });
  }

  const searchInput = await page.waitForSelector(
    'input.rq-form-element[name="sDenomination"]:visible, input[placeholder*="raison sociale"]:visible',
    { timeout: 3000 }
  );

  // Fast clear: triple-click + type instead of fill+type
  await searchInput.click({ clickCount: 3 });
  await searchInput.type(query, { delay: 5 }); // Faster typing

  // Wait for results WITHOUT full navigation wait
  const [response] = await Promise.all([
    page.waitForResponse(
      resp => resp.url().includes('societe-rechercher') && resp.status() === 200,
      { timeout: 8000 }
    ),
    searchInput.press("Enter"),
  ]);

  // Small wait for DOM to settle
  await page.waitForTimeout(150);

  const results = await page.$$eval("div.text-soc", (items) =>
    items.map((item) => {
      const link = item.querySelector("h5 a");
      const addressLabels = Array.from(
        item.querySelectorAll("div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label")
      ).map((l) => l.innerText.trim());
      
      // 🔥 PRE-EXTRACT: Try to get ICE/RC from listing if available
      const extraLabels = Array.from(
        item.querySelectorAll("div.col-md-4.col-sm-4.col-xs-4 label")
      ).map(l => l.innerText.trim());
      
      return {
        name: link?.innerText.trim() || "",
        href: link?.getAttribute("href") || "",
        address: addressLabels.join(" "),
        extraInfo: extraLabels.join(" "),
      };
    })
  );

  LOG.search(`[${searchId}] Found ${results.length} results`);

  const queryClean = cleanName(query);
  let bestMatch = { index: -1, score: 0, name: "", href: "", address: "" };

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // 🔥 FIX: Strip parenthetical duplicates BEFORE scoring
    const cleanResultName = cleanName(r.name);
    const score = similarity(queryClean, cleanResultName);
    const cityOk = !normalizedCity || normalizeString(r.address).includes(normalizedCity);

    LOG.search(`[${searchId}] #${i}: "${r.name}" → clean="${cleanResultName}" score=${score.toFixed(3)}`);

    if (score >= 0.92 && cityOk) {
      LOG.search(`[${searchId}] 🎯 Strong match at #${i}, stopping scan`);
      return { results, bestMatch: { index: i, score, name: r.name, href: r.href, address: r.address }, earlyExit: true };
    }
    
    if (score > bestMatch.score) {
      bestMatch = { index: i, score, name: r.name, href: r.href, address: r.address };
    }
  }

  return { results, bestMatch, earlyExit: false };
}

// ============ ADD THIS AT MODULE LEVEL (outside the function) ============
const pendingSearches = new Map(); // Deduplication cache

// ============ UPDATED performSearch ============
async function buildRecommendations(page, results, originalName, city, searchId) {
  const cacheKey = `${cleanName(originalName)}::${normalizeString(city || "")}`;

  const cached = searchCache.get(cacheKey);
  if (cached) {
    LOG.search(`[CACHE HIT] ${cacheKey}`);
    return {
      ...cached,
      cached: true,
      responseTime: 0,
    };
  }

  const topCandidates = results
    .map((r) => ({ ...r, _score: similarity(originalName, r.name) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 3);

  const recommendations = [];

  for (const candidate of topCandidates) {
    try {
      await page.goto(`https://www.charika.ma/${candidate.href}`, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });

      const details = await page.evaluate(() => {
        const res = {};
        const table = document.querySelector(
          "div.col-md-7 table.informations-entreprise"
        );

        if (table) {
          table.querySelectorAll("tbody tr").forEach((row) => {
            const cells = row.querySelectorAll("td");
            if (cells.length < 2) return;

            const field = cells[0].innerText.trim();
            const value = cells[1].innerText.trim();

            if (field.includes("RC") || field.includes("Registre")) {
              const m = value.match(/^(\d+)\s*\((.+)\)$/);
              res.RCNumber = m ? m[1] : value;
              res.RCTribunal = m ? m[2] : null;
            } else if (field.includes("ICE")) res.ICE = value;
            else if (field.includes("Forme juridique")) res.FormeJuridique = value;
            else if (field.includes("Capital")) res.Capital = value;
            else if (field.includes("Activite") || field.includes("Activité")) res.Activite = value;
            else if (field.includes("Adresse")) res.Adresse = value;
          });
        }

        return res;
      });

      recommendations.push({
        FoundRaisonSociale: candidate.name,
        name: candidate.name,
        url: `https://www.charika.ma/${candidate.href}`,
        matchScore: candidate._score,

        ICE: details.ICE || null,
        RCNumber: details.RCNumber || null,
        RCTribunal: details.RCTribunal || null,
        FormeJuridique: details.FormeJuridique || null,
        Capital: details.Capital || null,
        Activite: details.Activite || null,
        Address: details.Adresse || candidate.address || null,

        cityMatches: cityMatches(
          candidate.address || details.Adresse || "",
          city,
          details.RCTribunal
        ),
      });
    } catch (err) {
      recommendations.push({
        FoundRaisonSociale: candidate.name,
        name: candidate.name,
        url: `https://www.charika.ma/${candidate.href}`,
        matchScore: candidate._score,
        error: err.message,
      });
    }

    await page.waitForTimeout(200);
  }

  return recommendations;
}
async function performSearch(companyName, city, page, hasRetried = false) {
  const searchId = Math.random().toString(36).substring(2, 8);

  LOG.search(`═══════════════════════════════════════════════`);
  LOG.search(`[${searchId}] performSearch START`);
  LOG.search(`[${searchId}] Input: name="${companyName}", city="${city}"`);

  const normalizedCity = city ? normalizeString(city) : "";
  const cleanedName = cleanName(companyName);

  const cacheKey = `${cleanedName}::${normalizedCity}`;

  // 🧠 CACHE CHECK (skip cache if retrying to avoid caching bad RC)
  if (!hasRetried) {
    const cached = searchCache.get(cacheKey);
    if (cached) {
      LOG.search(`[CACHE HIT] ${cacheKey}`);
      return { ...cached, cached: true };
    }
  }

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    await page.goto("https://www.charika.ma/accueil", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  }

  const originalName = companyName;
  const cleanedOriginal = cleanedName;

  // ── STEP 1 ─────────────────────────────
  let { results, bestMatch } = await safeRunSearch(
    page,
    originalName,
    normalizedCity
  );

  let usedQuery = originalName;

  const exactAcronymMatch = results.find((r) => {
    const m = r.name.match(/\(([A-Z0-9\s.\-]+)\)/);
    return m && cleanName(m[1]) === cleanedOriginal;
  });

  if (exactAcronymMatch) {
    bestMatch = {
      index: results.indexOf(exactAcronymMatch),
      score: 0.98,
      name: exactAcronymMatch.name,
      href: exactAcronymMatch.href,
      address: exactAcronymMatch.address,
      RCTribunal: exactAcronymMatch.RCTribunal || null,
    };
  }

  const GOOD_MATCH_THRESHOLD = 0.85;

  // ── STEP 2: FOUND ─────────────────────────────
  if (bestMatch?.score >= GOOD_MATCH_THRESHOLD && bestMatch.index !== -1) {
    await page.goto(`https://www.charika.ma/${bestMatch.href}`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    const info = await page.evaluate(
      ({ companyName, foundName, bestScore, usedQuery }) => {
        const result = {
          InputRaisonSociale: companyName,
          FoundRaisonSociale: foundName,
          Status: "Found",
          MatchScore: bestScore,
          UsedQuery: usedQuery,
        };

        const normalize = (t) =>
          t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        const isInvalidRC = (rc) => {
          if (!rc) return true;
          const n = rc.toLowerCase();
          return n.includes("afficher") || !/^\d+$/.test(rc);
        };

        const table = document.querySelector(
          "div.col-md-7 table.informations-entreprise"
        );

        if (table) {
          table.querySelectorAll("tbody tr").forEach((row) => {
            const cells = row.querySelectorAll("td");
            if (cells.length < 2) return;

            const field = normalize(cells[0].innerText.trim());
            const value = cells[1].innerText.trim();

            if (field.includes("rc") || field.includes("registre")) {
              const m = value.match(/^(\d+)\s*\((.+)\)$/);
              let rcNumber = m ? m[1] : value;
              let rcTribunal = m ? m[2] : null;

              if (isInvalidRC(rcNumber)) {
                rcNumber = null;
                rcTribunal = null;
              }

              result.RCNumber = rcNumber;
              result.RCTribunal = rcTribunal;
            } else if (field.includes("ice")) {
              result.ICE = value;
            } else if (field.includes("forme juridique")) {
              result.FormeJuridique = value;
            } else if (field.includes("capital")) {
              result.Capital = value;
            } else if (field.includes("activite")) {
              result.Activite = value;
            } else if (field.includes("tel")) {
              result.Telephone = value;
            } else if (field.includes("fax")) {
              result.Fax = value;
            } else if (field.includes("email")) {
              result.Email = value;
            } else if (field.includes("site web")) {
              result.SiteWeb = value;
            }
          });
        }

        const addressBlocks = Array.from(
          document.querySelectorAll("div.row.ligne-tfmw")
        );

        for (const block of addressBlocks) {
          const label = block.querySelector("b");
          const value = block.querySelector("label");

          if (!label || !value) continue;

          const labelText = normalize(label.innerText);

          if (labelText.includes("adresse")) {
            result.Address = value.innerText.trim();
            break;
          }
        }

        if (!result.Address) {
          const labels = Array.from(document.querySelectorAll("label")).map((l) =>
            l.innerText.trim()
          );
          const maybe = labels.find((l) => l.match(/\d{3,}/));
          if (maybe) result.Address = maybe;
        }

        if (!result.Address) {
          const match = document.body.innerText.match(
            /Adresse\s*[:\-]?\s*(.+)/i
          );
          if (match) {
            result.Address = match[1].split("\n")[0].trim();
          }
        }

        return result;
      },
      {
        companyName: originalName,
        foundName: bestMatch.name,
        bestScore: bestMatch.score,
        usedQuery,
      }
    );

    // 🚨 GLOBAL RC VALIDATION (outside browser)
    if (!info.RCNumber) {
      if (hasRetried) {
        LOG.warn(`[${searchId}] RC still invalid after retry`);
        return info;
      }

      LOG.warn(`[${searchId}] Invalid RC → forcing relogin & retry`);

      await ctx.forceRelogin();

      await page.goto("https://www.charika.ma/accueil", {
        waitUntil: "domcontentloaded",
      });

      return await performSearch(companyName, city, page, true);
    }

    // ── CITY CHECK ─────────────────────────────
    if (!cityMatches(info.Address, city, info.RCTribunal)) {
      const recommendations = await buildRecommendations(
        page,
        results,
        originalName,
        city,
        searchId
      );

      const cityMismatchResponse = {
        InputRaisonSociale: originalName,
        InputCity: city,
        Status: "Not Found - City Mismatch",
        Message: `Best match found (${bestMatch.name}) but city does not match.`,
        BestMatchScore: bestMatch.score,
        FoundRaisonSociale: bestMatch.name,
        Recommendations: recommendations,
      };

      searchCache.set(cacheKey, cityMismatchResponse);
      return cityMismatchResponse;
    }

    const finalInfo = { ...info, cached: false };
    searchCache.set(cacheKey, finalInfo);
    return finalInfo;
  }

  // ── STEP 3: NOT FOUND ─────────────────────────────
  const recommendations = await buildRecommendations(
    page,
    results,
    originalName,
    city,
    searchId
  );

  const response = {
    InputRaisonSociale: originalName,
    InputCity: city || null,
    Status: "Not Found - Showing Search Results",
    Message: `No exact match found. Showing top ${recommendations.length} results.`,
    BestMatchScore: bestMatch?.score ?? 0,
    TotalResultsFound: results.length,
    Recommendations: recommendations,
  };

  searchCache.set(cacheKey, response);
  return response;
}
// ============ ADD THIS WRAPPER IN YOUR API HANDLER ============
async function dedupedSearch(companyName, city, page) {
  const key = `${cleanName(companyName)}|${city ? normalizeString(city) : 'null'}`;
  
  // If same search is in flight, wait for it
  if (pendingSearches.has(key)) {
    LOG.search(`[DEDUP] Reusing in-flight search for "${companyName}"`);
    return pendingSearches.get(key);
  }
  
  // Create the search promise
  const searchPromise = performSearch(companyName, city, page)
    .finally(() => {
      pendingSearches.delete(key);
      LOG.search(`[DEDUP] Cleared pending search for "${companyName}"`);
    });
  
  pendingSearches.set(key, searchPromise);
  return searchPromise;
}
// ═══════════════════════════════════════════════════════════════
// BULK SEARCH UTILS
// ═══════════════════════════════════════════════════════════════

function saveProgress(results, lastIndex) {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify({
      lastIndex,
      results,
    })
  );
}

function loadProgress(defaultLength) {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return {
      startIndex: 0,
      results: new Array(defaultLength),
    };
  }
  const saved = JSON.parse(fs.readFileSync(PROGRESS_FILE));
  return {
    startIndex: saved.lastIndex || 0,
    results: saved.results || new Array(defaultLength),
  };
}

function savePartialExcel(results) {
  try {
    const wb = buildResultWorkbook(results);
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    fs.writeFileSync(PARTIAL_FILE, buffer);
    LOG.info("BulkProcessor", "Partial Excel saved");
  } catch (err) {
    LOG.error("BulkProcessor", `Partial save failed: ${err.message}`);
  }
}

function extractRowFields(row) {
  const keys = Object.keys(row);
  const find = (...candidates) =>
    keys.find((k) =>
      candidates.some((c) => k.toLowerCase().trim() === c.toLowerCase())
    );

  const idKey = find(
    "idclients",
    "id_clients",
    "idclient",
    "id_client",
    "id"
  );
  const nameKey =
    find(
      "raisonsociale",
      "raison_sociale",
      "name",
      "nom",
      "company",
      "société"
    ) ||
    keys.find((k) => k !== idKey) ||
    keys[0];
  const cityKey = find("ville", "city", "wilaya", "region", "localite", "localité");

  return {
    idClients: idKey ? row[idKey]?.toString().trim() || "" : "",
    name: row[nameKey]?.toString().trim() || "",
    city: cityKey ? row[cityKey]?.toString().trim() || "" : "",
  };
}

function buildResultWorkbook(results) {
  const wb = XLSX.utils.book_new();
  const resultRows = [];

  for (const r of results) {
    const base = {
      IdClients: r.input.idClients || "",
      "Input Raison Sociale": r.input.name,
      "Input City": r.input.city || "",
    };

    if (r.error) {
      resultRows.push({
        ...base,
        Status: "Error",
        "Found Raison Sociale": "",
        "Suggestion #": "",
        "Match Score": "",
        ICE: "",
        RC: "",
        "RC Tribunal": "",
        "Forme Juridique": "",
        Capital: "",
        Adresse: "",
        "Error / Message": r.error,
        "Response Time (ms)": r.responseTime || "",
      });
      continue;
    }

    const res = r.result;

    if (res.Status === "Found") {
      resultRows.push({
        ...base,
        Status: "Found",
        "Found Raison Sociale": res.FoundRaisonSociale || "",
        "Suggestion #": "",
        "Match Score":
          res.MatchScore != null
            ? (res.MatchScore * 100).toFixed(1) + "%"
            : "",
        ICE: res.ICE || "",
        RC: res.RCNumber || "",
        "RC Tribunal": res.RCTribunal || "",
        "Forme Juridique": res.FormeJuridique || "",
        Capital: res.Capital || "",
        Adresse: res.Address || res.Adresse || "",
        "Error / Message": "",
        "Response Time (ms)": r.responseTime || "",
      });
    } else if (res.Recommendations?.length) {
      res.Recommendations.forEach((rec, j) => {
        resultRows.push({
          ...base,
          Status: "Not Found – Suggestion",
          "Found Raison Sociale": rec.name || "",
          "Suggestion #": j + 1,
          "Match Score":
            rec.matchScore != null
              ? (rec.matchScore * 100).toFixed(1) + "%"
              : "",
          ICE: rec.details?.ICE || "",
          RC: rec.details?.RCNumber || "",
          "RC Tribunal": rec.details?.RCTribunal || "",
          "Forme Juridique": rec.details?.FormeJuridique || "",
          Capital: rec.details?.Capital || "",
          Adresse:
            rec.details?.Adresse || rec.details?.adresse_complete || "",
          "Error / Message": "",
          "Response Time (ms)": j === 0 ? r.responseTime || "" : "",
        });
      });
    } else {
      resultRows.push({
        ...base,
        Status: res.Status || "Not Found",
        "Found Raison Sociale": "",
        "Suggestion #": "",
        "Match Score": "",
        ICE: "",
        RC: "",
        "RC Tribunal": "",
        "Forme Juridique": "",
        Capital: "",
        Adresse: "",
        "Error / Message": res.Message || "",
        "Response Time (ms)": r.responseTime || "",
      });
    }
  }

  const resultSheet = XLSX.utils.json_to_sheet(resultRows);
  resultSheet["!cols"] = [
    { wch: 15 },
    { wch: 35 },
    { wch: 18 },
    { wch: 28 },
    { wch: 35 },
    { wch: 12 },
    { wch: 12 },
    { wch: 18 },
    { wch: 12 },
    { wch: 20 },
    { wch: 20 },
    { wch: 15 },
    { wch: 45 },
    { wch: 45 },
    { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, resultSheet, "Results");

  const errorRows = results
    .filter((r) => r.error)
    .map((r) => ({
      IdClients: r.input.idClients || "",
      "Input Raison Sociale": r.input.name,
      "Input City": r.input.city || "",
      Error: r.error,
      "Response Time (ms)": r.responseTime || "",
    }));

  if (errorRows.length) {
    const errSheet = XLSX.utils.json_to_sheet(errorRows);
    errSheet["!cols"] = [{ wch: 15 }, { wch: 35 }, { wch: 18 }, { wch: 60 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, errSheet, "Errors");
  }

  return wb;
}

function getNextResultFilename() {
  const existing = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => /^results_\d+\.xlsx$/.test(f))
    .map((f) => parseInt(f.match(/^results_(\d+)\.xlsx$/)[1], 10));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return path.join(RESULTS_DIR, `results_${next}.xlsx`);
}

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE & SETUP
// ═══════════════════════════════════════════════════════════════

app.use(
  cors({
    origin: "http://localhost:3005",
    credentials: true,
  })
);

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.endsWith(".xlsx") ||
      file.originalname.endsWith(".xls");
    cb(ok ? null : new Error("Only Excel files (.xlsx / .xls) are accepted"), ok);
  },
});

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

const jobs = {};

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════

const wsClients = new Map();

function broadcastStatus(update = {}) {
  const statusUpdate = {
    type: "status",
    data: {
      pool: pool.getStatus(),
      ...update,
      timestamp: new Date().toISOString(),
    },
  };
  const message = JSON.stringify(statusUpdate);
  wsClients.forEach((clientInfo, client) => {
    if (client.readyState === 1) {
      client.send(message);
    } else if (client.readyState === 3) {
      wsClients.delete(client);
    }
  });
}

wss.on("connection", (ws, req) => {
  const clientId = Date.now() + Math.random().toString(36).substring(7);
  const clientIp = req.socket.remoteAddress;

  wsClients.set(ws, {
    id: clientId,
    ip: clientIp,
    connectedAt: new Date().toISOString(),
    lastPing: Date.now(),
  });

  ws.send(
    JSON.stringify({
      type: "welcome",
      clientId,
      message: "Connected to Charika API WebSocket",
      timestamp: new Date().toISOString(),
    })
  );

  broadcastStatus();

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      const clientInfo = wsClients.get(ws);
      if (clientInfo) {
        clientInfo.lastPing = Date.now();
        wsClients.set(ws, clientInfo);
      }

      switch (data.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          break;
        case "get_status":
          ws.send(
            JSON.stringify({
              type: "status",
              data: { pool: pool.getStatus() },
            })
          );
          break;
        default:
          ws.send(JSON.stringify({ type: "error", message: "Unknown command" }));
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  });

  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
});

// ═══════════════════════════════════════════════════════════════
// API ENDPOINTS (with endpoint logging)
// ═══════════════════════════════════════════════════════════════

app.get("/api/health", (req, res) => {
  LOG.info("API", "Health check");
  res.json({
    status: "OK",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    pool: pool.getStatus(),
    wsConnections: wsClients.size,
  });
});

app.get("/api/session", (req, res) => {
  LOG.info("API", "Session status requested");
  res.json({
    pool: pool.getStatus(),
    wsClients: wsClients.size,
  });
});

app.post("/api/login", async (req, res) => {
  LOG.info("API", "Login endpoint called");
  try {
    const context = await pool.acquireContext();
    LOG.info("API", `Login success: ${context.id.slice(0, 8)}`);
    res.json({
      success: true,
      contextId: context.id,
      status: context.getStatus(),
    });
  } catch (error) {
    LOG.error("API", `Login failed: ${error.message}`);
    res.status(503).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/api/logout", async (req, res) => {
  const { contextId } = req.body;
  LOG.info("API", `Logout called for ${contextId?.slice(0, 8)}`);
  
  if (!contextId) {
    return res.status(400).json({ error: "contextId required" });
  }

  const ctx = pool.contexts.get(contextId);
  if (ctx) {
    await pool.removeContext(contextId);
    res.json({ success: true, message: "Context closed" });
  } else {
    res.status(404).json({ error: "Context not found" });
  }
});

app.post("/api/search", async (req, res) => {
  const { name, city, contextId } = req.body;
  const requestId = Math.random().toString(36).substring(2, 8);
  
  LOG.info("API", `[${requestId}] /api/search called: name="${name}", city="${city}", contextId=${contextId ? contextId.slice(0, 8) : "auto"}`);

  if (!name) {
    LOG.warn("API", `[${requestId}] Missing name parameter`);
    return res.status(400).json({
      error: "Company name is required",
      InputRaisonSociale: null,
      Status: "Error",
    });
  }

  const startTime = Date.now();
  let ctx = null;
  let acquiredHere = false;

  try {
    if (contextId && pool.contexts.has(contextId)) {
      ctx = pool.contexts.get(contextId);
      if (pool.available.has(contextId)) {
        pool.available.delete(contextId);
        acquiredHere = true;
      }
      LOG.info("API", `[${requestId}] Using sticky context ${ctx.id.slice(0, 8)}`);
    } else {
      LOG.info("API", `[${requestId}] Acquiring context from pool...`);
      ctx = await pool.acquireContext();
      acquiredHere = true;
      LOG.info("API", `[${requestId}] Acquired context ${ctx.id.slice(0, 8)}`);
    }

    LOG.info("API", `[${requestId}] Ensuring fresh session...`);
    const sessionOk = await ctx.ensureFreshSession();
    if (!sessionOk) {
      LOG.info("API", `[${requestId}] Session stale, reinitializing...`);
      await ctx.initialize();
    }

    const page = ctx.getPage();
    LOG.info("API", `[${requestId}] Starting search on page...`);
    
    const result = await performSearch(name, city, page);

    if (result === "SESSION_EXPIRED") {
      LOG.warn("API", `[${requestId}] SESSION_EXPIRED returned, reinitializing...`);
      await ctx.initialize();
      const retryPage = ctx.getPage();
      LOG.info("API", `[${requestId}] Retrying search after reinit...`);
      const retryResult = await performSearch(name, city, retryPage);
      retryResult.ResponseTime = Date.now() - startTime;
      LOG.info("API", `[${requestId}] Retry successful, total time=${retryResult.ResponseTime}ms`);
      res.json(retryResult);
      return;
    }

    result.ResponseTime = Date.now() - startTime;
    LOG.info("API", `[${requestId}] Search complete: Status=${result.Status}, time=${result.ResponseTime}ms`);
    res.json(result);
  } catch (error) {
    LOG.error("API", `[${requestId}] Search error: ${error.message}`);
    
    if (error.message.includes("SESSION_EXPIRED")) {
      if (ctx) await ctx.initialize().catch(() => {});
    }

    res.status(500).json({
      InputRaisonSociale: name,
      Status: "Error",
      ErrorMessage: error.message,
      ResponseTime: Date.now() - startTime,
    });
  } finally {
    if (acquiredHere && ctx) {
      LOG.info("API", `[${requestId}] Releasing context ${ctx.id.slice(0, 8)} back to pool`);
      pool.releaseContext(ctx);
    }
  }
});

app.post("/api/debug-search", async (req, res) => {
  const { name, city } = req.body;
  const requestId = Math.random().toString(36).substring(2, 8);
  
  LOG.info("API", `[${requestId}] /api/debug-search called: name="${name}"`);

  if (!name) return res.status(400).json({ error: "name is required" });

  let ctx = null;
  let acquiredHere = false;

  try {
    ctx = await pool.acquireContext();
    acquiredHere = true;

    const isLoggedIn = await ctx.ensureFreshSession();
    if (!isLoggedIn) await ctx.initialize();

    const page = ctx.getPage();
    const log = [];
    const warn = [];

    log.push("Navigating to charika.ma...");
    await page.goto("https://www.charika.ma/accueil", {
      waitUntil: "domcontentloaded",
      timeout: 8000,
    });

    const searchInput = await page.waitForSelector(
      'input.rq-form-element[name="sDenomination"]:visible, input[placeholder*="raison sociale"]:visible',
      { timeout: 5000 }
    );
    await searchInput.fill("");
    await searchInput.type(name, { delay: 20 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }),
      searchInput.press("Enter"),
    ]);

    log.push(`Search submitted for: "${name}"`);

    const searchResults = await page.$$eval("div.text-soc", (items) =>
      items.map((item) => {
        const link = item.querySelector("h5 a");
        const addressLabels = Array.from(
          item.querySelectorAll(
            "div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label"
          )
        ).map((l) => l.innerText.trim());
        return {
          name: link?.innerText.trim() || "",
          href: link?.getAttribute("href") || "",
          address: addressLabels.join(" "),
        };
      })
    );

    log.push(`Found ${searchResults.length} result(s) on search page`);

    if (searchResults.length === 0) {
      return res.json({ log, warn, searchResults: [], detail: null });
    }

    const companyClean = cleanName(name);
    const normalizedCity = city ? normalizeString(city) : null;

    let bestMatch = { index: -1, score: 0, name: "", href: "", address: "" };
    const scored = searchResults.map((r, i) => {
      const score = similarity(companyClean, cleanName(r.name));
      const cityOk =
        !normalizedCity || normalizeString(r.address).includes(normalizedCity);
      if (score > bestMatch.score) {
        bestMatch = {
          index: i,
          score,
          name: r.name,
          href: r.href,
          address: r.address,
        };
      }
      return { ...r, score: +score.toFixed(4), cityOk };
    });

    log.push(`Best match: "${bestMatch.name}" — score ${bestMatch.score.toFixed(4)}`);

    if (bestMatch.score < 0.8) {
      warn.push(
        `Score ${bestMatch.score.toFixed(4)} is below 0.8 - would NOT be treated as Found`
      );
    }

    const detailUrl = `https://www.charika.ma/${bestMatch.href}`;
    log.push(`Navigating to detail page: ${detailUrl}`);

    await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    const domDiag = await page.evaluate(() => {
      const table = document.querySelector(
        "div.col-md-7 table.informations-entreprise"
      );
      return {
        pageTitle: document.title,
        h1Text: document.querySelector("h1")?.innerText.trim() || null,
        tableFound: !!table,
        tableRows: table
          ? Array.from(table.querySelectorAll("tbody tr")).map((row) => {
              const cells = row.querySelectorAll("td");
              return {
                field: cells[0]?.innerText.trim() || "",
                value: cells[1]?.innerText.trim() || "",
              };
            })
          : [],
        altAddress1: Array.from(
          document.querySelectorAll(
            "div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label"
          )
        ).map((l) => l.innerText.trim()),
      };
    });

    res.json({
      input: { name, city: city || null },
      bestMatch: {
        name: bestMatch.name,
        href: bestMatch.href,
        score: bestMatch.score,
        addressFromListing: bestMatch.address,
      },
      scoredResults: scored,
      log,
      warnings: warn,
      domDiagnostic: domDiag,
      detailUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (acquiredHere && ctx) pool.releaseContext(ctx);
  }
});

app.post("/api/bulk-search", upload.single("file"), async (req, res) => {
  const requestId = Math.random().toString(36).substring(2, 8);
  LOG.info("API", `[${requestId}] /api/bulk-search called`);

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'No file uploaded. Use "file" field.',
    });
  }

  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    LOG.info("API", `[${requestId}] Parsed ${rows.length} rows from Excel`);
  } catch {
    return res.status(400).json({ success: false, error: "Invalid Excel file." });
  }

  if (!rows.length) {
    return res.status(400).json({ success: false, error: "Empty file." });
  }

  const jobId = uuidv4();
  jobs[jobId] = {
    status: "running",
    processed: 0,
    total: rows.length,
    summary: null,
    resultFile: null,
    errors: 0,
    found: 0,
    notFound: 0,
    retries: 0,
    failedRows: [],
    createdAt: new Date().toISOString(),
  };

  LOG.info("API", `[${requestId}] Bulk job ${jobId.slice(0, 8)} started (${rows.length} rows)`);
  res.json({ success: true, jobId, message: "Bulk job started" });

  (async () => {
    let ctx = null;

    try {
      ctx = await pool.acquireContext();
      LOG.info("BulkProcessor", `[${jobId.slice(0, 8)}] Acquired context ${ctx.id.slice(0, 8)}`);
      
      const { startIndex, results } = loadProgress(rows.length);
      const concurrency = Math.min(
        parseInt(req.query.concurrency || "2"),
        CONCURRENCY.PAGES_PER_CONTEXT
      );
      const MAX_RETRIES = 3;
      const retryQueue = [];

      LOG.info("BulkProcessor", `[${jobId.slice(0, 8)}] Starting from index ${startIndex}, concurrency=${concurrency}`);

      for (let i = startIndex; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        LOG.info("BulkProcessor", `[${jobId.slice(0, 8)}] Processing batch ${i}-${Math.min(i + BATCH_SIZE, rows.length)}`);

        let sessionValid = await ctx.ensureFreshSession();
        if (!sessionValid) {
          LOG.info("BulkProcessor", `[${jobId.slice(0, 8)}] Session stale, reinitializing...`);
          await ctx.initialize();
        }

        for (let j = 0; j < batch.length; j += concurrency) {
          const subBatch = batch.slice(j, j + concurrency);
          LOG.info("BulkProcessor", `[${jobId.slice(0, 8)}] Sub-batch ${j}-${j + subBatch.length} (${subBatch.length} items)`);

          await Promise.all(
            subBatch.map(async (row, k) => {
              const index = i + j + k;
              let retries = 0;

              const processWithRetry = async () => {
                const { idClients, name, city } = extractRowFields(row);

                if (!results[index])
                  results[index] = {
                    input: { idClients, name, city },
                    result: null,
                    responseTime: 0,
                  };

                if (!name) {
                  results[index] = {
                    input: { idClients, name: "", city },
                    result: { Status: "Error", Message: "Empty name" },
                    responseTime: 0,
                  };
                  jobs[jobId].errors++;
                  jobs[jobId].processed++;
                  return;
                }

                const t0 = Date.now();
                try {
                  const isLoggedIn = await ctx.ensureFreshSession();
                  if (!isLoggedIn) await ctx.initialize();

                  const localPage = ctx.getPage();
                  let result = await performSearch(
                    name,
                    city || undefined,
                    localPage
                  );

                  if (
                    result.Recommendations &&
                    Array.isArray(result.Recommendations) &&
                    result.Recommendations.length > 0
                  ) {
                    const best = result.Recommendations.reduce(
                      (max, r) =>
                        r.matchScore > (max.matchScore || 0) ? r : max,
                      {}
                    );
                    result.Recommendations = [best];
                  }

                  const responseTime = Date.now() - t0;
                  results[index] = {
                    input: { idClients, name, city },
                    result,
                    responseTime,
                  };

                  if (result.Status === "Found") jobs[jobId].found++;
                  else jobs[jobId].notFound++;

                  jobs[jobId].processed++;
                  saveProgress(results, index);
                } catch (err) {
                  const isSessionError = /session|login|authenticated/i.test(
                    err.message
                  );
                  if (isSessionError && retries < MAX_RETRIES) {
                    retries++;
                    jobs[jobId].retries++;
                    LOG.warn("BulkProcessor", `[${jobId.slice(0, 8)}] Row ${index} session error, retry ${retries}/${MAX_RETRIES}`);
                    await ctx.initialize();
                    await new Promise((r) => setTimeout(r, 2000));
                    return processWithRetry();
                  } else {
                    results[index] = {
                      input: { idClients, name, city },
                      result: { Status: "Error", Message: err.message },
                      responseTime: Date.now() - t0,
                      retriesAttempted: retries,
                    };
                    jobs[jobId].errors++;
                    jobs[jobId].processed++;
                    if (isSessionError && retries >= MAX_RETRIES)
                      retryQueue.push({ index, row, retries });
                    saveProgress(results, index);
                  }
                }
              };

              await processWithRetry();
            })
          );

          await new Promise((r) => setTimeout(r, 300));
        }

        saveProgress(results, i + batch.length);
        savePartialExcel(results);

        jobs[jobId].summary = {
          total: rows.length,
          processed: jobs[jobId].processed,
          found: jobs[jobId].found,
          notFound: jobs[jobId].notFound,
          errors: jobs[jobId].errors,
          retries: jobs[jobId].retries,
        };
        
        LOG.info("BulkProcessor", `[${jobId.slice(0, 8)}] Progress: ${jobs[jobId].processed}/${rows.length} (found=${jobs[jobId].found}, errors=${jobs[jobId].errors})`);
      }

      if (retryQueue.length > 0) {
        LOG.info("BulkProcessor", `[${jobId.slice(0, 8)}] ${retryQueue.length} rows in final retry queue`);
        await ctx.close();
        ctx = await pool.acquireContext();
        await new Promise((r) => setTimeout(r, 3000));

        for (const { index, row } of retryQueue) {
          const { idClients, name, city } = extractRowFields(row);
          const t0 = Date.now();
          try {
            const localPage = ctx.getPage();
            let result = await performSearch(name, city || undefined, localPage);
            if (
              result.Recommendations &&
              Array.isArray(result.Recommendations) &&
              result.Recommendations.length > 0
            ) {
              const best = result.Recommendations.reduce(
                (max, r) =>
                  r.matchScore > (max.matchScore || 0) ? r : max,
                {}
              );
              result.Recommendations = [best];
            }
            results[index] = {
              input: { idClients, name, city },
              result,
              responseTime: Date.now() - t0,
            };
            if (result.Status === "Found") jobs[jobId].found++;
            else jobs[jobId].notFound++;
            jobs[jobId].errors--;
            jobs[jobId].processed++;
            saveProgress(results, index);
          } catch (err) {
            results[index] = {
              input: { idClients, name, city },
              result: { Status: "Error", Message: err.message },
              responseTime: Date.now() - t0,
            };
            jobs[jobId].errors++;
            jobs[jobId].processed++;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      const wb = buildResultWorkbook(results);
      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const filePath = getNextResultFilename();
      fs.writeFileSync(filePath, buffer);

      jobs[jobId].status = "done";
      jobs[jobId].resultFile = filePath;
      jobs[jobId].summary = {
        total: rows.length,
        processed: jobs[jobId].processed,
        found: jobs[jobId].found,
        notFound: jobs[jobId].notFound,
        errors: jobs[jobId].errors,
        retries: jobs[jobId].retries,
      };

      if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
      LOG.info("BulkProcessor", `✅ Job ${jobId.slice(0, 8)} COMPLETED: ${jobs[jobId].found}/${rows.length} found, ${jobs[jobId].errors} errors`);
    } catch (err) {
      LOG.error("BulkProcessor", `💥 Job ${jobId.slice(0, 8)} FATAL: ${err.message}`);
      jobs[jobId].status = "error";
      jobs[jobId].error = err.message;
      try {
        savePartialExcel(jobs[jobId].results || []);
      } catch {}
    } finally {
      if (ctx) pool.releaseContext(ctx);
    }
  })();
});

app.get("/api/bulk-status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.get("/api/bulk-result/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done" || !job.resultFile)
    return res.status(400).json({ error: "Result not ready" });
  res.download(job.resultFile, path.basename(job.resultFile));
});

app.get("/api/bulk-jobs", (req, res) => {
  const jobList = Object.entries(jobs).map(([id, job]) => ({
    jobId: id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    found: job.found,
    notFound: job.notFound,
    errors: job.errors,
    retries: job.retries,
    resultFile: job.resultFile,
    error: job.error,
    createdAt: job.createdAt,
  }));
  res.json({ jobs: jobList });
});

// ═══════════════════════════════════════════════════════════════
// MAINTENANCE
// ═══════════════════════════════════════════════════════════════

setInterval(() => pool.cleanupIdle(), 60000);

setInterval(() => {
  const now = Date.now();
  wsClients.forEach((clientInfo, client) => {
    if (client.readyState === 1) {
      if (now - clientInfo.lastPing > 30000) {
        client.send(JSON.stringify({ type: "ping" }));
      }
    } else if (client.readyState === 3) {
      wsClients.delete(client);
    }
  });
}, 15000);

const PORT = 3006

server.listen(PORT, () => {
  console.log(`🚀 Scalable server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/status`);
  console.log(`⚙️  Max contexts: ${CONCURRENCY.MAX_BROWSER_CONTEXTS}`);
  console.log(`⚙️  Pages per context: ${CONCURRENCY.PAGES_PER_CONTEXT}`);
});

process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  for (const [id, ctx] of pool.contexts) {
    await ctx.close();
  }
  wss.close();
  server.close();
  process.exit(0);
});