import { logger } from "../utils/logger.js";

let browserInstance: any = null;

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export async function getBrowser(): Promise<any> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  logger.info("Launching headless browser", { path: CHROME_PATH });

  const puppeteer = await import("puppeteer-core");

  browserInstance = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
      "--window-size=1920,1080",
    ],
  });

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
