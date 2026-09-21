import { getBrowser } from "./browser.js";
import { logger } from "../utils/logger.js";

export interface BypassResult {
  success: boolean;
  finalUrl?: string;
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

async function waitForTimer(page: any, maxWaitSec: number = 30): Promise<void> {
  const start = Date.now();
  const maxMs = maxWaitSec * 1000;

  while (Date.now() - start < maxMs) {
    const done = await page.evaluate(() => {
      const body = document.body?.innerText || "";

      if (/timer\s*(complete|ended|done|finished)/i.test(body)) return true;
      if (/link\s+is\s+ready/i.test(body)) return true;
      if (/click\s+to\s+continue/i.test(body)) return true;
      if (/your\s+link\s+is\s+ready/i.test(body)) return true;
      if (/get\s+link\s+button\s+has\s+been\s+enabled/i.test(body)) return true;

      const timerEl = document.querySelector('[id*="timer"], [class*="timer"]');
      if (timerEl) {
        const t = timerEl.textContent || "";
        if (/0[^.]|complete|done|ready/i.test(t)) return true;
        if (/^\s*\d{1,2}\s*$/.test(t.trim())) {
          const num = parseInt(t.trim(), 10);
          if (num === 0) return true;
        }
      }

      return false;
    });

    if (done) {
      logger.info("Timer completed");
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }

    const timerText = await page.evaluate(() => {
      const timerEl = document.querySelector('[id*="timer"], [class*="timer"]');
      return timerEl?.textContent?.trim() || "";
    });

    if (timerText) {
      logger.debug("Timer text", { text: timerText });
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info("Timer wait timeout, continuing");
}

async function findAndClickGetLink(page: any): Promise<boolean> {
  // Strategy 1: Find visible "Get Link" button by ID or class
  const clicked1 = await page.evaluate(() => {
    const selectors = [
      '#getlink', '#get-link', '#get_link',
      '[id*="getlink"]', '[id*="get-link"]', '[id*="get_link"]',
      '.getlink', '.get-link', '.get_link',
      '[class*="getlink"]', '[class*="get-link"]',
      '#btn-get-link', '#btnGetLink',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        if (visible) {
          el.scrollIntoView();
          (el as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  });

  if (clicked1) {
    logger.info("Clicked Get Link button by ID/class");
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }

  // Strategy 2: Find anchor/button with "Get Link" text that's visible
  const clicked2 = await page.evaluate(() => {
    const elements = document.querySelectorAll("a, button");
    const patterns = /^(get\s*link|get\s+your\s+link|continue\s+to\s+link|proceed|skip\s+ad|visit\s+link)$/i;

    for (const el of Array.from(elements)) {
      const text = (el.textContent || "").trim();
      if (patterns.test(text)) {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const style = window.getComputedStyle(el);
        const display = style.display;
        const hidden = display === "none" || style.visibility === "hidden";

        if (visible && !hidden) {
          const href = el.tagName === "A" ? (el as HTMLAnchorElement).href : null;
          if (href && href.startsWith("http")) {
            window.location.href = href;
            return "navigate";
          }
          (el as HTMLElement).click();
          return "clicked";
        }
      }
    }
    return null;
  });

  if (clicked2 === "navigate") {
    logger.info("Navigated via Get Link anchor");
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }
  if (clicked2 === "clicked") {
    logger.info("Clicked Get Link button by text");
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }

  // Strategy 3: Find data-href on button-like elements
  const clicked3 = await page.evaluate(() => {
    const btns = document.querySelectorAll("a[data-href], button[data-href], div[data-href], span[data-href]");
    for (const btn of Array.from(btns)) {
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const href = btn.getAttribute("data-href");
        if (href && href.startsWith("http")) {
          window.location.href = href;
          return true;
        }
      }
    }
    return false;
  });

  if (clicked3) {
    logger.info("Navigated via data-href button");
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }

  // Strategy 4: Find the LAST large/visible link (likely the Get Link button)
  const lastLink = await page.evaluate(() => {
    const links = document.querySelectorAll("a[href]");
    let bestLink: string | null = null;
    let bestArea = 0;

    for (const a of Array.from(links)) {
      const href = (a as HTMLAnchorElement).href;
      if (!href.startsWith("http")) continue;

      const rect = a.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 20) continue;

      const style = window.getComputedStyle(a);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const area = rect.width * rect.height;
      const text = (a.textContent || "").trim();

      // Skip navigation links, footer links
      if (/^(home|about|contact|privacy|terms|menu|logo)$/i.test(text)) continue;
      if (text.length > 50) continue;

      // Prefer buttons with action text
      const isAction = /get|link|download|continue|proceed|visit|claim|open/i.test(text);

      if (isAction || area > bestArea) {
        bestArea = area;
        bestLink = href;
      }
    }

    return bestLink;
  });

  if (lastLink) {
    logger.info("Found prominent link", { url: lastLink });
    await page.goto(lastLink, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  }

  return false;
}

async function pageChangedAfterReload(page: any, oldUrl: string): Promise<boolean> {
  const currentUrl = page.url();

  // Check if JS redirected us
  if (currentUrl !== oldUrl) return true;

  // Check if page content changed (step counter updated)
  const contentHash = await page.evaluate(() => {
    return document.body?.innerText?.substring(0, 500) || "";
  });

  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000));

  const newContentHash = await page.evaluate(() => {
    return document.body?.innerText?.substring(0, 500) || "";
  });

  const newUrl = page.url();
  if (newUrl !== oldUrl) return true;
  if (contentHash !== newContentHash) return true;

  return false;
}

export async function bypassUrl(url: string): Promise<BypassResult> {
  const startTime = Date.now();
  logger.info("Starting Puppeteer bypass", { url });

  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return {
      success: false,
      error: `Browser launch failed: ${(err as Error).message}`,
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
    let lastUrl = page.url();

    for (let step = 0; step < maxSteps; step++) {
      const currentUrl = page.url();
      logger.info("Processing step", { step: step + 1, url: currentUrl });

      const stepInfo = await getStepInfo(page);

      if (!stepInfo) {
        // No step indicator - check if this is truly the final page
        logger.info("No step indicator found");
        const clicked = await findAndClickGetLink(page);
        if (clicked && page.url() !== currentUrl) {
          stepsCompleted++;
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        logger.info("Reached final page", { url: page.url() });
        break;
      }

      logger.info("Step detected", { current: stepInfo.current, total: stepInfo.total });

      // Wait for timer
      await waitForTimer(page);

      // After timer, try clicking Get Link button
      const clicked = await findAndClickGetLink(page);

      if (clicked) {
        const newUrl = page.url();
        if (newUrl !== currentUrl) {
          logger.info("Step completed - navigated to", { url: newUrl });
          stepsCompleted++;
          lastUrl = newUrl;
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
      }

      // If button click didn't navigate, try reload to trigger JS redirect
      logger.info("Trying page reload to trigger JS redirect");
      const changed = await pageChangedAfterReload(page, currentUrl);

      if (changed) {
        logger.info("Page changed after reload", { url: page.url() });
        stepsCompleted++;
        lastUrl = page.url();
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      // Last resort: wait more and try button again
      logger.info("Waiting additional time for page update");
      await new Promise((r) => setTimeout(r, 5000));

      const retryClicked = await findAndClickGetLink(page);
      if (retryClicked && page.url() !== currentUrl) {
        stepsCompleted++;
        lastUrl = page.url();
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      logger.info("No progress possible, stopping");
      break;
    }

    const finalUrl = page.url();

    return {
      success: true,
      finalUrl,
      stepsCompleted,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    logger.error("Bypass error", { error: (err as Error).message });
    return {
      success: false,
      error: (err as Error).message,
      stepsCompleted: 0,
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}
