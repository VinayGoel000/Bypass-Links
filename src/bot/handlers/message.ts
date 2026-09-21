import { Context } from "telegraf";
import { validateUrl, extractUrl } from "../../security/url-validator.js";
import { resolveUrl } from "../../resolver/url-resolver.js";
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
      try {
        if (thinking.chat && thinking.message_id) {
          await ctx.telegram.deleteMessage(thinking.chat.id, thinking.message_id);
        }
      } catch {}
      return;
    }

    // Try hybrid bypass (HTML inspection + browser)
    await ctx.reply("Step-based link detected. Trying bypass...");

    const bypassResult = await bypassUrl(extracted);

    if (bypassResult.success && bypassResult.finalUrl) {
      cache.set(urlKey, {
        finalUrl: bypassResult.finalUrl,
        method: bypassResult.method,
        stepsCompleted: bypassResult.stepsCompleted,
      });

      const response = formatResponse(bypassResult.finalUrl, bypassResult.method, bypassResult.stepsCompleted);
      await ctx.reply(response);

      try {
        if (thinking.chat && thinking.message_id) {
          await ctx.telegram.deleteMessage(thinking.chat.id, thinking.message_id);
        }
      } catch {}
    } else {
      await ctx.reply(`Bypass failed: ${bypassResult.error || "Could not resolve link"}\n\nThe link may require manual interaction.`);
    }
  } catch (err) {
    logger.error("Unhandled error", { error: String(err) });
    await ctx.reply("An unexpected error occurred. Please try again later.");
  }
}
