import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

let iceBrowser;

const CAPTCHA_LEN = 6;
const MAX_OCR_RETRIES = 6;
const MAX_SUBMIT_RETRIES = 4;

async function getIceBrowser() {
  if (!iceBrowser) {
    iceBrowser = await chromium.launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
  return iceBrowser;
}

function normalizeCaptcha(text) {
  if (!text) return "";
  let s = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.length > CAPTCHA_LEN) s = s.slice(0, CAPTCHA_LEN);
  return s;
}

async function callPythonOCR(base64Image) {
  const pythonProcess = spawn("python", ["captcha_solver.py"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  pythonProcess.stdin.write(JSON.stringify({ image: base64Image }));
  pythonProcess.stdin.end();

  const result = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    pythonProcess.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    pythonProcess.on("close", (code) => {
      if (stderr.trim()) console.error("Python stderr:", stderr);

      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`Python exited with code ${code}`));
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Invalid JSON from Python: ${stdout}`));
      }
    });

    pythonProcess.on("error", reject);
  });

  return result;
}

async function screenshotCaptcha(page, attempt) {
  const captchaElement = await page.$("#demandeIceForm\\:capimg");
  if (!captchaElement) throw new Error("CAPTCHA element not found");

  const buffer = await captchaElement.screenshot();

  await fs.mkdir("captchas", { recursive: true });
  await fs.writeFile(path.join("captchas", `captcha_${attempt}.png`), buffer);

  return buffer;
}

async function refreshCaptcha(page) {
  await page.click("#demandeIceForm\\:capimg");
  await page.waitForTimeout(1200);
}

async function solveCaptcha(page) {
  for (let attempt = 1; attempt <= MAX_OCR_RETRIES; attempt++) {
    const buffer = await screenshotCaptcha(page, attempt);
    const base64 = buffer.toString("base64");

    console.log(`Calling OCR... (attempt ${attempt})`);
    const result = await callPythonOCR(base64);

    if (!result.success) {
      console.log("OCR failed:", result.error);
      await refreshCaptcha(page);
      continue;
    }

    const raw = (result.solution || "").trim();
    const cleaned = normalizeCaptcha(raw);

    console.log("OCR raw:", raw);
    console.log("OCR cleaned:", cleaned);

    if (/^[a-z0-9]{6}$/.test(cleaned)) {
      return cleaned;
    }

    await refreshCaptcha(page);
  }

  throw new Error(`OCR failed after ${MAX_OCR_RETRIES} attempts`);
}

async function isCaptchaError(page) {
  const txt = await page.content();
  return (
    txt.includes("code de vérification") ||
    txt.includes("Saisir le code de vérification") ||
    txt.includes("أدخل قن التحقق")
  );
}

export async function fetchIceData(ice) {
  const b = await getIceBrowser();
  const context = await b.newContext();
  const page = await context.newPage();

  try {
    for (let submitAttempt = 1; submitAttempt <= MAX_SUBMIT_RETRIES; submitAttempt++) {
      console.log(`--- ICE Submit Attempt ${submitAttempt}/${MAX_SUBMIT_RETRIES} ---`);

      await page.goto("https://ice.gov.ma/ICE/login.xhtml", {
        waitUntil: "domcontentloaded",
      });

      await page.click("a.form-control-link");
      await page.waitForSelector("#demandeIceForm\\:t12", { timeout: 15000 });

      await page.fill("#demandeIceForm\\:t12", ice);

      console.log("Solving CAPTCHA...");
      const captchaSolution = await solveCaptcha(page);

      await page.fill("#demandeIceForm\\:r", captchaSolution);

      console.log("Submitting search...");
      await page.click("#demandeIceForm\\:demICE1");

      const successSelector = "#anomalieForm\\:listeRechercheIce\\:0\\:j_id_q";

      try {
        await page.waitForSelector(successSelector, { timeout: 12000 });
        console.log("Captcha accepted ✅");
        break;
      } catch {
        await page.screenshot({ path: `submit_fail_${submitAttempt}.png` });

        const captchaWrong = await isCaptchaError(page);

        if (captchaWrong) {
          console.log("Captcha rejected ❌ retrying...");
          continue;
        }

        console.log("No results / unknown error, retrying...");
        continue;
      }
    }

    // now continue scraping result
    await page.waitForSelector("#anomalieForm\\:listeRechercheIce\\:0\\:j_id_q", {
      timeout: 15000,
    });

    await page.click("#anomalieForm\\:listeRechercheIce\\:0\\:j_id_q");

    await page.waitForSelector("#RechercheIceFrontRecapForm\\:t12", {
      timeout: 20000,
    });

    async function getValue(selector) {
      const el = await page.$(selector);
      if (!el) return null;
      return (await el.getAttribute("value")) ?? "";
    }

    return {
      denomination: await getValue("#RechercheIceFrontRecapForm\\:groupe162"),
      nom: await getValue("#RechercheIceFrontRecapForm\\:groupe16100"),
      prenom: await getValue("#RechercheIceFrontRecapForm\\:groupe180"),
      ice: await getValue("#RechercheIceFrontRecapForm\\:t12"),
      identifiantFiscal: await getValue("#RechercheIceFrontRecapForm\\:groupe164"),
      rc: await getValue("#RechercheIceFrontRecapForm\\:groupe168"),
      tribunal: await getValue("#RechercheIceFrontRecapForm\\:groupe170"),
      cnss: await getValue("#RechercheIceFrontRecapForm\\:groupe173"),
    };
  } finally {
    await context.close();
  }
}

export async function closeIceBrowser() {
  if (iceBrowser) {
    await iceBrowser.close();
    iceBrowser = null;
  }
}
