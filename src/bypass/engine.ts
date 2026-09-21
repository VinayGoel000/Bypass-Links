import { inspectHtml } from "./html-inspector.js";
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

// ==================== APPROACH 1: HTML INSPECTION ====================
// Fastest (1-3 sec), no browser needed

async function tryHtmlInspection(url: string): Promise<BypassResult | null> {
  const result = await inspectHtml(url);

  if (result.found && result.finalUrl) {
    // Verify this URL is not the same as input or another shortener page
    if (result.finalUrl !== url) {
      logger.info("HTML inspection succeeded", { method: result.method, url: result.finalUrl });
      return {
        success: true,
        finalUrl: result.finalUrl,
        method: `HTML Inspection (${result.method})`,
        stepsCompleted: 0,
        durationMs: 0,
      };
    }
  }

  return null;
}

// ==================== APPROACH 2: TIMER SKIP + BUTTON CLICK ====================
// Medium speed (5-10 sec), uses browser but skips timers

async function tryTimerSkip(url: string): Promise<BypassResult | null> {
  let browser;
  try {
    browser = await getBrowser();
  } catch {
    return null;
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

    // Override Date.now() to skip timers
    await page.evaluateOnNewDocument(() => {
      const offset = 60000; // 60 seconds offset
      const originalNow = Date.now;
      (Date as any).now = () => originalNow() + offset;

      // Clear all existing timers
      for (let i = 1; i < 99999; i++) {
        clearTimeout(i);
        clearInterval(i);
      }
    });

    logger.info("Timer skip: navigating", { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 2000));

    // Inject script to override timers after page load too
    await page.evaluate(() => {
      // Override Date.now
      const offset = 60000;
      const originalNow = Date.now;
      (Date as any).now = () => originalNow() + offset;

      // Override setTimeout to fire immediately
      const originalSetTimeout = window.setTimeout;
      (window as any).setTimeout = (fn: Function, ms: number) => {
        if (ms > 1000) {
          return originalSetTimeout(fn, 10); // Fire almost immediately
        }
        return originalSetTimeout(fn, ms);
      };

      // Override setInterval
      const originalSetInterval = window.setInterval;
      (window as any).setInterval = (fn: Function, ms: number) => {
        return originalSetInterval(fn, Math.min(ms, 100));
      };
    });

    await new Promise((r) => setTimeout(r, 2000));

    let stepsCompleted = 0;
    const maxSteps = 10;

    for (let step = 0; step < maxSteps; step++) {
      const currentUrl = page.url();

      // Check for step indicator
      const hasStep = await page.evaluate(() => {
        const body = document.body?.innerText || "";
        return /step\s*\d+\s*\/\s*\d+/i.test(body) || /you\s+are\s+on\s+step/i.test(body);
      });

      if (!hasStep) {
        logger.info("Timer skip: no step indicator, checking final page");
        break;
      }

      logger.info("Timer skip: step detected", { step: step + 1 });

      // Try clicking Get Link button
      const clicked = await page.evaluate(() => {
        const selectors = [
          '#getlink', '#get-link', '#get_link',
          '[id*="getlink"]', '[id*="get-link"]',
          '.getlink', '.get-link',
        ];

        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              (el as HTMLElement).click();
              return true;
            }
          }
        }

        const btns = document.querySelectorAll("a, button");
        for (const btn of Array.from(btns)) {
          const text = (btn.textContent || "").trim();
          if (/^get\s*link$/i.test(text)) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const href = btn.tagName === "A" ? (btn as HTMLAnchorElement).href : null;
              if (href && href.startsWith("http")) {
                window.location.href = href;
                return true;
              }
              (btn as HTMLElement).click();
              return true;
            }
          }
        }

        return false;
      });

      if (clicked) {
        await new Promise((r) => setTimeout(r, 3000));
        stepsCompleted++;

        if (page.url() !== currentUrl) {
          continue;
        }
      }

      // Try reload
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await new Promise((r) => setTimeout(r, 2000));

      if (page.url() !== currentUrl) {
        stepsCompleted++;
        continue;
      }

      break;
    }

    const finalUrl = page.url();

    // Verify it's not the same as input
    if (finalUrl === url) {
      return null;
    }

    logger.info("Timer skip: completed", { url: finalUrl, steps: stepsCompleted });
    return {
      success: true,
      finalUrl,
      method: "Timer Skip + Browser",
      stepsCompleted,
      durationMs: 0,
    };
  } catch (err) {
    logger.error("Timer skip failed", { error: (err as Error).message });
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ==================== APPROACH 3: FULL BROWSER FLOW ====================
// Slowest (15-30 sec), handles complex multi-step flows

async function tryFullBrowser(url: string): Promise<BypassResult> {
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return {
      success: false,
      error: `Browser launch failed: ${(err as Error).message}`,
      method: "Full Browser",
      stepsCompleted: 0,
      durationMs: 0,
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

    logger.info("Full browser: navigating", { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 3000));

    let stepsCompleted = 0;
    const maxSteps = 10;

    for (let step = 0; step < maxSteps; step++) {
      const currentUrl = page.url();

      const hasStep = await page.evaluate(() => {
        const body = document.body?.innerText || "";
        return /step\s*\d+\s*\/\s*\d+/i.test(body) || /you\s+are\s+on\s+step/i.test(body);
      });

      if (!hasStep) {
        logger.info("Full browser: no step indicator");
        break;
      }

      logger.info("Full browser: step", { step: step + 1 });

      // Wait for timer (real wait)
      await page.waitForFunction(
        () => {
          const body = document.body?.innerText || "";
          if (/please\s+wait/i.test(body) && !/complete|ended|ready/i.test(body)) return false;
          const timerEl = document.querySelector('[id*="timer"], [class*="timer"]');
          if (timerEl) {
            const t = timerEl.textContent || "";
            if (/\d+/.test(t) && !/0|complete|done/i.test(t)) return false;
          }
          return true;
        },
        { timeout: 30000, polling: 1000 }
      ).catch(() => {});

      await new Promise((r) => setTimeout(r, 2000));

      // Click Get Link
      const clicked = await page.evaluate(() => {
        const selectors = [
          '#getlink', '#get-link', '#get_link',
          '[id*="getlink"]', '[id*="get-link"]',
          '.getlink', '.get-link',
        ];

        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              (el as HTMLElement).click();
              return true;
            }
          }
        }

        const btns = document.querySelectorAll("a, button");
        for (const btn of Array.from(btns)) {
          const text = (btn.textContent || "").trim();
          if (/^get\s*link$/i.test(text)) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const href = btn.tagName === "A" ? (btn as HTMLAnchorElement).href : null;
              if (href && href.startsWith("http")) {
                window.location.href = href;
                return true;
              }
              (btn as HTMLElement).click();
              return true;
            }
          }
        }

        return false;
      });

      if (clicked) {
        await new Promise((r) => setTimeout(r, 3000));
        stepsCompleted++;

        if (page.url() !== currentUrl) continue;
      }

      // Reload
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await new Promise((r) => setTimeout(r, 2000));

      if (page.url() !== currentUrl) {
        stepsCompleted++;
        continue;
      }

      break;
    }

    const finalUrl = page.url();

    return {
      success: true,
      finalUrl,
      method: "Full Browser",
      stepsCompleted,
      durationMs: 0,
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
      method: "Full Browser",
      stepsCompleted: 0,
      durationMs: 0,
    };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ==================== MAIN HYBRID FUNCTION ====================

export async function bypassUrl(url: string): Promise<BypassResult> {
  const startTime = Date.now();
  logger.info("Starting hybrid bypass", { url });

  // APPROACH 1: HTML Inspection (fastest - 1-3 sec)
  logger.info("Trying HTML inspection...");
  const htmlResult = await tryHtmlInspection(url);
  if (htmlResult) {
    htmlResult.durationMs = Date.now() - startTime;
    return htmlResult;
  }

  // APPROACH 2: Timer Skip + Browser (medium - 5-10 sec)
  logger.info("Trying timer skip...");
  const timerResult = await tryTimerSkip(url);
  if (timerResult) {
    timerResult.durationMs = Date.now() - startTime;
    return timerResult;
  }

  // APPROACH 3: Full Browser (slow - 15-30 sec)
  logger.info("Falling back to full browser flow...");
  const fullResult = await tryFullBrowser(url);
  fullResult.durationMs = Date.now() - startTime;
  return fullResult;
}
