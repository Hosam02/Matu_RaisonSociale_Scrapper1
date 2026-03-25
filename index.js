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
const wss = new WebSocketServer({ server, path: '/status' });

app.use(express.json());

const { username, password } = config.auth;
const LEGAL_NOISE = new Set([
  // General words
  "SOCIETE", "STE", "STÉ",

  // SARL variations
  "SARL", "S.A.R.L", "S A R L", "S. A. R. L", "S.A R.L", "S A.R.L",

  // SA variations
  "SA", "S.A", "S A", "S.A.",

  // SNC variations
  "SNC", "S.N.C", "S N C", "S.N.C.",

  // SCS variations
  "SCS", "S.C.S", "S C S", "S.C.S.",

  // SCA variations
  "SCA", "S.C.A", "S C A", "S.C.A.",

  // EURL variations
  "EURL", "E.U.R.L", "E U R L", "E.U.R.L.",

  // SC (Société Civile / Coopérative)
  "SC", "S.C", "S C", "S.C.",

  // Auto-entrepreneur
  "AE", "A.E", "A E", "A.E.",

  // Association à but non lucratif
  "ABNL", "A.B.N.L", "A B N L", "A.B.N.L."
]);
// Pre-compile regex patterns
const NOISE_PATTERNS = Array.from(LEGAL_NOISE).map(word => 
  new RegExp(`\\b${word}\\b`, "gi")
);

function normalizeString(str) {
  return str
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim() || "";
}

function cleanName(name) {
  if (!name) return "";

  let cleaned = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .toUpperCase()
    
    // 🔥 normalize punctuation
    .replace(/[.\-_/]/g, " ")   // replace ., -, _, / with space
    .replace(/[^A-Z0-9\s]/g, "") // remove any other weird chars

  // remove legal noise
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  return cleaned.replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 0 : 1 - levenshtein.get(a, b) / maxLen;
}

function parseRC(rcText) {
  if (!rcText) return { RCNumber: null, RCTribunal: null };
  const match = rcText.match(/^(\d+)\s*\((.+)\)$/);
  return {
    RCNumber: match ? match[1] : rcText,
    RCTribunal: match ? match[2] : null
  };
}

function generateSearchVariants(name) {
  const words = name.trim().split(/\s+/);
  const variants = new Set();

  // 🔹 1. Existing logic (split inside words)
  words.forEach((word, wi) => {
    if (word.length <= 3) return;

    for (let split = 1; split < word.length; split++) {
      const newWords = [...words];
      newWords[wi] = word.slice(0, split) + " " + word.slice(split);
      variants.add(newWords.join(" "));
    }
  });

  // 🔥 2. NEW: if multiple words → add dot / merge / hyphen variants
  if (words.length > 1) {
    variants.add(words.join("."));  // HI.TEX
    variants.add(words.join(""));   // HITEX
    variants.add(words.join("-"));  // HI-TEX
  }

  return [...variants];
}
 
 
// NEW HELPER 2: run one Charika search, return scored results
async function runOneSearch(query, normalizedCity) {
  await page.goto("https://www.charika.ma/accueil", {
    waitUntil: "domcontentloaded",
    timeout: 10000,
  });
 
  const searchInput = await page.waitForSelector(
    'input.rq-form-element[name="sDenomination"]:visible, input[placeholder*="raison sociale"]:visible',
    { timeout: 5000 }
  );
 
  await searchInput.fill("");
  await searchInput.type(query, { delay: 20 });
  await searchInput.press("Enter");
  await page.waitForURL("**/societe-rechercher**", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
 
  const results = await page.$$eval("div.text-soc", (items) =>
    items.map((item) => {
      const link = item.querySelector("h5 a");
      const addressLabels = Array.from(
        item.querySelectorAll("div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label")
      ).map((l) => l.innerText.trim());
      return {
        name:    link?.innerText.trim() || "",
        href:    link?.getAttribute("href") || "",
        address: addressLabels.join(" "),
      };
    })
  );
 
  const queryClean = cleanName(query);
  let bestMatch = { index: -1, score: 0, name: "", href: "", address: "" };
 
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const score  = similarity(queryClean, cleanName(r.name));
    const cityOk = !normalizedCity || normalizeString(r.address).includes(normalizedCity);
 
    if (score === 1 && (!normalizedCity || cityOk)) {
      bestMatch = { index: i, score: 1, name: r.name, href: r.href, address: r.address };
      break;
    }
    if (score > bestMatch.score) {
      bestMatch = { index: i, score, name: r.name, href: r.href, address: r.address };
    }
  }
 
  return { results, bestMatch };
}

