import { Context } from "telegraf";
import { validateUrl, extractUrl } from "../../security/url-validator.js";
import { resolveUrl } from "../../resolver/url-resolver.js";
import { followHtmlHops } from "../../bypass/html-hops.js";
import { bypassUrl } from "../../bypass/engine.js";
import { checkReputation } from "../../security/reputation-service.js";
import { MemoryCache } from "../../utils/cache.js";
import { getEnvConfig } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

interface CachedResult {
  finalUrl: string;
  method: string;
  stepsCompleted: number;
}

const cache = new MemoryCache<CachedResult>(getEnvConfig().CACHE_TTL_SECONDS);

function formatResponse(finalUrl: string, method: string, stepsCompleted: number): string {
  let msg = `Final Link:\n${finalUrl}\n\n`;
  msg += `Method: ${method}\n`;
  if (stepsCompleted > 0) {
    msg += `Steps bypassed: ${stepsCompleted}\n`;
  }
  return msg;
}

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "Send me any link shortener URL and I will bypass it.\n\n" +
      "Supported:\n" +
      "- HTTP redirect chains\n" +
      "- Step-based shorteners (arolinks, gplinks, etc.)\n" +
      "- Ad-wall bypass with timer skip\n\n" +
      "Example: https://arolinks.com/xyz"
  );
}

export async function handleUrlMessage(ctx: Context): Promise<void> {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : null;
  if (!text) return;

  const extracted = extractUrl(text);
  if (!extracted) {
    await ctx.reply("Please send a valid URL (http:// or https://).");
    return;
  }

  const validation = validateUrl(extracted);
  if (!validation.valid) {
    await ctx.reply(`Invalid URL: ${validation.error}`);
    return;
  }

  const urlKey = extracted.toLowerCase();
  const cached = cache.get(urlKey);
  if (cached) {
    await ctx.reply(formatResponse(cached.finalUrl, `${cached.method} (cached)`, cached.stepsCompleted));
    return;
  }

  const thinking = await ctx.reply("Checking URL...");

  const deleteThinking = async () => {
    try {
      if (thinking.chat && thinking.message_id) {
        await ctx.telegram.deleteMessage(thinking.chat.id, thinking.message_id);
      }
    } catch {}
  };

  // Progress is streamed by editing the "thinking" message (throttled
  // to stay under Telegram's edit rate limits).
  let lastEditAt = 0;
  let lastProgressText = "";
  const reportProgress = async (text: string) => {
    const now = Date.now();
    if (text === lastProgressText || now - lastEditAt < 3000) return;
    lastProgressText = text;
    lastEditAt = now;
    try {
      await ctx.telegram.editMessageText(thinking.chat.id, thinking.message_id, undefined, text);
    } catch {
      // Message may be unchanged or too old; not fatal.
    }
  };

  try {
    // First try HTTP redirect chain (fastest)
    const httpResult = await resolveUrl(extracted);
    if (httpResult.success && httpResult.chain.count > 0) {
      cache.set(urlKey, {
        finalUrl: httpResult.finalUrl!,
        method: "HTTP Redirect",
        stepsCompleted: httpResult.chain.count,
      });

      await ctx.reply(formatResponse(httpResult.finalUrl!, "HTTP Redirect", httpResult.chain.count));
      await deleteThinking();
      return;
    }

    // Then try HTML inspection (fast, no browser needed). Shorteners often
    // chain 2-3 interstitial pages, so follow embedded hops instead of
    // stopping at the first intermediate URL.
    const hopTrace = await followHtmlHops(extracted, (n) => {
      void reportProgress(`Bypassing… following step ${n + 1}…`);
    });
    const hopped = hopTrace.url !== extracted;
    const htmlMethod = hopped ? `HTML Inspection (${hopTrace.methods.join(" → ")})` : "";
    // When hops were followed, the browser finishes the chain from the
    // deepest hop (timer / continue-button pages need a real browser).
    const browserStart = hopped ? hopTrace.url : extracted;

    // Finally try browser bypass (handles timers / multi-step pages).
    const bypassResult = await bypassUrl(browserStart, (p) => {
      void reportProgress(`Bypassing… ${p.message}`);
    });

    if (bypassResult.success && bypassResult.finalUrl) {
      const method = hopped ? `${htmlMethod} → Browser Bypass` : bypassResult.method;
      const stepsCompleted = bypassResult.stepsCompleted + (hopped ? hopTrace.methods.length : 0);
      cache.set(urlKey, { finalUrl: bypassResult.finalUrl, method, stepsCompleted });

      await ctx.reply(formatResponse(bypassResult.finalUrl, method, stepsCompleted));
      await deleteThinking();
      return;
    }

    if (hopped) {
      // Browser couldn't advance past the deepest hop; it's our best answer.
      const stepsCompleted = hopTrace.methods.length;
      cache.set(urlKey, { finalUrl: hopTrace.url, method: htmlMethod, stepsCompleted });
      await ctx.reply(formatResponse(hopTrace.url, htmlMethod, stepsCompleted));
      await deleteThinking();
      return;
    }

    await ctx.reply(
      `Bypass failed: ${bypassResult.error || "Could not resolve link"}\n\nThe link may require manual interaction.`
    );
  } catch (err) {
    logger.error("Unhandled error", { error: String(err) });
    await ctx.reply("An unexpected error occurred. Please try again later.");
  }
}
