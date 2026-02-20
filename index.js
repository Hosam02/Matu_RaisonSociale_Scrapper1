import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import levenshtein from "fast-levenshtein";
import config from "./config.js";
import { fetchIceData } from "./icegov.js";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/status' });

app.use(express.json());

const { username, password } = config.auth;
const LEGAL_NOISE = new Set([
  "SOCIETE","STE","STÉ","SARL","SA","S","A","R","L",
  "COMPAGNIE","CIE","ET","DE","DES","DU","TRANSPORT","TRANS","VOYAGE","TOURS"
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
  let cleaned = name.toUpperCase();
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
const wsClients = new Map(); // Use Map to store client info

// Track browser usage
let lastUsed = Date.now();
const BROWSER_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const SESSION_REFRESH_INTERVAL = 25 * 60 * 1000; // Refresh session every 25 minutes

/* =======================
   WEBSOCKET STATUS BROADCAST
======================= */

// Broadcast status to all connected WebSocket clients
function broadcastStatus(update = {}) {
  // Update session age if logged in
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
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    } else if (client.readyState === 3) { // CLOSED
      wsClients.delete(client);
    }
  });
}

// Update login status and broadcast
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
  
  // Store client with metadata
  wsClients.set(ws, {
    id: clientId,
    ip: clientIp,
    connectedAt: new Date().toISOString(),
    lastPing: Date.now(),
    reconnectCount: 0
  });
  
  // Send initial status immediately
  ws.send(JSON.stringify({
    type: 'welcome',
    clientId: clientId,
    message: 'Connected to Charika API WebSocket',
    timestamp: new Date().toISOString()
  }));
  
  broadcastStatus();
  
  // Handle client messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // Update last ping time
      const clientInfo = wsClients.get(ws);
      if (clientInfo) {
        clientInfo.lastPing = Date.now();
        wsClients.set(ws, clientInfo);
      }
      
      switch(data.type) {
        case 'ping':
          ws.send(JSON.stringify({ 
            type: 'pong', 
            timestamp: Date.now() 
          }));
          break;
          
        case 'get_status':
          ws.send(JSON.stringify({
            type: 'status',
            data: loginStatus
          }));
          break;
          
        case 'request_login':
          ws.send(JSON.stringify({ 
            type: 'login_started', 
            message: 'Login process initiated',
            timestamp: new Date().toISOString()
          }));
          
          // Trigger login asynchronously
          initializeBrowserAndLogin().catch(error => {
            console.error('Login error:', error);
            updateLoginStatus({ 
              status: 'error', 
              error: error.message 
            });
          });
          break;
          
        default:
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Unknown command' 
          }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Invalid message format' 
      }));
    }
  });

  // Handle disconnection
  ws.on('close', (code, reason) => {
    const clientInfo = wsClients.get(ws);
    console.log(`🔌 WebSocket client disconnected: ${clientInfo?.id || 'unknown'} (Code: ${code}, Reason: ${reason})`);
    wsClients.delete(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    const clientInfo = wsClients.get(ws);
    console.error(`WebSocket client error for ${clientInfo?.id || 'unknown'}:`, error);
    wsClients.delete(ws);
  });
});

// Ping all clients periodically to detect stale connections
setInterval(() => {
  const now = Date.now();
  wsClients.forEach((clientInfo, client) => {
    if (client.readyState === 1) { // OPEN
      // Check if client hasn't pinged in last 30 seconds
      if (now - clientInfo.lastPing > 30000) {
        console.log(`Client ${clientInfo.id} inactive, sending ping...`);
        client.send(JSON.stringify({ type: 'ping' }));
      }
    } else if (client.readyState === 3) { // CLOSED
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
    updateLoginStatus({ 
      status: 'connecting', 
      error: null 
    });
    
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
    const loggedInIndicator = await page.locator('.user-connected, a.UserConnect-login').first().isVisible()
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
    updateLoginStatus({ 
      isLoggedIn: false, 
      status: 'error',
      error: error.message 
    });
    return false;
  }
}

/* =======================
   SEARCH ENDPOINT
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

async function performSearch(companyName, city) {
  const normalizedCity = city ? normalizeString(city) : null;
  
  await page.goto("https://www.charika.ma/accueil", { 
    waitUntil: "domcontentloaded",
    timeout: 8000
  });
  
  const searchInput = await page.waitForSelector(
    'input.rq-form-element[name="sDenomination"]:visible, ' +
    'input[placeholder*="raison sociale"]:visible', 
    { timeout: 5000 }
  );
  
  await searchInput.fill("");
  await searchInput.type(companyName, { delay: 20 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 }),
    searchInput.press("Enter")
  ]);
  
  const results = await page.$$eval('div.text-soc', (items) => {
    return items.map(item => {
      const link = item.querySelector('h5 a');
      const name = link?.innerText.trim() || '';
      const href = link?.getAttribute('href') || '';
      
      const addressLabels = Array.from(item.querySelectorAll(
        'div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label'
      )).map(l => l.innerText.trim());
      const address = addressLabels.join(' ');
      
      return { name, href, address };
    });
  });
  
  if (results.length === 0) {
    return {
      InputRaisonSociale: companyName,
      Status: "Not Found"
    };
  }
  
  const companyClean = cleanName(companyName);
  let bestMatch = { index: -1, score: 0, name: '', href: '' };
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const cleanedResult = cleanName(result.name);
    const score = similarity(companyClean, cleanedResult);
    
    if (score === 1 && (!normalizedCity || normalizeString(result.address).includes(normalizedCity))) {
      bestMatch = { index: i, score: 1, name: result.name, href: result.href };
      break;
    }
    
    if (score > bestMatch.score) {
      bestMatch = { index: i, score, name: result.name, href: result.href };
    }
  }
  
  if (bestMatch.score < 0.8 || bestMatch.index === -1) {
    return {
      InputRaisonSociale: companyName,
      Status: "Not Found",
      MatchScore: bestMatch.score
    };
  }
  
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 }),
    page.goto(`https://www.charika.ma/${bestMatch.href}`)
  ]);
  
  const info = await page.evaluate(({ companyName, foundName, bestScore }) => {
    const result = {
      InputRaisonSociale: companyName,
      FoundRaisonSociale: foundName,
      Status: "Found",
      MatchScore: bestScore
    };
    
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
          } else if (field.includes('ICE')) result.ICE = value;
          else if (field.includes('Forme juridique')) result.FormeJuridique = value;
          else if (field.includes('Capital')) result.Capital = value;
          else result[field] = value;
        }
      });
    }
    
    const addressLabels = Array.from(document.querySelectorAll(
      'div.col-md-8.col-sm-8.col-xs-8.nopaddingleft label'
    )).map(l => l.innerText.trim());
    if (addressLabels.length) {
      result.Address = addressLabels.join(' ');
    }
    
    return result;
  }, { 
    companyName, 
    foundName: bestMatch.name, 
    bestScore: bestMatch.score 
  });
  
  if (normalizedCity && info.Address) {
    info.CityMatches = normalizeString(info.Address).includes(normalizedCity);
  }
  
  return info;
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
    lastLoginAttempt: null,
    error: null,
    sessionAge: null
  };
  
  res.json({ 
    success: true, 
    message: "Logged out successfully" 
  });
});


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