# Telegram URL Resolver Bot

A Telegram bot that resolves URL redirect chains server-side and returns the final destination URL with security status.

## Features

- Follows HTTP redirects (301, 302, 303, 307, 308)
- Fast HTML inspection (extracts target from scripts, meta refresh, data attributes)
- Headless-browser bypass for timer / multi-step shorteners:
  - Waits out countdown timers, clicks **Get Link / Continue / Proceed / Unlock** buttons
  - Skips ads: blocks ad/tracker/popup requests and auto-closes popup ad tabs
  - Follows links that open in new tabs
- SSRF protection (blocks private IPs, localhost, internal hostnames) on every server-side fetch and browser navigation
- Redirect loop detection
- Configurable timeouts and redirect limits
- In-memory caching
- Clean, modular architecture

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Telegram Bot

1. Open Telegram, search for `@BotFather`
2. Send `/newbot`
3. Follow prompts to name your bot
4. Copy the bot token

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your bot token:

```
BOT_TOKEN=your_token_here
MAX_REDIRECTS=10
REQUEST_TIMEOUT_MS=8000
CACHE_TTL_SECONDS=300
# Optional: override Chrome executable (auto-detected otherwise)
# CHROME_PATH=/usr/bin/google-chrome
# Max time for one browser bypass run in ms (default 150000)
# BYPASS_TIMEOUT_MS=150000
```

`npm install` downloads a bundled Chromium automatically (via the
`puppeteer` package), so the browser bypass works out of the box on
Linux hosts (Railway, Render, Fly.io, VPS) with no extra setup.

### 4. Run

```bash
npm run dev
```

### 5. Build for production

```bash
npm run build
npm start
```

## Deployment (Free)

### Fly.io (Recommended)

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Create app
fly launch

# Set secrets
fly secrets set BOT_TOKEN=your_token_here

# Deploy
fly deploy
```

### Railway

1. Push to GitHub
2. Connect repo on railway.app
3. Add environment variables
4. Deploy

### Render

1. Push to GitHub
2. Create Web Service on render.com
3. Set build command: `npm install && npm run build`
4. Set start command: `npm start`
5. Add environment variables

## Project Structure

```
src/
  index.ts              — Entry point
  config/env.ts         — Environment config
  bot/
    bot.ts              — Telegraf setup
    handlers/message.ts — Command handlers
  resolver/
    url-resolver.ts     — Core redirect resolution
    redirect-chain.ts   — Chain data structure
  bypass/
    browser.ts          — Headless browser launcher (auto-detects Chrome)
    engine.ts           — Multi-step bypass: timers, Get Link/Continue clicks, ad-skip
    html-inspector.ts   — Fast static HTML target extraction
    adblock.ts          — Ad/tracker/popup domain blocklist
    page-actions.ts     — Button/timer pattern helpers (unit-tested)
  security/
    url-validator.ts    — URL validation
    ssrf-protection.ts  — SSRF protection
    reputation-service.ts — Security status stub
  utils/
    logger.ts           — Logging
    cache.ts            — In-memory cache
  __tests__/            — Unit tests
```

## Testing

```bash
npm test
```

## Architecture

- **Bot layer**: Telegram-specific, handles messages and responses
- **Resolver layer**: Independent URL resolution, no Telegram dependency
- **Security layer**: URL validation and SSRF protection
- **Cache layer**: In-memory TTL cache for repeated lookups

The resolver can be tested and used independently without Telegram.

## Adding Security Services

To integrate VirusTotal or Google Safe Browsing:

1. Add API key to `.env`
2. Update `src/security/reputation-service.ts`
3. The bot will automatically use the new status

## License

MIT
