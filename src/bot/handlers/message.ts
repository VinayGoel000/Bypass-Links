import { Context } from "telegraf";
import { validateUrl, extractUrl } from "../../security/url-validator.js";
import { resolveUrl } from "../../resolver/url-resolver.js";
import { checkReputation, SecurityStatus } from "../../security/reputation-service.js";
import { MemoryCache } from "../../utils/cache.js";
import { getEnvConfig } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

interface CachedResult {
  finalUrl: string;
  redirectCount: number;
  status: SecurityStatus;
  chainFormatted: string;
}

const cache = new MemoryCache<CachedResult>(getEnvConfig().CACHE_TTL_SECONDS);

function formatResponse(
  finalUrl: string,
  redirectCount: number,
  status: SecurityStatus,
  chainFormatted: string
): string {
  const statusEmoji =
    status === "SAFE_TO_VISIT"
      ? "SAFE"
      : status === "SUSPICIOUS"
        ? "SUSPICIOUS"
        : "UNKNOWN";

  let msg = `Final destination:\n${finalUrl}\n\n`;
  msg += `Redirects followed: ${redirectCount}\n`;
  msg += `Security: ${statusEmoji}\n\n`;

  if (redirectCount > 0) {
    msg += `Redirect chain:\n${chainFormatted}`;
  }

  return msg;
}

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "Send me a URL and I will follow its redirects and show you the final destination.\n\n" +
      "Supported: http:// and https:// links\n" +
      "Example: https://short.example/abc"
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
    await ctx.reply(
      formatResponse(
        cached.finalUrl,
        cached.redirectCount,
        cached.status,
        cached.chainFormatted
      )
    );
    return;
  }

  const thinking = await ctx.reply("Resolving URL...");

  try {
    const result = await resolveUrl(extracted);

    if (!result.success) {
      await ctx.reply(`Error: ${result.error}`);
      return;
    }

    const reputation = await checkReputation(result.finalUrl!);

    const formatted = formatResponse(
      result.finalUrl!,
      result.chain.count,
      reputation.status,
      result.chain.format()
    );

    cache.set(urlKey, {
      finalUrl: result.finalUrl!,
      redirectCount: result.chain.count,
      status: reputation.status,
      chainFormatted: result.chain.format(),
    });

    await ctx.reply(formatted);

    try {
      if (thinking.chat && thinking.message_id) {
        await ctx.telegram.deleteMessage(thinking.chat.id, thinking.message_id);
      }
    } catch {
      // Ignore delete errors
    }
  } catch (err) {
    logger.error("Unhandled error in URL resolution", { error: String(err) });
    await ctx.reply("An unexpected error occurred. Please try again later.");
  }
}