// Function to extract company details from a page
async function extractCompanyDetails(page, url) {
  try {
    await page.goto(url, { 
      waitUntil: "domcontentloaded",
      timeout: 8000 
    });
    
    const details = await page.evaluate(() => {
      const result = {};
      
      // Get company name from the title or heading
      const titleElement = document.querySelector('h1');
      if (titleElement) {
        result.NomCommercial = titleElement.innerText.trim();
      }
      
      // Extract from information table
      const table = document.querySelector('div.col-md-7 table.informations-entreprise');
      if (table) {
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            const field = cells[0].innerText.trim();
            const value = cells[1].innerText.trim();
            
            if (field.includes('RC') || field.includes('Registre')) {
              const match = value.match(/^(\d+)\s*\((.+)\)$/);
              result.RCNumber = match ? match[1] : value;
              result.RCTribunal = match ? match[2] : null;
            } else if (field.includes('ICE')) {
              result.ICE = value;
            } else if (field.includes('Forme juridique')) {
              result.FormeJuridique = value;
            } else if (field.includes('Capital')) {
              result.Capital = value;
            } else if (field.includes('Activité')) {
              result.Activite = value;
            } else if (field.includes('Adresse')) {
              result.Adresse = value;
            } else if (field.includes('Tél')) {
              result.Telephone = value;
            } else if (field.includes('Fax')) {
              result.Fax = value;
            } else if (field.includes('Email')) {
              result.Email = value;
            } else if (field.includes('Site web')) {
              result.SiteWeb = value;
            } else {
              // Store other fields dynamically
              const key = field.replace(/[^a-zA-Z0-9]/g, '');
              result[key] = value;
            }
          }
        });
      }
      
      // Try to get address from alternative location
      if (!result.Adresse) {
        const addressLabels = Array.from(document.querySelectorAll(
          'div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label'
        )).map(l => l.innerText.trim());
        if (addressLabels.length) {
          result.Adresse = addressLabels.join(' ');
        }
      }
      
      return result;
    });
    
    return details;
  } catch (error) {
    console.error(`Error extracting details from ${url}:`, error.message);
    return { error: "Failed to extract company details" };
  }
}

/* =======================
   BROWSER MANAGER
======================= */
let browser = null;
let page = null;
let loginStatus = {
  isLoggedIn: false,
  status: 'disconnected', // 'disconnected', 'connecting', 'connected', 'error'
  lastLoginAttempt: null,
  error: null,
  sessionAge: null,
  browserLaunchTime: null
};

// Track connected WebSocket clients with metadata
const wsClients = new Map();

// Track browser usage
let lastUsed = Date.now();
const BROWSER_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const SESSION_REFRESH_INTERVAL = 25 * 60 * 1000; // Refresh session every 25 minutes

/* =======================
   WEBSOCKET STATUS BROADCAST
======================= */

function broadcastStatus(update = {}) {
  if (loginStatus.isLoggedIn && loginStatus.lastLoginAttempt) {
    const now = Date.now();
    const lastLogin = new Date(loginStatus.lastLoginAttempt).getTime();
    loginStatus.sessionAge = Math.round((now - lastLogin) / 1000);
  }

  const statusUpdate = {
    type: 'status',
    data: {
      ...loginStatus,
      ...update,
      timestamp: new Date().toISOString()
    }
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

function updateLoginStatus(updates) {
  loginStatus = {
    ...loginStatus,
    ...updates,
    lastUpdated: new Date().toISOString()
  };
  broadcastStatus();
}

/* =======================
   WEBSOCKET CONNECTION HANDLER
======================= */

wss.on('connection', (ws, req) => {
  const clientId = Date.now() + Math.random().toString(36).substring(7);
  const clientIp = req.socket.remoteAddress;
  
  console.log(`🔌 New WebSocket client connected: ${clientId} from ${clientIp}`);
  
  wsClients.set(ws, {
    id: clientId,
    ip: clientIp,
    connectedAt: new Date().toISOString(),
    lastPing: Date.now()
  });
  
  ws.send(JSON.stringify({
    type: 'welcome',
    clientId: clientId,
    message: 'Connected to Charika API WebSocket',
    timestamp: new Date().toISOString()
  }));
  
  broadcastStatus();
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      const clientInfo = wsClients.get(ws);
      if (clientInfo) {
        clientInfo.lastPing = Date.now();
        wsClients.set(ws, clientInfo);
      }
      
      switch(data.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        case 'get_status':
          ws.send(JSON.stringify({ type: 'status', data: loginStatus }));
          break;
        case 'request_login':
          ws.send(JSON.stringify({ 
            type: 'login_started', 
            message: 'Login process initiated',
            timestamp: new Date().toISOString()
          }));
          
          initializeBrowserAndLogin().catch(error => {
            console.error('Login error:', error);
            updateLoginStatus({ status: 'error', error: error.message });
          });
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', (code, reason) => {
    const clientInfo = wsClients.get(ws);
    console.log(`🔌 WebSocket client disconnected: ${clientInfo?.id || 'unknown'} (Code: ${code}, Reason: ${reason})`);
    wsClients.delete(ws);
  });

  ws.on('error', (error) => {
    const clientInfo = wsClients.get(ws);
    console.error(`WebSocket client error for ${clientInfo?.id || 'unknown'}:`, error);
    wsClients.delete(ws);
  });
});

// Ping all clients periodically
setInterval(() => {
  const now = Date.now();
  wsClients.forEach((clientInfo, client) => {
    if (client.readyState === 1) {
      if (now - clientInfo.lastPing > 30000) {
        console.log(`Client ${clientInfo.id} inactive, sending ping...`);
        client.send(JSON.stringify({ type: 'ping' }));
      }
    } else if (client.readyState === 3) {
      wsClients.delete(client);
    }
  });
}, 15000);

wss.on('listening', () => {
  console.log('📡 WebSocket server listening on /status');
});

/* =======================
   LOGIN ENDPOINT
======================= */
app.post("/api/login", async (req, res) => {
  console.log("🔑 Login endpoint called");
  
  try {
    updateLoginStatus({ status: 'connecting', error: null });
    const result = await initializeBrowserAndLogin();
    res.json(result);
  } catch (error) {
    console.error("Login failed:", error);
    
    updateLoginStatus({ 
      isLoggedIn: false,
      status: 'error',
      lastLoginAttempt: new Date().toISOString(),
      error: error.message,
      sessionAge: null
    });
    
    res.status(500).json({ 
      success: false, 
      error: error.message,
      status: loginStatus
    });
  }
});

async function initializeBrowserAndLogin() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }

  console.log("🚀 Launching new browser instance...");
  updateLoginStatus({ status: 'connecting' });
  
  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  });

  page = await context.newPage();
  page.setDefaultTimeout(15000);

  console.log("🌐 Navigating to Charika.ma...");
  await page.goto("https://www.charika.ma/accueil", { 
    waitUntil: "domcontentloaded",
    timeout: 20000
  });

  console.log("🔐 Performing login...");
  await performLogin();
  
  const loginVerified = await verifyLogin();
  
  if (!loginVerified) {
    throw new Error("Login verification failed");
  }

  lastUsed = Date.now();
  
  updateLoginStatus({
    isLoggedIn: true,
    status: 'connected',
    lastLoginAttempt: new Date().toISOString(),
    error: null,
    sessionAge: 0,
    browserLaunchTime: new Date().toISOString()
  });

  console.log("✅ Login successful");
  
  return { 
    success: true, 
    message: "Login successful",
    status: loginStatus
  };
}

