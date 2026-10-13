import { getBrowser } from "./browser.js";
import { logger } from "../utils/logger.js";
import { isAdUrl } from "./adblock.js";
import { ACTION_TEXT_PATTERNS, ACTION_SELECTOR_HINTS } from "./page-actions.js";
import { resolveAndValidate } from "../security/ssrf-protection.js";
import fs from "node:fs/promises";

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
/** "Click ad, wait N seconds, come back" pages: how long to keep the ad tab open. */
const COME_BACK_WAIT_MS = 12_000;

/**
 * Debug mode: when DUMP_STEPS=1, save each step page's rendered HTML to
 * ./step-dumps/ so the page's real JS (timers, Get Link mechanism) can be
 * inspected offline. Used to reverse-engineer fast (timer-skipping) paths.
 */
const DUMP_STEPS = ["1", "true", "yes"].includes((process.env.DUMP_STEPS || "").toLowerCase());

async function dumpStepHtml(page: any, label: string): Promise<void> {
  if (!DUMP_STEPS || !page) return;
  try {
    const dir = "step-dumps";
    await fs.mkdir(dir, { recursive: true });
    const host = hostOf(page.url()).replace(/[^a-z0-9.-]/gi, "_") || "page";
    const file = `${dir}/${label}-${host}-${Date.now()}.html`;
    const html = await page.content();
    await fs.writeFile(file, html, "utf8");
    logger.info("Step HTML dumped", { file, bytes: html.length });
  } catch (err) {
    logger.warn("Step HTML dump failed", { error: (err as Error).message });
  }
}

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

/**
 * These shorteners chain JS redirects (vplink → landing → article), which
 * can fire after domcontentloaded and race our page.evaluate calls
 * ("Execution context was destroyed"). Wait until the URL stops changing
 * before touching the page.
 */
async function waitForUrlStable(page: any, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  let lastUrl = "";
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    let cur = "";
    try {
      cur = page.url();
    } catch {
      break;
    }
    if (cur === lastUrl) {
      if (Date.now() - stableSince >= 2000) return;
    } else {
      lastUrl = cur;
      stableSince = Date.now();
    }
    await sleep(500);
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

/** "Click the ad, wait N seconds, come back" style pages need the ad tab
 *  kept open briefly instead of being closed immediately. */
async function isComeBackPage(page: any): Promise<boolean> {
  return page.evaluate(() => {
    const body = (document.body?.innerText || "").toLowerCase();
    return /come back/.test(body) || /wait \d+\s*second/.test(body);
  });
}

/**
 * FAST PATH for "click ad, wait, come back" pages (tp-snp2 / getlink
 * templates): the Continue button is revealed by a purely client-side
 * timer, with no server check and no ad click required. Mimic the reveal
 * instantly and return the button's href — zero waiting.
 *
 * IMPORTANT: the function passed to page.evaluate must not contain any
 * named or variable-assigned function expressions (tsx/esbuild keepNames
 * wraps those in __name(...) which doesn't exist in page context).
 * Only inline anonymous callbacks are safe in here.
 */
async function tryInstantReveal(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const snp2 = document.getElementById("tp-snp2") as HTMLElement | null;
    const btn6 = document.getElementById("btn6") as HTMLElement | null;
    const getlink = document.getElementById("getlink") as HTMLElement | null;
    const target = snp2 || btn6 || getlink;
    if (!target) return null;

    // Do exactly what the page's own timer/ad-click reveal does.
    const tpWait = document.getElementById("tp-wait1") as HTMLElement | null;
    if (tpWait) tpWait.style.display = "none";
    const ggd = document.getElementById("ggd-container") as HTMLElement | null;
    if (ggd) ggd.style.display = "none";
    const tpg = document.getElementById("tp-generate") as HTMLElement | null;
    if (tpg) tpg.style.display = "block";
    const s2 = document.getElementById("tp-snp2") as HTMLElement | null;
    if (s2) s2.style.display = "block";
    const gl = document.getElementById("getlink") as HTMLElement | null;
    if (gl) gl.style.display = "block";
    const b6 = document.getElementById("btn6") as HTMLElement | null;
    if (b6) b6.style.display = "block";
    const gcont = document.getElementById("gcont") as HTMLElement | null;
    if (gcont) gcont.style.position = "static";

    // The button is usually wrapped in an anchor holding the next URL.
    let href: string | null = null;
    const anchor = target.closest("a");
    if (anchor) href = (anchor as HTMLAnchorElement).href;
    if (!href) {
      href =
        target.getAttribute("data-href") ||
        target.getAttribute("data-url") ||
        target.getAttribute("href");
    }
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    try {
      const u = new URL(href, document.baseURI);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) {
      // ignore unresolvable href
    }
    return null;
  });
}

