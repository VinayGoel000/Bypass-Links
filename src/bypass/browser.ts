import fs from "node:fs/promises";
import { logger } from "../utils/logger.js";

let browserInstance: any = null;

/** Well-known system Chrome/Chromium locations (Linux + Windows + macOS). */
const SYSTEM_CHROME_CANDIDATES: string[] = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
  "/snap/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a Chrome executable in this order:
 * 1. CHROME_PATH env var (explicit override)
 * 2. Full `puppeteer` package's bundled Chromium (downloaded on npm install)
 * 3. Well-known system install locations
 * Returns undefined when nothing is found — the caller then lets
 * puppeteer pick its default.
 */
async function resolveChromePath(): Promise<string | undefined> {
  if (process.env.CHROME_PATH && (await fileExists(process.env.CHROME_PATH))) {
    return process.env.CHROME_PATH;
  }

  try {
    const puppeteer = await import("puppeteer");
    const bundled = (puppeteer as any).executablePath?.();
    if (typeof bundled === "string" && (await fileExists(bundled))) {
      logger.info("Using puppeteer bundled Chromium", { path: bundled });
      return bundled;
    }
  } catch {
    // Full puppeteer not installed; fall through to system candidates.
  }

  for (const candidate of SYSTEM_CHROME_CANDIDATES) {
    if (await fileExists(candidate)) {
      logger.info("Using system Chrome", { path: candidate });
      return candidate;
    }
  }

  return undefined;
}

async function loadPuppeteer(): Promise<any> {
  try {
    return await import("puppeteer");
  } catch {
    logger.warn("Full puppeteer not found, falling back to puppeteer-core");
    return await import("puppeteer-core");
  }
}

export async function getBrowser(): Promise<any> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  const puppeteer = await loadPuppeteer();
  const executablePath = await resolveChromePath();

  logger.info("Launching headless browser", { executablePath: executablePath ?? "<puppeteer default>" });

  const launchOptions: Record<string, unknown> = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
      "--disable-popup-blocking",
      "--window-size=1920,1080",
    ],
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  browserInstance = await puppeteer.launch(launchOptions);

  logger.info("Browser launched successfully");
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    logger.info("Browser closed");
  }
}
