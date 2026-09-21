import { logger } from "../utils/logger.js";

const BLOCKED_DOMAINS = [
  "google.com", "facebook.com", "twitter.com", "instagram.com",
  "youtube.com", "doubleclick.net", "googlesyndication.com",
  "googleadservices.com", "amazon.com", "flipkart.com",
  "arolinks.com", "gplinks.in", "cuty.io",
];

function filterUrl(url: string, currentDomain: string): boolean {
  try {
    const parsed = new URL(url);
    if (BLOCKED_DOMAINS.some((d) => parsed.hostname.includes(d))) return false;
    if (parsed.hostname.includes(currentDomain)) return false;
    return true;
  } catch {
    return false;
  }
}

function extractUrlsFromScriptTags(html: string): string[] {
  const urls: string[] = [];

  // var/let/const x = "http..."
  const varPattern = /(?:var|let|const)\s+\w+\s*=\s*["'](https?:\/\/[^"']+)["']/g;
  let m;
  while ((m = varPattern.exec(html)) !== null) urls.push(m[1]);

  // window.location = "http..."
  const locPattern = /window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/g;
  while ((m = locPattern.exec(html)) !== null) urls.push(m[1]);

  // location.href = "http..."
  const locHrefPattern = /location\.href\s*=\s*["'](https?:\/\/[^"']+)["']/g;
  while ((m = locHrefPattern.exec(html)) !== null) urls.push(m[1]);

  // setTimeout(function(){ window.location = "http..." }, ...)
  const timeoutPattern = /setTimeout\s*\(\s*function[^}]*window\.location[^}]*["'](https?:\/\/[^"']+)["']/g;
  while ((m = timeoutPattern.exec(html)) !== null) urls.push(m[1]);

  // atob("base64") - decoded URLs
  const atobPattern = /atob\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g;
  while ((m = atobPattern.exec(html)) !== null) {
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf-8");
      if (decoded.startsWith("http")) urls.push(decoded);
    } catch {}
  }

  return urls;
}

function extractUrlsFromHtml(html: string): string[] {
  const urls: string[] = [];

  // data-href, data-url, data-link, data-redirect
  const dataPattern = /data-(?:href|url|link|redirect)\s*=\s*["'](https?:\/\/[^"']+)["']/g;
  let m;
  while ((m = dataPattern.exec(html)) !== null) urls.push(m[1]);

  // value="http..." in hidden inputs
  const valuePattern = /value\s*=\s*["'](https?:\/\/[^"']+)["']/g;
  while ((m = valuePattern.exec(html)) !== null) urls.push(m[1]);

  // onclick="...http..."
  const onclickPattern = /onclick\s*=\s*["'][^"']*(https?:\/\/[^"']+)["']/g;
  while ((m = onclickPattern.exec(html)) !== null) urls.push(m[1]);

  // Meta refresh
  const metaPattern = /meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url=(https?:\/\/[^"']+)["']/gi;
  while ((m = metaPattern.exec(html)) !== null) urls.push(m[1]);

  // href="http..." on anchor tags
  const hrefPattern = /<a\s[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  while ((m = hrefPattern.exec(html)) !== null) urls.push(m[1]);

  // Form action
  const formPattern = /<form[^>]*action\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  while ((m = formPattern.exec(html)) !== null) urls.push(m[1]);

  return urls;
}

function extractUrlsFromPageSource(html: string): string[] {
  const urls: string[] = [];

  // Generic URL pattern in entire HTML
  const genericPattern = /https?:\/\/[^\s"'<>]+/g;
  let m;
  while ((m = genericPattern.exec(html)) !== null) {
    let url = m[0];
    // Clean trailing punctuation
    url = url.replace(/[);,.\]}>]+$/, "");
    urls.push(url);
  }

  return [...new Set(urls)];
}

export interface InspectionResult {
  found: boolean;
  finalUrl?: string;
  method: string;
  allUrls: string[];
}

export async function inspectHtml(url: string): Promise<InspectionResult> {
  logger.info("HTML inspection started", { url });

  let html: string;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    html = await response.text();
  } catch (err) {
    logger.error("HTML fetch failed", { error: (err as Error).message });
    return { found: false, method: "fetch_failed", allUrls: [] };
  }

  let currentDomain = "";
  try {
    currentDomain = new URL(url).hostname;
  } catch {}

  // Collect all URLs from different sources
  const scriptUrls = extractUrlsFromScriptTags(html);
  const htmlUrls = extractUrlsFromHtml(html);
  const pageUrls = extractUrlsFromPageSource(html);

  const allUrls = [...new Set([...scriptUrls, ...htmlUrls, ...pageUrls])];

  logger.info("URLs extracted from HTML", {
    scriptUrls: scriptUrls.length,
    htmlUrls: htmlUrls.length,
    pageUrls: pageUrls.length,
    total: allUrls.length,
  });

  // Priority 1: URLs from script tags (most likely the redirect target)
  const filteredScriptUrls = scriptUrls.filter((u) => filterUrl(u, currentDomain));
  if (filteredScriptUrls.length > 0) {
    logger.info("Found URL in script tags", { url: filteredScriptUrls[0] });
    return { found: true, finalUrl: filteredScriptUrls[0], method: "script_tag", allUrls };
  }

  // Priority 2: data-href, hidden input, onclick URLs
  const filteredHtmlUrls = htmlUrls.filter((u) => filterUrl(u, currentDomain));
  if (filteredHtmlUrls.length > 0) {
    logger.info("Found URL in HTML attributes", { url: filteredHtmlUrls[0] });
    return { found: true, finalUrl: filteredHtmlUrls[0], method: "html_attribute", allUrls };
  }

  // Priority 3: Meta refresh
  const metaRefreshMatch = html.match(/meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url=(https?:\/\/[^"']+)["']/i);
  if (metaRefreshMatch) {
    logger.info("Found meta refresh URL", { url: metaRefreshMatch[1] });
    return { found: true, finalUrl: metaRefreshMatch[1], method: "meta_refresh", allUrls };
  }

  // Priority 4: Any external link from page
  const filteredPageUrls = pageUrls.filter((u) => filterUrl(u, currentDomain));
  if (filteredPageUrls.length > 0) {
    logger.info("Found external URL in page", { url: filteredPageUrls[0] });
    return { found: true, finalUrl: filteredPageUrls[0], method: "page_source", allUrls };
  }

  logger.info("No external URL found in HTML");
  return { found: false, method: "not_found", allUrls };
}
