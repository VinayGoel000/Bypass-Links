import { Telegraf } from "telegraf";
import { getEnvConfig } from "../config/env.js";
import { handleStart, handleUrlMessage } from "./handlers/message.js";
import { logger } from "../utils/logger.js";

export function createBot(): Telegraf {
  const bot = new Telegraf(getEnvConfig().BOT_TOKEN);

  bot.command("start", handleStart);

  bot.on("text", handleUrlMessage);

  bot.catch((err, ctx) => {
    logger.error("Bot error", {
      error: String(err),
      updateType: ctx.updateType,
    });
  });

  return bot;
}
