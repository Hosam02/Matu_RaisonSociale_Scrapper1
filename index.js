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
import { v4 as uuidv4 } from "uuid";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/status' });
// Bulk search jobs storage
const jobs = {};

app.use(express.json());

const { username, password } = config.auth;

const BATCH_SIZE = 50;
const PROGRESS_FILE = path.resolve("./bulk-results/progress.json");
const PARTIAL_FILE = path.resolve("./bulk-results/partial_results.xlsx");
const LEGAL_NOISE = new Set([
  // General words
  "SOCIETE", "STE", "STÉ",

  // SARL variations
  "SARL", "S.A.R.L", "S A R L", "S. A. R. L", "S.A.R.L", "S A.R.L",

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
  "ABNL", "A.B.N.L", "A B N L", "A.B.N.L.",

  "au", "AU", "A.U", "A.U.",
]);
// Pre-compile regex patterns
const NOISE_PATTERNS = Array.from(LEGAL_NOISE).map(word => 
  new RegExp(`\\b${word}\\b`, "gi")
);
let pagePool = [];
const MAX_PAGES = 3;
let pageIndex = 0;

function getPage() {
  const p = pagePool[pageIndex % pagePool.length];
  pageIndex++;
  return p;
}

function normalizeString(str) {
  return (
    str
      ?.normalize("NFD")                  // remove accents
      .replace(/[\u0300-\u036f]/g, "")    // remove diacritics
      .replace(/[^A-Z0-9\s]/gi, " ")      // remove punctuation, keep letters/numbers/spaces
      .replace(/\s+/g, " ")               // normalize spaces
      .toUpperCase()
      .trim() || ""
  );
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

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  
  // 🔥 CORRECTION SPÉCIFIQUE: Fusionner les initiales
  // Sépare le texte en mots
  const words = cleaned.split(/\s+/);
  
  // Parcourt les mots pour fusionner les initiales consécutives
  const mergedWords = [];
  let i = 0;
  
  while (i < words.length) {
    // Si c'est une initiale (1 lettre) et qu'il y a un mot après
    if (words[i].length === 1 && i + 1 < words.length) {
      let initials = words[i];
      let j = i + 1;
      
      // Continue tant que les mots suivants sont aussi des initiales
      while (j < words.length && words[j].length === 1) {
        initials += words[j];
        j++;
      }
      
      // Ajoute les initiales fusionnées
      mergedWords.push(initials);
      i = j;
    } else {
      // Mot normal, on le garde tel quel
      mergedWords.push(words[i]);
      i++;
    }
  }
  
  cleaned = mergedWords.join(' ');
  
  return cleaned;
}
function similarity(a, b) {
  if (!a || !b) return 0;

  const cleanA = cleanName(a);
  const cleanB = cleanName(b);

  const compactA = cleanA.replace(/\s+/g, "");
  const compactB = cleanB.replace(/\s+/g, "");

  const scoreNormal = 1 - levenshtein.get(cleanA, cleanB) / Math.max(cleanA.length, cleanB.length);

  const scoreCompact = 1 - levenshtein.get(compactA, compactB) / Math.max(compactA.length, compactB.length);

  // 🔥 TAKE THE BEST
  return Math.max(scoreNormal, scoreCompact);
}

function saveProgress(results, lastIndex) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    lastIndex,
    results
  }));
}

function loadProgress(defaultLength) {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return {
      startIndex: 0,
      results: new Array(defaultLength)
    };
  }

  const saved = JSON.parse(fs.readFileSync(PROGRESS_FILE));
  return {
    startIndex: saved.lastIndex || 0,
    results: saved.results || new Array(defaultLength)
  };
}

function savePartialExcel(results) {
  try {
    const wb = buildResultWorkbook(results);
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    fs.writeFileSync(PARTIAL_FILE, buffer);
    console.log("💾 Partial Excel saved");
  } catch (err) {
    console.error("Partial save failed:", err.message);
  }
}


function parseRC(rcText) {
  if (!rcText) return { RCNumber: null, RCTribunal: null };
  const match = rcText.match(/^(\d+)\s*\((.+)\)$/);
  return {
    RCNumber: match ? match[1] : rcText,
    RCTribunal: match ? match[2] : null
  };
}

