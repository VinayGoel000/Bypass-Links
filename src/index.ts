import { createBot } from "./bot/bot.js";
import { closeBrowser } from "./bypass/browser.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  logger.info("Starting Telegram URL Resolver Bot...");

  const bot = createBot();

  await bot.launch();
  logger.info("Bot is running (long polling mode)");

  const shutdown = async () => {
    logger.info("Shutting down...");
    bot.stop();
    await closeBrowser();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