async function performLogin() {
  await page.locator("a.UserConnect-login").click();
  await page.waitForTimeout(500);
  
  await page.locator('button.btn.btn-sm.btn-blue:has-text("Se connecter")').first().click();
  await page.waitForTimeout(500);
  
  const loginForm = page.locator("#form-connexion:visible");
  await loginForm.locator("input#username").fill(username);
  await loginForm.locator("input#password").fill(password);
  await loginForm.locator('button[type="submit"]:has-text("Se connecter")').click();
  
  await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.waitForSelector('.user-connected, a.UserConnect-login', { timeout: 10000 }),
    page.waitForTimeout(5000)
  ]);
}

async function verifyLogin() {
  try {
    await page.locator('.user-connected, a.UserConnect-login').first().isVisible()
      .catch(() => false);
    
    await page.goto("https://www.charika.ma/accueil", { 
      waitUntil: "domcontentloaded",
      timeout: 5000 
    });
    
    return true;
  } catch (error) {
    console.error("Login verification failed:", error);
    return false;
  }
}

/* =======================
   SESSION MANAGEMENT
======================= */
async function ensureLoggedIn() {
  const now = Date.now();
  
  if (loginStatus.isLoggedIn && page) {
    const sessionAge = now - new Date(loginStatus.lastLoginAttempt).getTime();
    
    if (sessionAge > SESSION_REFRESH_INTERVAL) {
      console.log("🔄 Session expired, refreshing...");
      updateLoginStatus({ status: 'connecting' });
      const refreshed = await refreshSession();
      if (refreshed) {
        updateLoginStatus({ status: 'connected' });
      }
      return refreshed;
    }
    
    try {
      await page.evaluate(() => document.title, { timeout: 2000 });
      lastUsed = now;
      return true;
    } catch {
      console.log("⚠️ Page not responsive, attempting to reconnect...");
      updateLoginStatus({ status: 'connecting' });
      const refreshed = await refreshSession();
      if (refreshed) {
        updateLoginStatus({ status: 'connected' });
      }
      return refreshed;
    }
  }
  
  return false;
}

async function refreshSession() {
  try {
    if (!browser || !page) {
      return false;
    }
    
    await page.goto("https://www.charika.ma/accueil", { 
      waitUntil: "domcontentloaded",
      timeout: 10000 
    });
    
    const isLoggedIn = await page.locator('.user-connected, a.UserConnect-login').first().isVisible()
      .catch(() => false);
    
    if (isLoggedIn) {
      loginStatus.lastLoginAttempt = new Date().toISOString();
      return true;
    }
    
    await performLogin();
    loginStatus.lastLoginAttempt = new Date().toISOString();
    return true;
    
  } catch (error) {
    console.error("Session refresh failed:", error);
    updateLoginStatus({ isLoggedIn: false, status: 'error', error: error.message });
    return false;
  }
}

/* =======================
   SEARCH ENDPOINT - WITH TOP 3 RECOMMENDATIONS
======================= */
app.post("/api/search", async (req, res) => {
  const { name, city } = req.body;
  
  if (!name) {
    return res.status(400).json({ 
      error: "Company name is required",
      InputRaisonSociale: null,
      Status: "Error"
    });
  }

  const startTime = Date.now();
  
  try {
    const isLoggedIn = await ensureLoggedIn();
    
    if (!isLoggedIn || !page) {
      return res.status(401).json({
        InputRaisonSociale: name,
        Status: "Not Authenticated",
        ErrorMessage: "Please login first using /api/login endpoint",
        ResponseTime: Date.now() - startTime
      });
    }

    const result = await performSearch(name, city);
    result.ResponseTime = Date.now() - startTime;
    
    res.json(result);
    
  } catch (error) {
    console.error(`Search error for ${name}:`, error);
    
    if (error.message.includes('Session') || error.message.includes('login')) {
      updateLoginStatus({ isLoggedIn: false, status: 'disconnected' });
      return res.status(401).json({
        InputRaisonSociale: name,
        Status: "Session Expired",
        ErrorMessage: "Session expired. Please login again.",
        ResponseTime: Date.now() - startTime
      });
    }
    
    res.status(500).json({
      InputRaisonSociale: name,
      Status: "Error",
      ErrorMessage: error.message,
      ResponseTime: Date.now() - startTime
    });
  }
});

