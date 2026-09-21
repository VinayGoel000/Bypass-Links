import { getBrowser } from "./browser.js";
import { logger } from "../utils/logger.js";

export interface BypassResult {
  success: boolean;
  finalUrl?: string;
  method: string;
  stepsCompleted: number;
  error?: string;
  durationMs: number;
}

async function getStepInfo(page: any): Promise<{ current: number; total: number } | null> {
  return page.evaluate(() => {
    const body = document.body?.innerText || "";

    let m = body.match(/step\s*(\d+)\s*\/\s*(\d+)/i);
    if (m) return { current: parseInt(m[1], 10), total: parseInt(m[2], 10) };

    m = body.match(/you\s+are\s+on\s+step\s*(\d+)/i);
    if (m) return { current: parseInt(m[1], 10), total: 3 };

    m = body.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      const c = parseInt(m[1], 10);
      const t = parseInt(m[2], 10);
      if (t >= 1 && t <= 10 && c <= t) return { current: c, total: t };
    }

    return null;
  });
}

async function waitAndGetLink(page: any, timeoutSec: number = 35): Promise<boolean> {
  // Wait for timer to finish
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutSec * 1000) {
    const timerDone = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      if (/timer\s*(complete|ended|done|finished)/i.test(body)) return true;
      if (/link\s+is\s+ready/i.test(body)) return true;
      if (/get\s+link\s+button\s+has\s+been\s+enabled/i.test(body)) return true;
      if (/click\s+to\s+get\s+link/i.test(body)) return true;

      const timerEl = document.querySelector('[id*="timer"], [class*="timer"]');
      if (timerEl) {
        const t = timerEl.textContent || "";
        if (/0[^0-9]|complete|done|ready/i.test(t)) return true;
      }

      return false;
    });

    if (timerDone) {
      logger.info("Timer done");
      await new Promise((r) => setTimeout(r, 2000));
      break;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  // Now click the Get Link button
  const result = await page.evaluate(() => {
    // Find by ID
    const idSelectors = ['#getlink', '#get-link', '#get_link', '[id*="getlink"]', '[id*="get-link"]'];
    for (const sel of idSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          (el as HTMLElement).click();
          return "clicked";
        }
      }
    }

    // Find by text
    const allBtns = document.querySelectorAll("a, button");
    for (const btn of Array.from(allBtns)) {
      const text = (btn.textContent || "").trim();
      if (/^get\s*link$/i.test(text) || /^get\s+your\s+link$/i.test(text)) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const href = btn.tagName === "A" ? (btn as HTMLAnchorElement).href : null;
          if (href && href.startsWith("http")) {
            return href; // Return the URL to navigate to
          }
          (btn as HTMLElement).click();
          return "clicked";
        }
      }
    }

    // Find data-href button
    const dataBtns = document.querySelectorAll("[data-href]");
    for (const btn of Array.from(dataBtns)) {
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const href = btn.getAttribute("data-href");
        if (href && href.startsWith("http")) {
          return href;
        }
      }
    }

    return null;
  });

  if (result === "clicked") {
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }
  if (result && result.startsWith("http")) {
    await page.goto(result, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }

  // Try reload to trigger JS redirect
  const currentUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000));

  if (page.url() !== currentUrl) {
    return true;
  }

  return false;
}

async function extractFinalLinkFromPage(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const body = document.body?.innerText || "";

    // Check for "Your link is ready" type messages
    if (/your\s+link\s+is\s+ready/i.test(body) || /final\s+link/i.test(body)) {
      const links = document.querySelectorAll("a[href]");
      for (const a of Array.from(links)) {
        const href = (a as HTMLAnchorElement).href;
        const text = (a.textContent || "").trim();
        if (/get\s*link|download|continue|final/i.test(text) && href.startsWith("http")) {
          return href;
        }
      }
    }

    return null;
  });
}

export async function bypassUrl(url: string): Promise<BypassResult> {
  const startTime = Date.now();
  logger.info("Starting bypass", { url });

  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return {
      success: false,
      error: `Browser launch failed: ${(err as Error).message}`,
      method: "Browser",
      stepsCompleted: 0,
      durationMs: Date.now() - startTime,
    };
  }

  let page: any = null;

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1920, height: 1080 });

    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      const type = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    logger.info("Navigating to URL", { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 3000));

    let stepsCompleted = 0;
    const maxSteps = 10;

    for (let step = 0; step < maxSteps; step++) {
      const currentUrl = page.url();

      // Check step indicator
      const stepInfo = await getStepInfo(page);

      if (!stepInfo) {
        // No step indicator - check if there's a "get final link" button
        const finalLink = await extractFinalLinkFromPage(page);
        if (finalLink) {
          logger.info("Found final link on page", { url: finalLink });
          await page.goto(finalLink, { waitUntil: "domcontentloaded", timeout: 15000 });
          await new Promise((r) => setTimeout(r, 2000));
          stepsCompleted++;
          break;
        }

        logger.info("No step indicator, reached end", { url: currentUrl });
        break;
      }

      logger.info("Step detected", { current: stepInfo.current, total: stepInfo.total, url: currentUrl });

      // Wait for timer and click Get Link
      const moved = await waitAndGetLink(page);

      if (page.url() !== currentUrl) {
        logger.info("Moved to next page", { url: page.url() });
        stepsCompleted++;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (!moved) {
        logger.info("Could not move to next step");
        break;
      }

      stepsCompleted++;
      await new Promise((r) => setTimeout(r, 2000));
    }

    const finalUrl = page.url();

    // Don't return the same URL as input
    if (finalUrl === url) {
      return {
        success: false,
        error: "Could not bypass the link shortener",
        method: "Browser",
        stepsCompleted,
        durationMs: Date.now() - startTime,
      };
    }

    logger.info("Bypass completed", { finalUrl, steps: stepsCompleted });

    return {
      success: true,
      finalUrl,
      method: "Browser Bypass",
      stepsCompleted,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    logger.error("Bypass error", { error: (err as Error).message });
    return {
      success: false,
      error: (err as Error).message,
      method: "Browser",
      stepsCompleted: 0,
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}
