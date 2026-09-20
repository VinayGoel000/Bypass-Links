import { getEnvConfig } from "../config/env.js";
import { RedirectChain } from "./redirect-chain.js";
import { resolveAndValidate } from "../security/ssrf-protection.js";
import { logger } from "../utils/logger.js";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export interface ResolveResult {
  success: boolean;
  finalUrl?: string;
  chain: RedirectChain;
  error?: string;
  durationMs: number;
}

async function safeFetch(
  url: string,
  method: "HEAD" | "GET",
  signal: AbortSignal
): Promise<Response> {
  const response = await fetch(url, {
    method,
    signal,
    redirect: "manual",
    headers: {
      "User-Agent": "TelegramBot/1.0 (URL Resolver)",
    },
  });
  return response;
}

async function followRedirects(startUrl: string): Promise<ResolveResult> {
  const startTime = Date.now();
  const chain = new RedirectChain();
  let currentUrl = startUrl;
  let method: "HEAD" | "GET" = "HEAD";

  chain.add(currentUrl, 0);

  for (let hop = 0; hop < getEnvConfig().MAX_REDIRECTS; hop++) {
    let urlObj: URL;
    try {
      urlObj = new URL(currentUrl);
    } catch {
      return {
        success: false,
        chain,
        error: `Invalid URL: ${currentUrl}`,
        durationMs: Date.now() - startTime,
      };
    }

    const ssrfResult = await resolveAndValidate(urlObj.hostname);
    if (!ssrfResult.safe) {
      logger.warn("SSRF blocked", { url: currentUrl, error: ssrfResult.error });
      return {
        success: false,
        chain,
        error: ssrfResult.error,
        durationMs: Date.now() - startTime,
      };
    }

    logger.debug("Fetching", { url: currentUrl, method, hop });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getEnvConfig().REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await safeFetch(currentUrl, method, controller.signal);
    } catch (err: unknown) {
      clearTimeout(timeout);
      const error = err as Error;
      if (error.name === "AbortError") {
        return {
          success: false,
          chain,
          error: `Timeout after ${getEnvConfig().REQUEST_TIMEOUT_MS}ms`,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: false,
        chain,
        error: `Connection failed: ${error.message}`,
        durationMs: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeout);
    }

    const status = response.status;

    if (REDIRECT_STATUS_CODES.has(status)) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          success: false,
          chain,
          error: `Redirect (${status}) but no Location header`,
          durationMs: Date.now() - startTime,
        };
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return {
          success: false,
          chain,
          error: `Malformed redirect location: ${location}`,
          durationMs: Date.now() - startTime,
        };
      }

      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        return {
          success: false,
          chain,
          error: `Redirect to unsupported protocol: ${nextUrl.protocol}`,
          durationMs: Date.now() - startTime,
        };
      }

      currentUrl = nextUrl.href;
      chain.add(currentUrl, status);

      if (chain.hasLoop()) {
        return {
          success: false,
          chain,
          error: "Redirect loop detected",
          durationMs: Date.now() - startTime,
        };
      }

      continue;
    }

    return {
      success: true,
      finalUrl: currentUrl,
      chain,
      durationMs: Date.now() - startTime,
    };
  }

  return {
    success: false,
    chain,
    error: `Too many redirects (max: ${getEnvConfig().MAX_REDIRECTS})`,
    durationMs: Date.now() - startTime,
  };
}

export async function resolveUrl(inputUrl: string): Promise<ResolveResult> {
  const start = Date.now();
  logger.info("Resolving URL", { url: inputUrl });

  const result = await followRedirects(inputUrl);

  logger.info("Resolution complete", {
    url: inputUrl,
    success: result.success,
    redirects: result.chain.count,
    durationMs: result.durationMs,
    error: result.error,
  });

  return result;
}
