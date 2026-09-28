import { getBrowser } from "./browser.js";
import { logger } from "../utils/logger.js";
import { isAdUrl } from "./adblock.js";
import { ACTION_TEXT_PATTERNS, ACTION_SELECTOR_HINTS } from "./page-actions.js";
import { resolveAndValidate } from "../security/ssrf-protection.js";

export interface BypassResult {
  success: boolean;
  finalUrl?: string;
  method: string;
  stepsCompleted: number;
  error?: string;
  durationMs: number;
}

export interface BypassProgress {
  /** 0-based step index */
  step: number;
  message: string;
}

export type BypassProgressFn = (p: BypassProgress) => void;

const MAX_STEPS = 12;
const STEP_TIMER_WAIT_MS = 45_000;
const PAGE_GOTO_TIMEOUT_MS = 25_000;

function totalBudgetMs(): number {
  const raw = parseInt(process.env.BYPASS_TIMEOUT_MS || "150000", 10);
  return isNaN(raw) || raw <= 0 ? 150_000 : raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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

/**
 * Poll the page until the timer/countdown looks finished or an action
 * button becomes clickable. Returns early when the page navigates away.
 */
async function waitForTimerOrReady(page: any, timeoutMs: number): Promise<"ready" | "timeout"> {
  const start = Date.now();
  const initialUrl = page.url();

  while (Date.now() - start < timeoutMs) {
    if (page.url() !== initialUrl) return "ready";

    const state = await page.evaluate(
      (patterns: string[]) => {
        const body = document.body?.innerText || "";
        const lower = body.toLowerCase();

        const donePhrases = [
          "timer complete",
          "timer ended",
          "timer done",
          "timer finished",
          "link is ready",
          "links are ready",
          "your link is ready",
          "get link button has been enabled",
          "click to get link",
          "you can now continue",
        ];
        if (donePhrases.some((p) => lower.includes(p))) return { ready: true };

        const timerEl = document.querySelector('[id*="timer"], [class*="timer"], [id*="countdown"], [class*="countdown"]');
        if (timerEl) {
          const t = (timerEl.textContent || "").trim().toLowerCase();
          if (/\b(complete|completed|done|finished|ready|expired)\b/.test(t)) return { ready: true };
          if (/^0+(\D|$)/.test(t)) return { ready: true };
          if (/\b0\s*(sec(ond)?s?|s)\b/.test(t)) return { ready: true };
        }

        // Any action button already enabled + visible?
        const res = patterns.map((p) => new RegExp(p, "i"));
        const btns = Array.from(document.querySelectorAll("a, button, input[type=submit], input[type=button]"));
        for (const b of btns) {
          const el = b as HTMLElement;
          const text = (el.innerText || (el as HTMLInputElement).value || "").trim().replace(/\s+/g, " ");
          if (!text || !res.some((r) => r.test(text))) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if ((el as HTMLButtonElement).disabled) continue;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
          return { ready: true };
        }

        return { ready: false };
      },
      ACTION_TEXT_PATTERNS
    );

    if (state?.ready) {
      logger.info("Timer done / action button ready");
      await sleep(1500);
      return "ready";
    }

    await sleep(1000);
  }

  return "timeout";
}

type ClickOutcome = "clicked" | { href: string } | null;

/**
 * Find the main action button (Get Link / Continue / Proceed / Unlock /
 * Download …) and click it. If it is a plain anchor with an http href,
 * return the href so the caller can navigate directly.
 */
async function clickActionButton(page: any): Promise<ClickOutcome> {
  return page.evaluate(
    (patterns: string[], selectorHints: string[]) => {
      const res = patterns.map((p) => new RegExp(p, "i"));
      const norm = (s: string) => (s || "").trim().replace(/\s+/g, " ");
      const visible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return !(style.display === "none" || style.visibility === "hidden" || style.opacity === "0");
      };

      // 1. Known id / class hints
      for (const hint of selectorHints) {
        for (const sel of [`#${hint}`, `.${hint}`, `[id*="${hint}"]`, `[class*="${hint}"]`]) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && visible(el) && !(el as HTMLButtonElement).disabled) {
            if (el.tagName === "A") {
              const href = (el as HTMLAnchorElement).href;
              if (href && /^https?:\/\//i.test(href)) return { href };
            }
            el.click();
            return "clicked";
          }
        }
      }

      // 2. Buttons / links whose visible text matches an action pattern
      const candidates = Array.from(
        document.querySelectorAll("a, button, input[type=submit], input[type=button], [role=button]")
      ) as HTMLElement[];
      for (const el of candidates) {
        const text = norm(el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "");
        if (!text || !res.some((r) => r.test(text))) continue;
        if (!visible(el) || (el as HTMLButtonElement).disabled) continue;
        if (el.tagName === "A") {
          const href = (el as HTMLAnchorElement).href;
          if (href && /^https?:\/\//i.test(href)) return { href };
        }
        el.click();
        return "clicked";
      }

      // 3. data-href / data-url style buttons
      for (const el of Array.from(document.querySelectorAll("[data-href], [data-url], [data-link]")) as HTMLElement[]) {
        if (!visible(el)) continue;
        const href = el.getAttribute("data-href") || el.getAttribute("data-url") || el.getAttribute("data-link");
        if (href && /^https?:\/\//i.test(href)) return { href };
      }

      return null;
    },
    ACTION_TEXT_PATTERNS,
    ACTION_SELECTOR_HINTS
  );
}

async function extractFinalLinkFromPage(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const body = document.body?.innerText || "";

    if (/your\s+links?\s+(is|are)\s+ready|final\s+link|download\s+link/i.test(body)) {
      const links = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      for (const a of links) {
        const href = a.href;
        const text = (a.textContent || "").trim();
        if (/get\s*link|download|continue|final|visit/i.test(text) && /^https?:\/\//i.test(href)) {
          return href;
        }
      }
      // Fallback: any external link on a "ready" page
      for (const a of links) {
        if (/^https?:\/\//i.test(a.href)) return a.href;
      }
    }

    return null;
  });
}