// REPLACEMENT performSearch() -- delete the old one and paste this instead
async function performSearch(companyName, city) {
  const normalizedCity = city ? normalizeString(city) : null;
 
  // Recovery guard: wait for any in-flight navigation to settle
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    await page.goto("https://www.charika.ma/accueil", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  }
 
  // Step 1: try original name
  let { results, bestMatch } = await runOneSearch(companyName, normalizedCity);
  let usedQuery = companyName;
  const clean = cleanName(companyName);
  // Step 2: if no good match, try space-split variants
  if (bestMatch.score < 0.9) {
    const variants = generateSearchVariants(clean);
 
    for (const variant of variants) {
      console.log(`  Retrying with variant: "${variant}"`);
      const attempt = await runOneSearch(variant, normalizedCity);
 
      if (attempt.bestMatch.score > bestMatch.score) {
        bestMatch = attempt.bestMatch;
        results   = attempt.results;
        usedQuery = variant;
      }
 
      if (bestMatch.score >= 0.95) {
        console.log(`  Variant matched: "${variant}" score=${bestMatch.score.toFixed(2)}`);
        break;
      }
    }
  }
 
  // Step 3: still nothing at all
  if (results.length === 0) {
    return {
      InputRaisonSociale: companyName,
      Status: "Not Found",
      Message: "No results found (including all space-split variants).",
    };
  }
 
  // Step 4: good match -- fetch detail page
  if (bestMatch.score >= 0.95 && bestMatch.index !== -1) {
    await page.goto(`https://www.charika.ma/${bestMatch.href}`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
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
              result.RCNumber   = m ? m[1] : value;
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
 
    // Fallback address from search listing
    if (!info.Address) info.Address = bestMatch.address || "";
 
    if (normalizedCity && info.Address) {
      info.CityMatches = normalizeString(info.Address).includes(normalizedCity);
    }
 
    return info;
  }
 
  // Step 5: no good match -- return top 3 recommendations
  const topResults = results.slice(0, 3);
  const recommendations = [];
 
  for (const result of topResults) {
    console.log(`Fetching details for: ${result.name}`);
 
    await page.goto(`https://www.charika.ma/${result.href}`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
 
    const details = await page.evaluate(() => {
      const result = {};
      const titleElement = document.querySelector("h1");
      if (titleElement) result.NomCommercial = titleElement.innerText.trim();
 
      const table = document.querySelector("div.col-md-7 table.informations-entreprise");
      if (table) {
        table.querySelectorAll("tbody tr").forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length < 2) return;
          const field = cells[0].innerText.trim();
          const value = cells[1].innerText.trim();
          if      (field.includes("RC") || field.includes("Registre")) {
            const m = value.match(/^(\d+)\s*\((.+)\)$/);
            result.RCNumber   = m ? m[1] : value;
            result.RCTribunal = m ? m[2] : null;
          }
          else if (field.includes("ICE"))             result.ICE            = value;
          else if (field.includes("Forme juridique")) result.FormeJuridique = value;
          else if (field.includes("Capital"))         result.Capital        = value;
          else if (field.includes("Activite") || field.includes("Activité")) result.Activite = value;
          else if (field.includes("Adresse"))         result.Adresse        = value;
          else if (field.includes("Tel") || field.includes("Tél")) result.Telephone = value;
          else if (field.includes("Fax"))             result.Fax            = value;
          else if (field.includes("Email"))           result.Email          = value;
          else if (field.includes("Site web"))        result.SiteWeb        = value;
          else result[field.replace(/[^a-zA-Z0-9]/g, "")] = value;
        });
      }
 
      if (!result.Adresse) {
        const labels = Array.from(document.querySelectorAll(
          "div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label"
        )).map((l) => l.innerText.trim());
        if (labels.length) result.Adresse = labels.join(" ");
      }
 
      return result;
    });
 
    const score       = similarity(companyName, result.name);
    const cityMatches = !normalizedCity || normalizeString(result.address).includes(normalizedCity);
 
    recommendations.push({
      name:       result.name,
      url:        `https://www.charika.ma/${result.href}`,
      position:   topResults.indexOf(result) + 1,
      matchScore: score,
      cityMatches,
      details: { ...details, adresse_complete: result.address },
    });
 
    await page.waitForTimeout(300);
  }
 
  const variantCount = generateSearchVariants(companyName).length;
  let message = `No exact match found (best score: ${bestMatch.score.toFixed(2)}, tried ${1 + variantCount} query variant(s)). Showing top ${topResults.length} results.`;
  if (normalizedCity) {
    const cityMatchCount = recommendations.filter((r) => r.cityMatches).length;
    message += cityMatchCount > 0
      ? ` ${cityMatchCount} result(s) from ${city}.`
      : ` None from ${city}.`;
  }
 
  return {
    InputRaisonSociale: companyName,
    InputCity:          city || null,
    Status:             "Not Found - Showing Search Results",
    Message:            message,
    BestMatchScore:     bestMatch.score,
    TotalResultsFound:  results.length,
    Recommendations:    recommendations,
  };
}
// ── Multer: store upload in memory (no temp files on disk) ──────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
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
 