/**
 * Find the main action button (Get Link / Continue / Proceed / Unlock /
 * Download …) and click it. If it is a plain anchor with an http href,
 * return the href so the caller can navigate directly — unless clickOnly
 * is set (used on "click the ad and come back" pages, where navigating the
 * main page away would lose the flow state).
 *
 * IMPORTANT: the function passed to page.evaluate must not contain any
 * named or variable-assigned function expressions. tsx compiles with
 * esbuild keepNames, which wraps those in __name(...) calls that do not
 * exist in the page context → "ReferenceError: __name is not defined".
 * Only inline anonymous callbacks are safe in here.
 */
async function clickActionButton(page: any, clickOnly = false): Promise<ClickOutcome> {
  return page.evaluate(
    (patterns: string[], selectorHints: string[], clickOnly: boolean) => {
      const res = patterns.map((p) => new RegExp(p, "i"));

      // 1. Known id / class hints
      for (const hint of selectorHints) {
        for (const sel of [`#${hint}`, `.${hint}`, `[id*="${hint}"]`, `[class*="${hint}"]`]) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
          if ((el as HTMLButtonElement).disabled) continue;
          if (el.tagName === "A" && !clickOnly) {
            const href = (el as HTMLAnchorElement).href;
            if (href && /^https?:\/\//i.test(href)) return { href };
          }
          el.click();
          return "clicked";
        }
      }

      // 2. Buttons / links whose visible text matches an action pattern
      const candidates = Array.from(
        document.querySelectorAll("a, button, input[type=submit], input[type=button], [role=button]")
      ) as HTMLElement[];
      for (const el of candidates) {
        const rawText = el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "";
        const text = (rawText || "").trim().replace(/\s+/g, " ");
        if (!text || !res.some((r) => r.test(text))) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        if ((el as HTMLButtonElement).disabled) continue;
        if (el.tagName === "A" && !clickOnly) {
          const href = (el as HTMLAnchorElement).href;
          if (href && /^https?:\/\//i.test(href)) return { href };
        }
        el.click();
        return "clicked";
      }

      // 3. data-href / data-url style buttons
      const dataEls = Array.from(
        document.querySelectorAll("[data-href], [data-url], [data-link]")
      ) as HTMLElement[];
      for (const el of dataEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const href = el.getAttribute("data-href") || el.getAttribute("data-url") || el.getAttribute("data-link");
        if (href && /^https?:\/\//i.test(href)) {
          if (clickOnly) {
            el.click();
            return "clicked";
          }
          return { href };
        }
      }

      // 4. Image banners (e.g. "click the banner/AD" steps): anchors wrapping
      // an image with no text. Last resort — these usually open ad pages.
      // Only on "click the ad" pages (clickOnly): on ordinary pages this
      // would click random thumbnails (e.g. blog post images).
      if (!clickOnly) return null;
      const imgAnchors = Array.from(document.querySelectorAll("a")) as HTMLAnchorElement[];
      for (const el of imgAnchors) {
        if ((el.innerText || "").trim()) continue; // has text → handled above
        if (!el.querySelector("img")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        // Skip site chrome (logo in header/nav/footer) and self-links:
        // those are never the ad banner.
        if (el.closest("header, nav, footer, #masthead, .site-header, .site-footer")) continue;
        let abs = "";
        try { abs = new URL(el.getAttribute("href") || "", location.href).href; } catch (_) { /* ignore */ }
        const pageNoHash = location.href.split("#")[0];
        if (abs === pageNoHash || abs === pageNoHash + "/") continue;
        if (clickOnly || !/^https?:\/\//i.test(el.href)) {
          el.click();
          return "clicked";
        }
        return { href: el.href };
      }

      return null;
    },
    ACTION_TEXT_PATTERNS,
    ACTION_SELECTOR_HINTS,
    clickOnly
  );
}

async function extractFinalLinkFromPage(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const body = document.body?.innerText || "";

    if (/your\s+links?\s+(is|are)\s+(almost\s+)?ready|final\s+link|download\s+link/i.test(body)) {
      // vplink final pages render a disabled Get Link placeholder until
      // their own timer finishes — prefer the enabled button.
      const readyBtn = document.querySelector(
        "a#get-link:not(.disabled), a.get-link:not(.disabled)"
      ) as HTMLAnchorElement | null;
      if (readyBtn && /^https?:\/\//i.test(readyBtn.href)) return readyBtn.href;

      const links = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      for (const a of links) {
        const href = a.href;
        const text = (a.textContent || "").trim();
        if (a.classList.contains("disabled")) continue;
        if (/get\s*link|download|continue|final|visit/i.test(text) && /^https?:\/\//i.test(href)) {
          return href;
        }
      }
      // Fallback: any external link — but not on "almost ready" pages whose
      // button hasn't activated yet (that would grab ads/channel promos).
      if (!/almost\s+ready/i.test(body)) {
        for (const a of links) {
          if (/^https?:\/\//i.test(a.href)) return a.href;
        }
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
 * Does this new tab look like a genuine continuation (next step / final
 * page) rather than a random ad/article tab? __name-safe: only inline
 * anonymous callbacks inside page.evaluate (see clickActionButton note).
 */
async function isContinuationTab(page: any): Promise<boolean> {
  let url = "";
  try {
    url = page.url();
  } catch {
    return false;
  }
  // Messenger deep links are the payload itself — always keep them.
  const host = hostOf(url).toLowerCase();
  if (host === "t.me" || host === "telegram.me") return true;

  await sleep(1500);
  try {
    return await page.evaluate((patterns: string[]) => {
      const body = document.body?.innerText || "";
      if (/step\s*\d+\s*\/\s*\d+/i.test(body)) return true;
      if (/you\s+are\s+on\s+step/i.test(body)) return true;
      if (/come back/i.test(body)) return true;
      if (/(your|the)\s+links?\s+(is|are)\s+ready|final\s+link/i.test(body)) return true;
      const res = patterns.map((p) => new RegExp(p, "i"));
      const btns = Array.from(document.querySelectorAll("a, button, input[type=submit], input[type=button]"));
      for (const b of btns) {
        const el = b as HTMLElement;
        const raw = el.innerText || (el as HTMLInputElement).value || "";
        const text = (raw || "").trim().replace(/\s+/g, " ");
        if (!text || !res.some((r) => r.test(text))) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return true;
      }
      return false;
    }, ACTION_TEXT_PATTERNS);
  } catch {
    return false;
  }
}

/**
 * After clicking an action button, shortener pages often open popup ads
 * in new tabs while the real next step opens in another tab (or the
 * same tab navigates). Close ad/blank/popup tabs and switch to the
 * legitimate new tab when there is one.
 *
 * A new tab is only treated as the next step if it looks like a genuine
 * continuation (step markers, action buttons, "link ready" text, or a
 * t.me deep link). Otherwise it is closed and we stay on the main page —
 * closing the real step page by mistake used to lose the final link.
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

    if (!switched && (await isContinuationTab(p))) {
      switched = p;
    } else {
      logger.info("Closing non-continuation tab", { url });
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
    await waitForUrlStable(page);
    await sleep(1500);

    let stepsCompleted = 0;

    for (let step = 0; step < MAX_STEPS && Date.now() < deadline; step++) {
      const currentUrl = page.url();
      progress(step, `Step ${step + 1}: ${hostOf(currentUrl)}`);

      // Debug: capture every page the loop visits.
      await dumpStepHtml(page, `loop-${step}`);

      const stepInfo = await getStepInfo(page);
      if (stepInfo) {
        logger.info("Step detected", { current: stepInfo.current, total: stepInfo.total, url: currentUrl });
        await dumpStepHtml(page, `step${stepInfo.current}-of-${stepInfo.total}`);
      }

      // "Your link is almost ready" pages (vplink final): the Get Link
      // button activates after a short on-page timer — wait for it instead
      // of wandering off to random links.
      const almostReady = await page.evaluate(() =>
        /your\s+links?\s+(is|are)\s+(almost\s+)?ready/i.test(document.body?.innerText || "")
      );
      if (almostReady) {
        logger.info("Almost-ready page: waiting for Get Link button to activate");
        progress(step, `Step ${step + 1}: waiting for final link…`);
        const waitStart = Date.now();
        while (Date.now() - waitStart < 30000) {
          const active = await page.evaluate(() => {
            const b = document.querySelector("a#get-link:not(.disabled)") as HTMLAnchorElement | null;
            return !!b && /^https?:\/\//i.test(b.href);
          });
          if (active) break;
          if (page.url() !== currentUrl) break;
          await sleep(1000);
        }
      }

      // "Your link is ready" style pages: grab the link directly.
      const finalLink = await extractFinalLinkFromPage(page);
      if (finalLink) {
        const blockedFinal = await assertSafeToLoad(finalLink);
        if (!blockedFinal) {
          logger.info("Found final link on page", { url: finalLink });
          await page.goto(finalLink, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS });
          await waitForUrlStable(page);
          await sleep(1500);
          stepsCompleted++;
          break;
        }
      }

      // Click Get Link / Continue / Proceed / Unlock …
      // (before waiting: disabled buttons are skipped, so an early click
      // attempt is harmless and finds already-enabled buttons fast.)
      // On "click the ad, wait, come back" pages, click instead of
      // navigating the main page away (that would lose the flow state).
      const comeBack = await isComeBackPage(page);

      // FAST PATH: instant timer reveal (no waiting, no ad click).
      if (comeBack) {
        const fastHref = await tryInstantReveal(page);
        if (fastHref) {
          const blockedFast = await assertSafeToLoad(fastHref);
          if (!blockedFast) {
            logger.info("Fast path: instant timer reveal", { href: fastHref });
            progress(step, `Step ${step + 1}: instant reveal…`);
            await page.goto(fastHref, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS });
            await waitForUrlStable(page);
            await sleep(1500);
            stepsCompleted++;
            continue;
          }
          logger.warn("Skipping SSRF-blocked fast href", { href: fastHref });
        }
      }

      // Smart path for "click the ad, wait N seconds, come back" pages: the
      // timer is purely client-side, so first just wait it out on this page
      // WITHOUT opening any ad tab. If the action button enables on its own,
      // we skip the whole banner-click dance (faster + no stray-tab risk).
      // Falls back to the banner-click flow when the button isn't ready.
      let clickResult: ClickOutcome = null;
      let bannerAlreadyClicked = false;
      if (comeBack) {
        logger.info("Come-back page: waiting out timer on-page first (no ad click)");
        progress(step, `Step ${step + 1}: waiting for timer…`);
        await sleep(COME_BACK_WAIT_MS);
        await dumpStepHtml(page, `after-wait-${step}`);

        const tabsBefore = await browser.pages();
        const smartClick = await clickActionButton(page, true);
        const freshTabs = (await browser.pages()).filter((p: any) => !tabsBefore.includes(p));

        if (smartClick === "clicked" && freshTabs.length === 0) {
          // The real action button was clicked and no ad tab opened: check
          // for navigation directly — no ad wait, no triage needed.
          await sleep(2500);
          if (page.url() !== currentUrl) {
            logger.info("Smart wait worked: action navigated without ad click", { url: page.url() });
            stepsCompleted++;
            await sleep(1500);
            continue;
          }
          logger.info("Smart-wait click did not navigate; re-scanning page");
          await sleep(1500);
          continue;
        }
        if (smartClick === "clicked") {
          // The click landed on the banner/ad (new tab opened): don't click
          // again — run the standard come-back handling below directly.
          logger.info("Smart wait: action not ready, banner opened ad tab — standard come-back flow");
          clickResult = "clicked";
          bannerAlreadyClicked = true;
        } else {
          logger.info("Smart wait: no action yet, trying banner-click flow");
        }
      }
      if (!bannerAlreadyClicked) {
        clickResult = await clickActionButton(page, comeBack);
      }

      if (clickResult && typeof clickResult === "object" && "href" in clickResult) {
        const href = (clickResult as { href: string }).href;
        const blockedHref = await assertSafeToLoad(href);
        if (!blockedHref) {
          logger.info("Navigating to button href", { href });
          await page.goto(href, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT_MS });
          await waitForUrlStable(page);
          await sleep(1500);
          stepsCompleted++;
          continue;
        }
        logger.warn("Skipping SSRF-blocked href", { href });
      }

      if (clickResult === "clicked") {
        if (comeBack) {
          // "Click ad, wait N seconds, come back" flow: keep the ad tab
          // open long enough for the visit to register, then close the
          // extras and re-scan this page (the Get Link button enables
          // after coming back).
          logger.info("Come-back flow: waiting on ad tab before returning");
          progress(step, `Step ${step + 1}: waiting on ad page…`);
          await sleep(COME_BACK_WAIT_MS);
        }

        const triage = await triageTabs(browser, page, knownPages);
        page = triage.page;
        for (const p of await browser.pages()) knownPages.add(p);

        // Dump the DOM right after coming back from the ad tab: this is the
        // state where the Get Link button becomes enabled.
        if (comeBack) {
          await dumpStepHtml(page, `after-comeback-${step}`);
        }

        if (page.url() !== currentUrl || triage.switched) {
          logger.info("Moved to next page", { url: page.url() });
          stepsCompleted++;
          await sleep(2000);
          continue;
        }

        // Click didn't navigate: don't reload (that would wipe come-back
        // state) — loop around and re-scan for newly enabled buttons.
        logger.info("Click did not navigate; re-scanning page");
        await sleep(2000);
        continue;
      }

      // No button found and no step info: nothing left to do — this page
      // is the destination (e.g. a t.me deep-link page).
      if (!stepInfo) {
        logger.info("No step indicator and no action button; reached end", { url: page.url() });
        break;
      }

      // Step indicator present but no enabled button yet: wait out the
      // timer (or until a button becomes clickable / the page advances).
      const remaining = deadline - Date.now();
      await waitForTimerOrReady(page, Math.min(STEP_TIMER_WAIT_MS, Math.max(5000, remaining)));

      if (page.url() !== currentUrl) {
        logger.info("Page auto-advanced after timer", { url: page.url() });
        stepsCompleted++;
        await sleep(2000);
        continue;
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