interface TriageResult {
  page: any;
  switched: boolean;
}

/**
 * After clicking an action button, shortener pages often open popup ads
 * in new tabs while the real next step opens in another tab (or the
 * same tab navigates). Close ad/blank popup tabs and switch to the
 * legitimate new tab when there is one.
 */
async function triageTabs(browser: any, mainPage: any, knownPages: Set<any>): Promise<TriageResult> {
  await sleep(2500);

  const pages: any[] = await browser.pages();
  const fresh = pages.filter((p) => !knownPages.has(p));

  let switched: any = null;

  for (const p of fresh) {
    let url = "";
    try {
      url = p.url();
    } catch {
      continue;
    }

    // Give about:blank a moment in case it is still loading
    if (url === "about:blank") {
      await sleep(1500);
      try {
        url = p.url();
      } catch {
        continue;
      }
    }

    if (url === "about:blank" || isAdUrl(url)) {
      logger.info("Closing ad/popup tab", { url });
      await p.close().catch(() => {});
      continue;
    }

    // Legitimate new tab — prefer it, but only one
    if (!switched) {
      switched = p;
    } else {
      // Extra unexpected tab: close it to stay tidy
      await p.close().catch(() => {});
    }
  }

  if (switched) {
    logger.info("Switching to new tab", { url: switched.url() });
    await mainPage.close().catch(() => {});
    return { page: switched, switched: true };
  }

  return { page: mainPage, switched: false };
}

/** SSRF guard for any URL the server-side browser is about to load. */
async function assertSafeToLoad(rawUrl: string): Promise<string | null> {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }
  const check = await resolveAndValidate(hostname);
  if (!check.safe) {
    logger.warn("SSRF blocked browser navigation", { url: rawUrl, error: check.error });
    return check.error || "Blocked by SSRF protection";
  }
  return null;
}

