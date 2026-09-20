import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(process.cwd(), ".env") });

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${raw}`);
  }
  return parsed;
}

let _config: ReturnType<typeof buildConfig> | null = null;

function buildConfig() {
  return {
    BOT_TOKEN: getEnv("BOT_TOKEN"),
    MAX_REDIRECTS: getEnvInt("MAX_REDIRECTS", 10),
    REQUEST_TIMEOUT_MS: getEnvInt("REQUEST_TIMEOUT_MS", 8000),
    CACHE_TTL_SECONDS: getEnvInt("CACHE_TTL_SECONDS", 300),
  } as const;
}

export function getEnvConfig() {
  if (!_config) {
    _config = buildConfig();
  }
  return _config;
}

export type EnvConfig = ReturnType<typeof getEnvConfig>;
