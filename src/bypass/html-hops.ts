import { inspectHtml } from "./html-inspector.js";
import { validateUrl } from "../security/url-validator.js";
import { resolveAndValidate } from "../security/ssrf-protection.js";
import { logger } from "../utils/logger.js";

export const MAX_HTML_HOPS = 3;

/**
 * inspectHtml methods that strongly indicate an interstitial hop page.
 * Deliberately conservative: plain anchors / data-href buttons / forms
 * ("html_attribute") and generic outbound links ("page_source") are NOT
 * followed — on a real download/content page those would drag the chain
 * onto random links. The browser stage handles button/form hops instead.
 */
const HOP_METHODS = new Set(["script_tag", "meta_refresh"]);

export interface HopTrace {
  /** Deepest URL reached by following HTML hops. */
  url: string;
  /** inspectHtml method used for each hop taken, in order. */
  methods: string[];
}

/**
 * Follow multi-step shortener chains statically: some shorteners hop across
 * 2-3 interstitial pages whose next URL is embedded in the HTML (script tags,
 * meta refresh, data attributes). Follow those hops (bounded, cycle-safe)
 * instead of returning the first intermediate URL as the final link.
 */
export async function followHtmlHops(
  startUrl: string,
  onHop?: (hopIndex: number, url: string) => void
): Promise<HopTrace> {
  const methods: string[] = [];
  const seen = new Set<string>([startUrl.toLowerCase()]);
  let current = startUrl;

  for (let i = 0; i < MAX_HTML_HOPS; i++) {
    const inspection = await inspectHtml(current);
    if (!inspection.found || !inspection.finalUrl) break;
    // Weak signal (generic outbound link): treat this page as the destination.
    if (!HOP_METHODS.has(inspection.method)) break;

    const next = inspection.finalUrl;
    if (seen.has(next.toLowerCase())) {
      logger.info("HTML hop cycle detected; stopping", { url: next });
      break;
    }

    const validation = validateUrl(next);
    if (!validation.valid || !validation.url) break;

    const ssrf = await resolveAndValidate(validation.url.hostname);
    if (!ssrf.safe) {
      logger.warn("HTML hop hit SSRF-blocked URL", { url: next, error: ssrf.error });
      break;
    }

    seen.add(next.toLowerCase());
    methods.push(inspection.method);
    logger.info("Following HTML hop", { from: current, to: next, method: inspection.method });
    try {
      onHop?.(methods.length, next);
    } catch {}
    current = next;
  }

  return { url: current, methods };
}