export async function bypassUrl(url: string, onProgress?: BypassProgressFn): Promise<BypassResult> {
  const startTime = Date.now();
  const budgetMs = totalBudgetMs();
  const deadline = startTime + budgetMs;
  const progress = (step: number, message: string) => {
    try {
      onProgress?.({ step, message });
    } catch {}
  };

  logger.info("Starting bypass", { url });
  progress(0, "Starting bypass…");

  const blocked = await assertSafeToLoad(url);
  if (blocked) {
    return { success: false, error: blocked, method: "Browser", stepsCompleted: 0, durationMs: Date.now() - startTime };
  }

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

    // Block heavy resources + ad/tracker/popup requests (skips most ads).
    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      const type = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        req.abort();
        return;
      }
      if (isAdUrl(req.url())) {
        req.abort();
        return;
      }
      req.continue();
    });

    const knownPages = new Set<any>([page]);

    logger.info("Navigating to URL", { url });
    progress(0, "Opening link…");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS });
    await sleep(2500);

    let stepsCompleted = 0;

    for (let step = 0; step < MAX_STEPS && Date.now() < deadline; step++) {
      const currentUrl = page.url();
      progress(step, `Step ${step + 1}: ${hostOf(currentUrl)}`);

      const stepInfo = await getStepInfo(page);
      if (stepInfo) {
        logger.info("Step detected", { current: stepInfo.current, total: stepInfo.total, url: currentUrl });
      }

      // "Your link is ready" style pages: grab the link directly.
      const finalLink = await extractFinalLinkFromPage(page);
      if (finalLink) {
        const blockedFinal = await assertSafeToLoad(finalLink);
        if (!blockedFinal) {
          logger.info("Found final link on page", { url: finalLink });
          await page.goto(finalLink, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS });
          await sleep(2000);
          stepsCompleted++;
          break;
        }
      }

      // Wait out the timer (or until an action button is clickable).
      const remaining = deadline - Date.now();
      await waitForTimerOrReady(page, Math.min(STEP_TIMER_WAIT_MS, Math.max(5000, remaining)));

      if (page.url() !== currentUrl) {
        logger.info("Page auto-advanced after timer", { url: page.url() });
        stepsCompleted++;
        await sleep(2000);
        continue;
      }

      // Click Get Link / Continue / Proceed / Unlock …
      const clickResult = await clickActionButton(page);

      if (clickResult && typeof clickResult === "object" && "href" in clickResult) {
        const href = (clickResult as { href: string }).href;
        const blockedHref = await assertSafeToLoad(href);
        if (blockedHref) {
          logger.warn("Skipping SSRF-blocked href", { href });
        } else {
          logger.info("Navigating to button href", { href });
          await page.goto(href, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS });
          await sleep(2000);
          stepsCompleted++;
          continue;
        }
      }

      if (clickResult === "clicked") {
        const triage = await triageTabs(browser, page, knownPages);
        page = triage.page;
        for (const p of await browser.pages()) knownPages.add(p);

        if (page.url() !== currentUrl || triage.switched) {
          logger.info("Moved to next page", { url: page.url() });
          stepsCompleted++;
          await sleep(2000);
          continue;
        }

        logger.info("Click did not navigate; retrying once after reload");
        await page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS }).catch(() => {});
        await sleep(2500);
        if (page.url() !== currentUrl) {
          stepsCompleted++;
          continue;
        }
      }

      // No button found and no step info: nothing left to do.
      if (!stepInfo && !clickResult) {
        const retryLink = await extractFinalLinkFromPage(page);
        if (retryLink && (await assertSafeToLoad(retryLink)) === null) {
          await page.goto(retryLink, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS });
          await sleep(2000);
          stepsCompleted++;
        } else {
          logger.info("No step indicator and no action button; reached end", { url: page.url() });
        }
        break;
      }

      if (Date.now() >= deadline) break;
      stepsCompleted++;
      await sleep(1500);
    }

    const finalUrl = page.url();

    if (finalUrl === url) {
      return {
        success: false,
        error: "Could not bypass the link shortener",
        method: "Browser",
        stepsCompleted,
        durationMs: Date.now() - startTime,
      };
    }

    const blockedFinal = await assertSafeToLoad(finalUrl);
    if (blockedFinal) {
      return {
        success: false,
        error: blockedFinal,
        method: "Browser",
        stepsCompleted,
        durationMs: Date.now() - startTime,
      };
    }

    logger.info("Bypass completed", { finalUrl, steps: stepsCompleted });
    progress(stepsCompleted, "Done!");

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