// ── Helper: extract { idClients, name, city } from a raw row ─────────
// IdClients: read exactly as "IdClients" (or common case variants)
// name:      RaisonSociale / name / nom / company / société  (or first column)
// city:      Ville / city / wilaya / region / localite
function extractRowFields(row) {
  const keys = Object.keys(row);
  const find = (...candidates) =>
    keys.find((k) =>
      candidates.some((c) => k.toLowerCase().trim() === c.toLowerCase())
    );
 
  // IdClients – try exact name first, then common variants
  const idKey = find("idclients", "id_clients", "idclient", "id_client", "id");
 
  const nameKey =
    find("raisonsociale", "raison_sociale", "name", "nom", "company", "société") ||
    keys.find((k) => k !== idKey) || // first non-id column
    keys[0];
 
  const cityKey = find("ville", "city", "wilaya", "region", "localite", "localité");
 
  return {
    idClients: idKey ? row[idKey]?.toString().trim() || "" : "",
    name:      row[nameKey]?.toString().trim() || "",
    city:      cityKey ? row[cityKey]?.toString().trim() || "" : "",
  };
}
 
// ── Build the output workbook ─────────────────────────────────────────
//
// Sheet 1 – "Results"
//   • Found rows   → 1 row,  Status = "Found"
//   • Not-found    → N rows (one per suggestion), Status = "Not Found – Suggestion"
//   • Error rows   → 1 row,  Status = "Error"
//
// Sheet 2 – "Errors"  (quick-filter subset of Sheet 1)
// ─────────────────────────────────────────────────────────────────────
function buildResultWorkbook(results) {
  const wb = XLSX.utils.book_new();
 
  // ── Sheet 1: Results ─────────────────────────────────────────────
  const resultRows = [];
 
  for (const r of results) {
    const base = {
      IdClients:              r.input.idClients || "",
      "Input Raison Sociale": r.input.name,
      "Input City":           r.input.city || "",
    };
 
    // ── Error ────────────────────────────────────────────────────
    if (r.error) {
      resultRows.push({
        ...base,
        Status:                 "Error",
        "Found Raison Sociale": "",
        "Suggestion #":         "",
        "Match Score":          "",
        ICE:                    "",
        RC:                     "",
        "RC Tribunal":          "",
        "Forme Juridique":      "",
        Capital:                "",
        Adresse:                "",
        "Error / Message":      r.error,
        "Response Time (ms)":   r.responseTime || "",
      });
      continue;
    }
 
    const res = r.result;
 
    // ── Found ────────────────────────────────────────────────────
    if (res.Status === "Found") {
      resultRows.push({
        ...base,
        Status:                 "Found",
        "Found Raison Sociale": res.FoundRaisonSociale || "",
        "Suggestion #":         "",
        "Match Score":          res.MatchScore != null
                                  ? (res.MatchScore * 100).toFixed(1) + "%"
                                  : "",
        ICE:                    res.ICE || "",
        RC:                     res.RCNumber || "",
        "RC Tribunal":          res.RCTribunal || "",
        "Forme Juridique":      res.FormeJuridique || "",
        Capital:                res.Capital || "",
        Adresse:                res.Address || res.Adresse || "",
        "Error / Message":      "",
        "Response Time (ms)":   r.responseTime || "",
      });
 
    // ── Not found – expand suggestions as individual rows ────────
    } else if (res.Recommendations?.length) {
      res.Recommendations.forEach((rec, j) => {
        resultRows.push({
          ...base,                       // IdClients, Input Raison Sociale, Input City repeated on every suggestion row
          Status:                 "Not Found – Suggestion",
          "Found Raison Sociale": rec.name || "",
          "Suggestion #":         j + 1,
          "Match Score":          rec.matchScore != null
                                    ? (rec.matchScore * 100).toFixed(1) + "%"
                                    : "",
          ICE:                    rec.details?.ICE || "",
          RC:                     rec.details?.RCNumber || "",
          "RC Tribunal":          rec.details?.RCTribunal || "",
          "Forme Juridique":      rec.details?.FormeJuridique || "",
          Capital:                rec.details?.Capital || "",
          Adresse:                rec.details?.Adresse
                                    || rec.details?.adresse_complete
                                    || "",
          "Error / Message":      "",
          // Response time only on the first suggestion row to avoid duplication
          "Response Time (ms)":   j === 0 ? r.responseTime || "" : "",
        });
      });
 
    // ── Not found, no suggestions at all ────────────────────────
    } else {
      resultRows.push({
        ...base,
        Status:                 res.Status || "Not Found",
        "Found Raison Sociale": "",
        "Suggestion #":         "",
        "Match Score":          "",
        ICE:                    "",
        RC:                     "",
        "RC Tribunal":          "",
        "Forme Juridique":      "",
        Capital:                "",
        Adresse:                "",
        "Error / Message":      res.Message || "",
        "Response Time (ms)":   r.responseTime || "",
      });
    }
  }
 
  const resultSheet = XLSX.utils.json_to_sheet(resultRows);
  resultSheet["!cols"] = [
    { wch: 15 }, // IdClients
    { wch: 35 }, // Input Raison Sociale
    { wch: 18 }, // Input City
    { wch: 28 }, // Status
    { wch: 35 }, // Found Raison Sociale
    { wch: 12 }, // Suggestion #
    { wch: 12 }, // Match Score
    { wch: 18 }, // ICE
    { wch: 12 }, // RC
    { wch: 20 }, // RC Tribunal
    { wch: 20 }, // Forme Juridique
    { wch: 15 }, // Capital
    { wch: 45 }, // Adresse
    { wch: 45 }, // Error / Message
    { wch: 16 }, // Response Time
  ];
  XLSX.utils.book_append_sheet(wb, resultSheet, "Results");
 
  // ── Sheet 2: Errors (quick-filter view) ──────────────────────────
  const errorRows = results
    .filter((r) => r.error)
    .map((r) => ({
      IdClients:              r.input.idClients || "",
      "Input Raison Sociale": r.input.name,
      "Input City":           r.input.city || "",
      Error:                  r.error,
      "Response Time (ms)":   r.responseTime || "",
    }));
 
  if (errorRows.length) {
    const errSheet = XLSX.utils.json_to_sheet(errorRows);
    errSheet["!cols"] = [
      { wch: 15 },
      { wch: 35 },
      { wch: 18 },
      { wch: 60 },
      { wch: 16 },
    ];
    XLSX.utils.book_append_sheet(wb, errSheet, "Errors");
  }
 
  return wb;
}
// Folder where bulk-search result files are saved
const RESULTS_DIR = path.resolve("./bulk-results");
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`📁 Created results folder: ${RESULTS_DIR}`);
}
function getNextResultFilename() {
  const existing = fs.readdirSync(RESULTS_DIR)
    .filter((f) => /^results_\d+\.xlsx$/.test(f))
    .map((f) => parseInt(f.match(/^results_(\d+)\.xlsx$/)[1], 10));
 
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return path.join(RESULTS_DIR, `results_${next}.xlsx`);
}
 
