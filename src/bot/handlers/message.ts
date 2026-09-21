import { Context } from "telegraf";
import { validateUrl, extractUrl } from "../../security/url-validator.js";
import { resolveUrl } from "../../resolver/url-resolver.js";
import { bypassUrl } from "../../bypass/engine.js";
import { checkReputation, SecurityStatus } from "../../security/reputation-service.js";
import { MemoryCache } from "../../utils/cache.js";
import { getEnvConfig } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

interface CachedResult {
  finalUrl: string;
  method: string;
  stepsCompleted: number;
}

const cache = new MemoryCache<CachedResult>(getEnvConfig().CACHE_TTL_SECONDS);

function formatResponse(
  finalUrl: string,
  method: string,
  stepsCompleted: number
): string {
  let msg = `🔗 Final Link:\n${finalUrl}\n\n`;
  msg += `Method: ${method}\n`;
  if (stepsCompleted > 0) {
    msg += `Steps bypassed: ${stepsCompleted}\n`;
  }
  return msg;
}

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "Send me any link shortener URL and I will bypass it to get the final link.\n\n" +
      "Supported:\n" +
      "- HTTP redirect chains (301/302/303/307/308)\n" +
      "- Step-based shorteners (arolinks, gplinks, etc.)\n" +
      "- Ad-wall bypass with timer wait\n\n" +
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
    const httpResult = await resolveUrl(extracted);

    if (httpResult.success && httpResult.chain.count > 0) {
      logger.info("HTTP redirect chain resolved", { url: extracted, redirects: httpResult.chain.count });

      const reputation = await checkReputation(httpResult.finalUrl!);

      cache.set(urlKey, {
        finalUrl: httpResult.finalUrl!,
        method: "HTTP Redirect",
        stepsCompleted: httpResult.chain.count,
      });

      const response = formatResponse(
        httpResult.finalUrl!,
        "HTTP Redirect",
        httpResult.chain.count
      );

      await ctx.reply(response);

      try {
        if (thinking.chat && thinking.message_id) {
          await ctx.telegram.deleteMessage(thinking.chat.id, thinking.message_id);
        }
      } catch {}
      return;
    }

    await ctx.reply("Step-based link detected. Starting bypass engine...");

    const bypassResult = await bypassUrl(extracted);

    if (bypassResult.success && bypassResult.finalUrl) {
      logger.info("Puppeteer bypass completed", {
        url: extracted,
        finalUrl: bypassResult.finalUrl,
        steps: bypassResult.stepsCompleted,
      });

      cache.set(urlKey, {
        finalUrl: bypassResult.finalUrl,
        method: "Puppeteer Bypass",
        stepsCompleted: bypassResult.stepsCompleted,
      });

      const response = formatResponse(
        bypassResult.finalUrl,
        "Puppeteer Bypass",
        bypassResult.stepsCompleted
      );

      await ctx.reply(response);

      try {
        if (thinking.chat && thinking.message_id) {
          await ctx.telegram.deleteMessage(thinking.chat.id, thinking.message_id);
        }
      } catch {}
    } else {
      await ctx.reply(`Bypass failed: ${bypassResult.error || "Could not resolve final link"}\n\nThe link may require manual interaction.`);
    }
  } catch (err) {
    logger.error("Unhandled error", { error: String(err) });
    await ctx.reply("An unexpected error occurred. Please try again later.");
  }
}