async function safeRunSearch(page, query, normalizedCity, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await runOneSearch(page, query, normalizedCity);
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

function generateSearchVariants(name) {
  const cleaned = cleanName(name);
  const words = cleaned.split(/\s+/).filter(Boolean);

  const variants = new Set();

  // Always include original
  variants.add(cleaned);

  // If already multiple words → add compact forms
  if (words.length > 1) {
    variants.add(words.join(""));   // HITEX
    variants.add(words.join("."));  // HI.TEX
    variants.add(words.join("-"));  // HI-TEX
  }

  // 🔥 KEY FIX: aggressive splitting for single word
  if (words.length === 1) {
    const word = words[0];

    // try ALL reasonable splits
    for (let i = 2; i <= word.length - 2; i++) {
      const left = word.slice(0, i);
      const right = word.slice(i);

      // avoid useless splits like H ITEX
      if (left.length < 2 || right.length < 2) continue;

      variants.add(`${left} ${right}`); // HI TEX
    }
  }

  return [...variants];
}

async function runOneSearch(page, query, normalizedCity){
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


   //BROWSER MANAGER

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


  //WEBSOCKET STATUS BROADCAST


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


   //WEBSOCKET CONNECTION HANDLER


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

async function ensureFreshSession() {
  try {
    // Check if browser exists and is responsive
    if (browser && page) {
      try {
        await page.evaluate(() => document.title, { timeout: 3000 });
        const isLoggedIn = await ensureLoggedIn();
        if (isLoggedIn) {
          return true;
        }
      } catch (err) {
        console.log("Browser unresponsive, will recreate");
      }
    }
    
    // Session needs refresh or browser dead
    console.log("♻️ Reconnecting session...");
    await initializeBrowserAndLogin();
    return true;
  } catch (err) {
    console.error("Failed to ensure fresh session:", err.message);
    return false;
  }
}



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

  pagePool = [];

  for (let i = 0; i < MAX_PAGES; i++) {
    const p = await context.newPage();
    p.setDefaultTimeout(15000);
    pagePool.push(p);
  }

// Keep one main page for login/session
page = pagePool[0];
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


  // SESSION MANAGEMENT

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

function compactString(str) {
  return cleanName(str).replace(/\s+/g, "");
}



// Helper: city matching including RCTribunal fallback
function cityMatches(address, city, rcTribunal = null) {
  if (!city) return true;
  const normalizedCity = normalizeString(city);
  const normalizedAddress = normalizeString(address || "");
  const normalizedRC = rcTribunal ? normalizeString(rcTribunal) : "";
  
  const tokens = normalizedCity.split(" ");
  
  // City matches if all tokens are in address OR in RCTribunal
  return tokens.every(t => normalizedAddress.includes(t) || normalizedRC.includes(t));
}

async function performSearch(companyName, city, page) {
  const normalizedCity = city ? normalizeString(city) : null;

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    await page.goto("https://www.charika.ma/accueil", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  }

  const originalName = companyName;
  const cleanedOriginal = cleanName(originalName);

  let { results, bestMatch } = await safeRunSearch(page, originalName, normalizedCity);
  let usedQuery = originalName;

  // Step 2: try variants if needed (unchanged)
  if (bestMatch.score < 0.85 && results.length > 0) {
    const variants = generateSearchVariants(originalName);
    const cleanWithoutDots = cleanedOriginal.replace(/\./g, '');
    const specialVariants = [
      cleanWithoutDots,
      cleanedOriginal.replace(/\s+/g, ''),
      cleanWithoutDots.replace(/\s+/g, ''),
      cleanedOriginal.replace(/\./g, ' ').replace(/\s+/g, ' ').trim()
    ];
    specialVariants.forEach(v => { if (v) variants.push(v); });
    const uniqueVariants = [...new Set(variants)];

    for (const variant of uniqueVariants) {
      console.log(`  🔄 Retrying with variant: "${variant}"`);
      const attempt = await safeRunSearch(page, variant, normalizedCity);
      if (attempt.bestMatch.score > bestMatch.score) {
        bestMatch = attempt.bestMatch;
        results = attempt.results;
        usedQuery = variant;
        console.log(`  ✅ Better match: "${bestMatch.name}" score=${bestMatch.score.toFixed(4)}`);
      }
      if (bestMatch.score >= 0.93) break;
    }
  }

  // Step 3: exact match by cleaning (unchanged)
  if (bestMatch.score < 0.85 && results.length > 0) {
    const exactMatch = results.find(r => {
      const cleanedResult = cleanName(r.name);
      const cleanedOriginalClean = cleanName(originalName);
      return [
        cleanedResult === cleanedOriginalClean,
        cleanedResult.replace(/\./g, '') === cleanedOriginalClean.replace(/\./g, ''),
        cleanedResult.replace(/\s+/g, '') === cleanedOriginalClean.replace(/\s+/g, ''),
        cleanedResult.includes(cleanedOriginalClean) || cleanedOriginalClean.includes(cleanedResult)
      ].some(Boolean);
    });
    if (exactMatch) {
      console.log(`  🎯 Exact match found: "${exactMatch.name}"`);
      bestMatch = {
        index: results.indexOf(exactMatch),
        score: 0.98,
        name: exactMatch.name,
        href: exactMatch.href,
        address: exactMatch.address,
        RCTribunal: exactMatch.RCTribunal || null
      };
    }
  }

  if (results.length === 0) {
    return {
      InputRaisonSociale: originalName,
      Status: "Not Found",
      Message: "No results found."
    };
  }

  // Step 4: fetch best match details
  if (bestMatch.score >= 0.85 && bestMatch.index !== -1) {
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
          IsExactMatch: bestScore >= 0.95,
          UsedQuery: usedQuery,
        };

        const table = document.querySelector("div.col-md-7 table.informations-entreprise");
        if (table) {
          table.querySelectorAll("tbody tr").forEach(row => {
            const cells = row.querySelectorAll("td");
            if (cells.length < 2) return;
            const field = cells[0].innerText.trim();
            const value = cells[1].innerText.trim();
            if (field.includes("RC") || field.includes("Registre")) {
              const m = value.match(/^(\d+)\s*\((.+)\)$/);
              result.RCNumber = m ? m[1] : value;
              result.RCTribunal = m ? m[2] : null;
            } else if (field.includes("ICE")) result.ICE = value;
            else if (field.includes("Forme juridique")) result.FormeJuridique = value;
            else if (field.includes("Capital")) result.Capital = value;
            else if (field.includes("Activite") || field.includes("Activité")) result.Activite = value;
            else if (field.includes("Adresse")) result.Address = value;
            else if (field.includes("Tel") || field.includes("Tél")) result.Telephone = value;
            else if (field.includes("Fax")) result.Fax = value;
            else if (field.includes("Email")) result.Email = value;
            else if (field.includes("Site web")) result.SiteWeb = value;
            else result[field.replace(/[^a-zA-Z0-9]/g, "")] = value;
          });
        }

        if (!result.Address) {
          const labels = Array.from(document.querySelectorAll("div.col-md-8.col-sm-8-col-xs-8.nopaddingleft label")).map(l => l.innerText.trim());
          if (labels.length) result.Address = labels.join(" ");
        }

        return result;
      },
      { companyName: originalName, foundName: bestMatch.name, bestScore: bestMatch.score, usedQuery }
    );

    if (!info.Address) info.Address = bestMatch.address || "";

    // ✅ City match using address OR RCTribunal
    if (!cityMatches(info.Address, city, info.RCTribunal)) {
      console.log(`❌ City mismatch: expected "${city}" but got "${info.Address}" (RCTribunal: ${info.RCTribunal || "N/A"})`);
      return {
        InputRaisonSociale: originalName,
        InputCity: city,
        Status: "Not Found - City Mismatch",
        Message: `Best match found (${bestMatch.name}) but city does not match.`,
        BestMatchScore: bestMatch.score,
        FoundRaisonSociale: bestMatch.name,
      };
    }

    console.log(`✅ Successfully found: "${bestMatch.name}"`);
    return info;
  }

  // Step 5: fallback recommendations (unchanged)
  console.log(`⚠️ No good match found, returning top results`);
  const topResults = results.filter(r => similarity(originalName, r.name) > 0.5).slice(0, 3);
  const recommendations = [];

  for (const result of topResults) {
    await page.goto(`https://www.charika.ma/${result.href}`, { waitUntil: "domcontentloaded", timeout: 10000 });
    const details = await page.evaluate(() => {
      const res = {};
      const table = document.querySelector("div.col-md-7 table.informations-entreprise");
      if (table) {
        table.querySelectorAll("tbody tr").forEach(row => {
          const cells = row.querySelectorAll("td");
          if (cells.length < 2) return;
          const field = cells[0].innerText.trim();
          const value = cells[1].innerText.trim();
          res[field.replace(/[^a-zA-Z0-9]/g, "")] = value;
        });
      }
      return res;
    });
    const score = similarity(originalName, result.name);
    const cityMatchFlag = cityMatches(result.address, city, result.RCTribunal);
    recommendations.push({
      name: result.name,
      url: `https://www.charika.ma/${result.href}`,
      position: topResults.indexOf(result) + 1,
      matchScore: score,
      cityMatches: cityMatchFlag,
      details: { ...details, adresse_complete: result.address }
    });
    await page.waitForTimeout(300);
  }

  return {
    InputRaisonSociale: originalName,
    InputCity: city || null,
    Status: "Not Found - Showing Search Results",
    Message: `No exact match found. Showing top ${recommendations.length} results.`,
    BestMatchScore: bestMatch.score,
    TotalResultsFound: results.length,
    Recommendations: recommendations
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


   //LOGIN ENDPOINT

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

 

   //SESSION STATUS ENDPOINT

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


   //HEALTH CHECK

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


  // LOGOUT ENDPOINT

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




  // SEARCH ENDPOINT - WITH TOP 3 RECOMMENDATIONS

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
    const localPage = getPage();
    const result = await performSearch(name, city, localPage);
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

// Bulk search endpoint with background processing and top recommendation only
app.post("/api/bulk-search", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded. Use "file" field.' });
  }

  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
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
    createdAt: new Date().toISOString()
  };

  // Return immediately
  res.json({ success: true, jobId, message: "Bulk job started" });

  // Background processing
  (async () => {
    try {
      const { startIndex, results } = loadProgress(rows.length);
      const concurrency = Math.min(parseInt(req.query.concurrency || "2"), 3);
      const MAX_RETRIES = 3;
      const retryQueue = [];

      for (let i = startIndex; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);

        let sessionValid = await ensureFreshSession();
        if (!sessionValid) await initializeBrowserAndLogin();

        for (let j = 0; j < batch.length; j += concurrency) {
          const subBatch = batch.slice(j, j + concurrency);

          await Promise.all(subBatch.map(async (row, k) => {
            const index = i + j + k;
            let retries = 0;

            const processWithRetry = async () => {
              const { idClients, name, city } = extractRowFields(row);
              if (!name) {
                results[index] = { input: { idClients, name: "", city }, error: "Empty name", responseTime: 0 };
                jobs[jobId].errors++;
                jobs[jobId].processed++;
                return;
              }

              const t0 = Date.now();
              try {
                const isLoggedIn = await ensureLoggedIn();
                if (!isLoggedIn) await initializeBrowserAndLogin();

                const localPage = getPage();
                let result = await performSearch(name, city || undefined, localPage);

                // Keep only the recommendation with the highest MatchScore
                if (result.Recommendations && Array.isArray(result.Recommendations) && result.Recommendations.length > 0) {
                  const best = result.Recommendations.reduce(
                    (max, r) => r.MatchScore > (max.MatchScore || 0) ? r : max,
                    {}
                  );
                  result.Recommendations = [best];
                }

                const responseTime = Date.now() - t0;
                results[index] = { input: { idClients, name, city }, result, responseTime };

                if (result.Status === "Found") jobs[jobId].found++;
                else jobs[jobId].notFound++;

                jobs[jobId].processed++;
                saveProgress(results, index);

              } catch (err) {
                const isSessionError = /session|login|authenticated/i.test(err.message);
                if (isSessionError && retries < MAX_RETRIES) {
                  retries++;
                  jobs[jobId].retries++;
                  await initializeBrowserAndLogin();
                  await new Promise(r => setTimeout(r, 2000));
                  return processWithRetry();
                } else {
                  results[index] = {
                    input: { idClients, name, city },
                    error: err.message,
                    responseTime: Date.now() - t0,
                    retriesAttempted: retries
                  };
                  jobs[jobId].errors++;
                  jobs[jobId].processed++;
                  if (isSessionError && retries >= MAX_RETRIES) retryQueue.push({ index, row, retries });
                  saveProgress(results, index);
                }
              }
            };

            await processWithRetry();
          }));

          await new Promise(r => setTimeout(r, 300));
        }

        saveProgress(results, i + batch.length);
        savePartialExcel(results);

        jobs[jobId].summary = {
          total: rows.length,
          processed: jobs[jobId].processed,
          found: jobs[jobId].found,
          notFound: jobs[jobId].notFound,
          errors: jobs[jobId].errors,
          retries: jobs[jobId].retries
        };
      }

      // Final retry for session errors
      if (retryQueue.length > 0) {
        if (browser) { await browser.close().catch(() => {}); browser = null; page = null; }
        await initializeBrowserAndLogin();
        await new Promise(r => setTimeout(r, 3000));

        for (const { index, row } of retryQueue) {
          const { idClients, name, city } = extractRowFields(row);
          const t0 = Date.now();
          try {
            const localPage = getPage();
            let result = await performSearch(name, city || undefined, localPage);
            if (result.Recommendations && Array.isArray(result.Recommendations) && result.Recommendations.length > 0) {
              const best = result.Recommendations.reduce(
                (max, r) => r.MatchScore > (max.MatchScore || 0) ? r : max,
                {}
              );
              result.Recommendations = [best];
            }
            results[index] = { input: { idClients, name, city }, result, responseTime: Date.now() - t0 };
            if (result.Status === "Found") jobs[jobId].found++;
            else jobs[jobId].notFound++;
            jobs[jobId].errors--;
            jobs[jobId].processed++;
            saveProgress(results, index);
          } catch {}
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // Save final Excel
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
        retries: jobs[jobId].retries
      };

      if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
      console.log(`✅ Job ${jobId} completed successfully`);

    } catch (err) {
      console.error(`💥 Job ${jobId} fatal error:`, err);
      jobs[jobId].status = "error";
      jobs[jobId].error = err.message;

      // Attempt to save partial results if possible
      try { savePartialExcel(jobs[jobId].results || []); } catch {}
    }
  })();
});

