import express from 'express';
import { chromium } from 'playwright';
import levenshtein from 'fast-levenshtein';

const app = express();
app.use(express.json());

import config from './config.js';

const { username, password } = config.auth;

const LEGAL_NOISE = [
  'SOCIETE', 'STE', 'STÉ', 'SARL', 'SA', 'S', 'A', 'R', 'L',
  'COMPAGNIE', 'CIE', 'ET', 'DE', 'DES', 'DU',
  'TRANSPORT', 'TRANS', 'VOYAGE', 'TOURS'
];

// Clean company name for matching
function cleanName(name) {
  if (!name) return '';
  let cleaned = name.toUpperCase();
  LEGAL_NOISE.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    cleaned = cleaned.replace(regex, '');
  });
  return cleaned.replace(/\s+/g, ' ').trim();
}

// Levenshtein similarity (0 → 1)
function similarity(a, b) {
  if (!a || !b) return 0;
  const distance = levenshtein.get(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

// Scrape a single company
async function scrapeCompany(companyName) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Login
    await page.goto('https://www.charika.ma/accueil');
    await page.click('a.UserConnect-login');
    await page.click('button.btn.btn-sm.btn-blue:has-text("Se connecter")');

    await page.locator('input#username:visible').fill(username);
    await page.locator('input#password:visible').fill(password);

    await page.locator('button:has-text("Se connecter"):visible').click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // 2s after login

    // Search
    const searchInput = page.locator('input[name="sDenomination"]:visible');
    await searchInput.waitFor({ timeout: 30000 });
    await searchInput.fill(companyName);
    await searchInput.press('Enter');

    // Keep waitForURL
    await page.waitForURL('**/societe-rechercher**', { timeout: 60000 });
    await page.waitForLoadState('networkidle');

    // Grab all results
    const allResults = page.locator('div.text-soc h5 a');
    const count = await allResults.count();
    const companyClean = cleanName(companyName);

    let selectedIndex = -1;
    let bestScore = 0;
    let foundName = null; // ✅ store actual found name

    // Fuzzy match
    for (let i = 0; i < count; i++) {
      const resultText = (await allResults.nth(i).innerText()).trim();
      const cleanedResult = cleanName(resultText);
      const score = similarity(companyClean, cleanedResult);

      if (score > bestScore) {
        bestScore = score;
        selectedIndex = i;
        foundName = resultText; // ✅ save real name from site
      }
    }

    if (bestScore < 0.8 || selectedIndex === -1) {
      return {
        InputRaisonSociale: companyName,
        FoundRaisonSociale: null,
        Status: 'Not Found',
        BestMatchScore: bestScore
      };
    }

    // Open selected company
    await allResults.nth(selectedIndex).click();
    await page.waitForLoadState('networkidle');

    // Extract company info
    const table = page.locator('div.col-md-7 table.informations-entreprise:visible');
    await table.waitFor({ timeout: 30000 });
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();

    const info = {
      InputRaisonSociale: companyName,   // original input
      FoundRaisonSociale: foundName,     // actual found company name
      Status: 'Found',
      MatchScore: bestScore
    };

    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const field = (await row.locator('td.col-xs-5').innerText()).trim();
      const value = (await row.locator('td.col-xs-7').innerText()).trim();

      if (field.includes('RC')) {
  const { RCNumber, RCTribunal } = parseRC(value);
  info.RCNumber = RCNumber;
  info.RCTribunal = RCTribunal;
}

      else if (field.includes('ICE')) info.ICE = value;
      else if (field.includes('Forme juridique')) info.FormeJuridique = value;
      else if (field.includes('Capital')) info.Capital = value;
      else info[field] = value;
    }

    try {
      info.Address = (await page.locator('div.ligne-tfmw label').first().innerText()).trim();
    } catch {
      info.Address = null;
    }

    return info;

  } catch (err) {
    return {
      InputRaisonSociale: companyName,
      FoundRaisonSociale: null,
      Status: 'Error',
      ErrorMessage: err.message
    };
  } finally {
    await browser.close();
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


/* ---------------- SINGLE COMPANY ENDPOINT ---------------- */
app.post('/api/company', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Company name is required' });

  const result = await scrapeCompany(name);
  res.json(result);
});

/* ---------------- MULTIPLE COMPANIES ENDPOINT ---------------- */
app.post('/api/companies', async (req, res) => {
  const { names } = req.body;
  if (!names || !Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: 'names must be a non-empty array' });
  }

  const results = [];
  for (const name of names) {
    const result = await scrapeCompany(name);
    results.push(result);
  }

  res.json(results);
});

/* ---------------- SERVER ---------------- */
const PORT = 3005;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