/* =======================
   SESSION STATUS ENDPOINT
======================= */
app.get("/api/session", (req, res) => {
  if (loginStatus.isLoggedIn) {
    const now = Date.now();
    const lastLogin = new Date(loginStatus.lastLoginAttempt).getTime();
    loginStatus.sessionAge = Math.round((now - lastLogin) / 1000);
  }
  
  res.json({
    ...loginStatus,
    browserActive: !!browser,
    pageActive: !!page,
    wsClients: wsClients.size
  });
});

/* =======================
   HEALTH CHECK
======================= */
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "OK", 
    browserActive: !!browser,
    loggedIn: loginStatus.isLoggedIn,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    wsConnections: wsClients.size
  });
});

/* =======================
   LOGOUT ENDPOINT
======================= */
app.post("/api/logout", async (req, res) => {
  console.log("👋 Logout endpoint called");
  
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
  
  loginStatus = {
    isLoggedIn: false,
    status: 'disconnected',
    lastLoginAttempt: null,
    error: null,
    sessionAge: null,
    browserLaunchTime: null
  };
  
  broadcastStatus();
  
  res.json({ 
    success: true, 
    message: "Logged out successfully" 
  });
});

/* =======================
   ICE DATA ENDPOINT
======================= */
app.post("/api/ice", async (req, res) => {
  const ice = (req.body?.ice || "").trim();

  if (!ice || !/^\d+$/.test(ice)) {
    return res.status(400).json({
      success: false,
      error: "ICE must be a numeric string",
    });
  }

  try {
    const data = await fetchIceData(ice);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
// =====================================================================
// ROUTE – POST /api/bulk-search
// =====================================================================
 
app.post(
  "/api/bulk-search",
  upload.single("file"), // form-data field name: "file"
  async (req, res) => {
    // ── 1. Validate upload ──────────────────────────────────────────
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Send the Excel file in a form-data field named "file".',
      });
    }
 
    // ── 2. Parse Excel ──────────────────────────────────────────────
    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]]; // always use first sheet
      rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    } catch {
      return res.status(400).json({ success: false, error: "Could not parse Excel file." });
    }
 
    if (!rows.length) {
      return res.status(400).json({ success: false, error: "The Excel file is empty." });
    }
 
    // ── 3. Validate session ─────────────────────────────────────────
    const isLoggedIn = await ensureLoggedIn();
    if (!isLoggedIn || !page) {
      return res.status(401).json({
        success: false,
        error: "Not authenticated. Call POST /api/login first.",
      });
    }
 
    // ── 4. Optional query params ────────────────────────────────────
    const concurrency  = Math.min(parseInt(req.query.concurrency || "1"), 3);
    const stopOnError  = req.query.stopOnError === "true";
    const outputFormat = (req.query.format || "excel").toLowerCase(); // "excel" | "json"
 
    console.log(
      `📊 Bulk search started – ${rows.length} row(s), concurrency=${concurrency}, format=${outputFormat}`
    );
 
    // ── 5. Process rows ─────────────────────────────────────────────
    const results = new Array(rows.length);
    let processed = 0;
    let found     = 0;
    let notFound  = 0;
    let errors    = 0;
 
    async function processRow(row, index) {
      const { idClients, name, city } = extractRowFields(row);
 
      if (!name) {
        results[index] = {
          input: { idClients, name: "", city },
          error: "Empty company name – row skipped",
          responseTime: 0,
        };
        errors++;
        processed++;
        return;
      }
 
      const t0 = Date.now();
      try {
        const result       = await performSearch(name, city || undefined);
        const responseTime = Date.now() - t0;
 
        results[index] = { input: { idClients, name, city }, result, responseTime };
 
        if (result.Status === "Found") found++;
        else notFound++;
 
        const suggCount = result.Recommendations?.length
          ? ` (${result.Recommendations.length} suggestion(s))`
          : "";
        console.log(
          `  [${index + 1}/${rows.length}] [${idClients || "—"}] "${name}" → ${result.Status}${suggCount} (${responseTime} ms)`
        );
      } catch (err) {
        const responseTime = Date.now() - t0;
        results[index] = {
          input: { idClients, name, city },
          error: err.message,
          responseTime,
        };
        errors++;
        console.error(
          `  [${index + 1}/${rows.length}] [${idClients || "—"}] "${name}" → ERROR: ${err.message}`
        );
        if (stopOnError) throw err;
      }
 
      processed++;
    }
 
    try {
      if (concurrency === 1) {
        // Purely sequential – one search at a time, safe for a single Playwright page
        for (let i = 0; i < rows.length; i++) {
          await processRow(rows[i], i);
        }
      } else {
        // Batched concurrency
        for (let i = 0; i < rows.length; i += concurrency) {
          const batch = rows
            .slice(i, i + concurrency)
            .map((row, j) => processRow(row, i + j));
          await Promise.all(batch);
        }
      }
    } catch (abortErr) {
      console.warn("⚠️  Bulk search aborted early:", abortErr.message);
    }
 
    const summary = { total: rows.length, processed, found, notFound, errors };
    console.log("✅ Bulk search complete –", summary);
 
    // ── 6. Return response ──────────────────────────────────────────
    if (outputFormat === "json") {
      return res.json({ success: true, summary, results });
    }
 
    // Save Excel file to the results folder (no download prompt for the caller)
    try {
      const outWb    = buildResultWorkbook(results);
      const buffer   = XLSX.write(outWb, { type: "buffer", bookType: "xlsx" });
      const filePath = getNextResultFilename();
      const fileName = path.basename(filePath);
 
      fs.writeFileSync(filePath, buffer);
      console.log(`💾 Results saved to: ${filePath}`);
 
      // Return a JSON confirmation — no file download
      return res.json({
        success:  true,
        summary,
        savedAs:  fileName,
        savedPath: filePath,
      });
    } catch (xlsxErr) {
      console.error("Failed to build/save Excel output:", xlsxErr);
      return res.status(500).json({
        success: false,
        error:   "Search completed but failed to save Excel output.",
        summary,
      });
    }
  }
);
app.post("/api/debug-search", async (req, res) => {
  const { name, city } = req.body;
 
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
 
  const isLoggedIn = await ensureLoggedIn();
  if (!isLoggedIn || !page) {
    return res.status(401).json({ error: "Not authenticated. Call /api/login first." });
  }
 
  const log = [];   // step-by-step trace
  const warn = [];  // things that look wrong
 
  try {
    // ── 1. Navigate & search ──────────────────────────────────────
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
 
    // ── 2. Grab raw search results ────────────────────────────────
    const searchResults = await page.$$eval("div.text-soc", (items) =>
      items.map((item) => {
        const link = item.querySelector("h5 a");
        const addressLabels = Array.from(
          item.querySelectorAll("div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label")
        ).map((l) => l.innerText.trim());
        return {
          name:    link?.innerText.trim() || "",
          href:    link?.getAttribute("href") || "",
          address: addressLabels.join(" "),
        };
      })
    );
 
    log.push(`Found ${searchResults.length} result(s) on search page`);
 
    if (searchResults.length === 0) {
      return res.json({ log, warn, searchResults: [], detail: null });
    }
 
    // Score and pick best match (mirrors performSearch logic)
    const companyClean = cleanName(name);
    const normalizedCity = city ? normalizeString(city) : null;
 
    let bestMatch = { index: -1, score: 0, name: "", href: "", address: "" };
    const scored = searchResults.map((r, i) => {
      const score = similarity(companyClean, cleanName(r.name));
      const cityOk = !normalizedCity || normalizeString(r.address).includes(normalizedCity);
      if (score > bestMatch.score) {
        bestMatch = { index: i, score, name: r.name, href: r.href, address: r.address };
      }
      return { ...r, score: +score.toFixed(4), cityOk };
    });
 
    log.push(`Best match: "${bestMatch.name}" — score ${bestMatch.score.toFixed(4)}`);
    log.push(`Address from search listing: "${bestMatch.address || "(empty)"}"`);
 
    if (bestMatch.score < 0.8) {
      warn.push(`Score ${bestMatch.score.toFixed(4)} is below 0.8 — would NOT be treated as Found`);
    }
 
    // ── 3. Navigate to company detail page ───────────────────────
    const detailUrl = `https://www.charika.ma/${bestMatch.href}`;
    log.push(`Navigating to detail page: ${detailUrl}`);
 
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
 
    // ── 4. Full DOM diagnostic on the detail page ─────────────────
    const domDiag = await page.evaluate(() => {
      const diag = {
        pageTitle:   document.title,
        h1Text:      document.querySelector("h1")?.innerText.trim() || null,
 
        // ── Info table ──────────────────────────────────────────
        tableFound:  !!document.querySelector("div.col-md-7 table.informations-entreprise"),
        tableRows:   [],
 
        // ── Alternative address selectors ───────────────────────
        altAddress1: Array.from(document.querySelectorAll(
          "div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label"
        )).map((l) => l.innerText.trim()),
 
        altAddress2: Array.from(document.querySelectorAll(
          "div.nopaddingleft label"
        )).map((l) => l.innerText.trim()),
 
        altAddress3: document.querySelector(".adresse, .address, [class*='adresse'], [class*='address']")
          ?.innerText.trim() || null,
 
        // ── All visible text that contains typical address words ─
        addressKeywordMatches: (() => {
          const keywords = ["rue", "avenue", "bd", "boulevard", "lot", "km", "angle",
                            "quartier", "hay", "zone", "résidence", "immeuble", "n°",
                            "casablanca", "rabat", "marrakech", "fès", "agadir"];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const hits = [];
          let node;
          while ((node = walker.nextNode())) {
            const txt = node.textContent.trim();
            if (txt.length > 10 && keywords.some((k) => txt.toLowerCase().includes(k))) {
              hits.push(txt.substring(0, 200));
            }
          }
          // Deduplicate
          return [...new Set(hits)].slice(0, 20);
        })(),
 
        // ── Raw HTML of the info table for inspection ───────────
        tableHtml: document.querySelector("div.col-md-7 table.informations-entreprise")
          ?.innerHTML.replace(/\s+/g, " ").trim().substring(0, 3000) || null,
 
        // ── All <td> pairs in the table ─────────────────────────
        allTdPairs: (() => {
          const table = document.querySelector("div.col-md-7 table.informations-entreprise");
          if (!table) return [];
          return Array.from(table.querySelectorAll("tbody tr")).map((row) => {
            const cells = row.querySelectorAll("td");
            return {
              field: cells[0]?.innerText.trim() || "",
              value: cells[1]?.innerText.trim() || "",
            };
          });
        })(),
      };
 
      return diag;
    });
 
    // ── 5. Analyse the diagnostic ─────────────────────────────────
    if (!domDiag.tableFound) {
      warn.push("INFO TABLE NOT FOUND — selector 'div.col-md-7 table.informations-entreprise' matched nothing");
    } else {
      log.push(`Info table found — ${domDiag.allTdPairs.length} row(s)`);
    }
 
    const adresseRow = domDiag.allTdPairs.find(
      (p) => p.field.includes("Adresse") || p.field.includes("adresse")
    );
 
    if (adresseRow) {
      log.push(`Adresse row found in table: field="${adresseRow.field}" value="${adresseRow.value}"`);
      if (!adresseRow.value) {
        warn.push("Adresse row EXISTS but its value cell is EMPTY");
      }
    } else {
      warn.push("No row with 'Adresse' found inside the info table");
    }
 
    if (domDiag.altAddress1.length) {
      log.push(`Alt selector 1 (col-md-8 label) found: ${JSON.stringify(domDiag.altAddress1)}`);
    } else {
      warn.push("Alt selector 1 (div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label) → no matches");
    }
 
    if (domDiag.altAddress2.length) {
      log.push(`Alt selector 2 (div.nopaddingleft label) found: ${JSON.stringify(domDiag.altAddress2)}`);
    } else {
      warn.push("Alt selector 2 (div.nopaddingleft label) → no matches");
    }
 
    if (domDiag.altAddress3) {
      log.push(`Alt selector 3 ([class*=adresse]) found: "${domDiag.altAddress3}"`);
    } else {
      warn.push("Alt selector 3 ([class*=adresse/address]) → no match");
    }
 
    if (domDiag.addressKeywordMatches.length) {
      log.push(`Address keyword scan found ${domDiag.addressKeywordMatches.length} text node(s) that look like addresses`);
    } else {
      warn.push("Address keyword scan found NOTHING that looks like an address on this page");
    }
 
    // ── 6. Return full report ─────────────────────────────────────
    return res.json({
      input:           { name, city: city || null },
      bestMatch:       { name: bestMatch.name, href: bestMatch.href, score: bestMatch.score, addressFromListing: bestMatch.address },
      scoredResults:   scored,
      log,
      warnings:        warn,
      domDiagnostic:   domDiag,
      detailUrl,
    });
 
  } catch (err) {
    log.push(`ERROR: ${err.message}`);
    return res.status(500).json({ log, warn, error: err.message });
  }
});


// Clean up idle browser
setInterval(async () => {
  if (browser && Date.now() - lastUsed > BROWSER_IDLE_TIMEOUT) {
    console.log("🧹 Closing idle browser...");
    await browser.close().catch(() => {});
    browser = null;
    page = null;
    updateLoginStatus({ 
      isLoggedIn: false, 
      status: 'disconnected' 
    });
  }
}, 60000);

const PORT = 3005;
server.listen(PORT, () => {
  console.log(`🚀 HTTP server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/status`);
});

process.on("SIGINT", async () => {
  console.log("Closing browser and server...");
  if (browser) await browser.close();
  wss.close();
  server.close();
  process.exit(0);
});