app.get("/api/bulk-status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// Download endpoint
app.get("/api/bulk-result/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done" || !job.resultFile) return res.status(400).json({ error: "Result not ready" });
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
    createdAt: job.createdAt
  }));
  
  res.json({ jobs: jobList });
});

// Debug search endpoint
app.post("/api/debug-search", async (req, res) => {
  const { name, city } = req.body;
 
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
 
  const isLoggedIn = await ensureLoggedIn();
  if (!isLoggedIn || !page) {
    return res.status(401).json({ error: "Not authenticated. Call /api/login first." });
  }
 
  const log = [];
  const warn = [];
 
  try {
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
      warn.push(`Score ${bestMatch.score.toFixed(4)} is below 0.8 - would NOT be treated as Found`);
    }
 
    const detailUrl = `https://www.charika.ma/${bestMatch.href}`;
    log.push(`Navigating to detail page: ${detailUrl}`);
 
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
 
    const domDiag = await page.evaluate(() => {
      const diag = {
        pageTitle:   document.title,
        h1Text:      document.querySelector("h1")?.innerText.trim() || null,
        tableFound:  !!document.querySelector("div.col-md-7 table.informations-entreprise"),
        tableRows:   [],
        altAddress1: Array.from(document.querySelectorAll(
          "div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label"
        )).map((l) => l.innerText.trim()),
        altAddress2: Array.from(document.querySelectorAll(
          "div.nopaddingleft label"
        )).map((l) => l.innerText.trim()),
        altAddress3: document.querySelector(".adresse, .address, [class*='adresse'], [class*='address']")
          ?.innerText.trim() || null,
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