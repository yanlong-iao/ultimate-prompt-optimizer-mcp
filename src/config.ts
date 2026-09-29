import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigError } from "./utils/errors.js";
import type { LogLevel } from "./utils/logger.js";

// Load .env from: $UPO_ENV_FILE (exclusively, if set) → project root (next to dist/) → cwd.
// Claude Desktop launches servers with an unpredictable cwd, so the project-root lookup matters.
// `quiet: true` is essential: dotenv@17 otherwise prints to stdout and corrupts the stdio protocol.
const here = dirname(fileURLToPath(import.meta.url));
// An explicit UPO_ENV_FILE is the only file consulted (even if missing) — keeps tests and alternate profiles isolated.
const envFiles = process.env.UPO_ENV_FILE ? [process.env.UPO_ENV_FILE] : [resolve(here, "..", ".env"), resolve(process.cwd(), ".env")];
for (const p of envFiles) {
  if (p && existsSync(p)) {
    loadDotenv({ path: p, quiet: true, override: false });
    break;
  }
}

const EnvSchema = z.object({
  PO_BASE_URL: z.string().url().optional(),
  PO_MCP_URL: z.string().url().optional(),
  PO_ACCESS_PASSWORD: z.string().optional(),
  PO_ACCESS_USERNAME: z.string().default("admin"),
  PO_AUTH_MODE: z.enum(["auto", "vercel-cookie", "basic", "none"]).default("auto"),
  PO_BACKEND: z.enum(["auto", "remote", "local"]).default("auto"),
  PO_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  PO_EXTRA_HEADERS: z.string().optional(),

  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  EVAL_BASE_URL: z.string().url().optional(),
  EVAL_API_KEY: z.string().optional(),
  EVAL_MODEL: z.string().optional(),
  JUDGE_MODEL: z.string().optional(),

  // Pricing (USD per 1M tokens) — only used to show estimated spend; leave unset to show tokens only.
  LLM_PRICE_INPUT_PER_M: z.coerce.number().nonnegative().optional(),
  LLM_PRICE_OUTPUT_PER_M: z.coerce.number().nonnegative().optional(),

  UPO_DATA_DIR: z.string().optional(),
  UPO_TEMPLATES_DIR: z.string().optional(),
  UPO_CACHE: z.string().optional(),
  UPO_MAX_CALLS: z.coerce.number().int().positive().default(80),
  UPO_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const PROJECT_ROOT = resolve(here, "..");

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export interface AppConfig {
  optimizer: {
    baseUrl?: string;
    mcpUrl?: string;
    password?: string;
    username: string;
    authMode: "auto" | "vercel-cookie" | "basic" | "none";
    backend: "auto" | "remote" | "local";
    timeoutMs: number;
    extraHeaders: Record<string, string>;
  };
  llm: LlmConfig;
  evalLlm: LlmConfig;
  judgeModel: string;
  prices?: { inputPerM: number; outputPerM: number };
  dataDir: string;
  templatesDir: string;
  cacheEnabled: boolean;
  maxCalls: number;
  concurrency: number;
  logLevel: LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings (common in Claude Desktop "env" blocks) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid environment configuration — ${issues}`);
  }
  const e = parsed.data;

  let extraHeaders: Record<string, string> = {};
  if (e.PO_EXTRA_HEADERS) {
    try {
      extraHeaders = z.record(z.string(), z.string()).parse(JSON.parse(e.PO_EXTRA_HEADERS));
    } catch {
      throw new ConfigError("PO_EXTRA_HEADERS must be a JSON object of string → string");
    }
  }

  const mcpUrl = e.PO_MCP_URL ?? (e.PO_BASE_URL ? new URL("mcp", e.PO_BASE_URL.replace(/\/?$/, "/")).toString() : undefined);
  const llm: LlmConfig = { baseUrl: e.LLM_BASE_URL, apiKey: e.LLM_API_KEY, model: e.LLM_MODEL, timeoutMs: e.LLM_TIMEOUT_MS };
  const evalLlm: LlmConfig = {
    baseUrl: e.EVAL_BASE_URL ?? llm.baseUrl,
    apiKey: e.EVAL_API_KEY ?? llm.apiKey,
    model: e.EVAL_MODEL ?? llm.model,
    timeoutMs: llm.timeoutMs,
  };

  return {
    optimizer: {
      baseUrl: e.PO_BASE_URL,
      mcpUrl,
      password: e.PO_ACCESS_PASSWORD,
      username: e.PO_ACCESS_USERNAME,
      authMode: e.PO_AUTH_MODE,
      backend: e.PO_BACKEND,
      timeoutMs: e.PO_TIMEOUT_MS,
      extraHeaders,
    },
    llm,
    evalLlm,
    judgeModel: e.JUDGE_MODEL ?? evalLlm.model,
    prices:
      e.LLM_PRICE_INPUT_PER_M !== undefined && e.LLM_PRICE_OUTPUT_PER_M !== undefined
        ? { inputPerM: e.LLM_PRICE_INPUT_PER_M, outputPerM: e.LLM_PRICE_OUTPUT_PER_M }
        : undefined,
    dataDir: resolve(PROJECT_ROOT, e.UPO_DATA_DIR ?? "."),
    templatesDir: resolve(PROJECT_ROOT, e.UPO_TEMPLATES_DIR ?? "custom-templates"),
    cacheEnabled: !/^(0|false|no|off)$/i.test(e.UPO_CACHE ?? "true"),
    maxCalls: e.UPO_MAX_CALLS,
    concurrency: e.UPO_CONCURRENCY,
    logLevel: e.LOG_LEVEL,
  };
}
