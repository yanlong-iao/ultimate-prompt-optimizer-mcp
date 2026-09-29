import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { PromptOptimizerAuth } from "./clients/auth.js";
import { LlmClient } from "./clients/llmClient.js";
import { RemoteOptimizerClient } from "./clients/optimizerClient.js";
import { TemplateRegistry } from "./templates/registry.js";
import { errMsg } from "./utils/errors.js";
import { log } from "./utils/logger.js";
import { DiskCache, newRun, type ProgressFn, type RunContext } from "./utils/run.js";
import { HistoryStore } from "./utils/store.js";

export interface AppContext {
  config: AppConfig;
  auth: PromptOptimizerAuth;
  remote: RemoteOptimizerClient;
  llm: LlmClient;
  evalLlm: LlmClient;
  judge: LlmClient;
  templates: TemplateRegistry;
  history: HistoryStore;
}

export function createContext(config: AppConfig): AppContext {
  const auth = new PromptOptimizerAuth({
    baseUrl: config.optimizer.baseUrl,
    password: config.optimizer.password,
    username: config.optimizer.username,
    mode: config.optimizer.authMode,
    timeoutMs: config.optimizer.timeoutMs,
    extraHeaders: config.optimizer.extraHeaders,
  });
  const cache = config.cacheEnabled ? new DiskCache(join(config.dataDir, ".cache")) : undefined;
  return {
    config,
    auth,
    remote: new RemoteOptimizerClient(auth, { mcpUrl: config.optimizer.mcpUrl, timeoutMs: config.optimizer.timeoutMs }),
    llm: new LlmClient(config.llm, cache),
    evalLlm: new LlmClient(config.evalLlm, cache),
    judge: new LlmClient({ ...config.evalLlm, model: config.judgeModel }, cache),
    templates: new TemplateRegistry(config.templatesDir),
    history: new HistoryStore(config.dataDir),
  };
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Minimal shape of the MCP request "extra" we use for progress notifications. */
export interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
}

export function progressFrom(extra: ToolExtra | undefined): ProgressFn {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return (m) => log.debug(`progress: ${m}`);
  let n = 0;
  let last = 0;
  return (message) => {
    const now = Date.now();
    if (now - last < 400) return;
    last = now;
    extra.sendNotification!({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => undefined);
  };
}

/** A metered run: LLM clients bound to one usage meter + call budget. */
export function startRun(ctx: AppContext, opts: { maxCalls?: number; maxMinutes?: number; extra?: ToolExtra }) {
  const run: RunContext = newRun(opts.maxCalls ?? ctx.config.maxCalls, progressFrom(opts.extra), opts.maxMinutes);
  return {
    run,
    llm: ctx.llm.withRun(run),
    evalLlm: ctx.evalLlm.withRun(run),
    judge: ctx.judge.withRun(run),
    usage: () => run.meter.summary(ctx.config.prices),
  };
}

/** Uniform error envelope so the host model sees actionable messages instead of a crashed call. */
export async function safeTool(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  try {
    const r = await fn();
    log.info(`${name} ok in ${Date.now() - started} ms`);
    return r;
  } catch (e) {
    log.error(`${name} failed`, e);
    return { isError: true, content: [{ type: "text", text: `${name} failed — ${errMsg(e)}` }] };
  }
}

export const isZh = (s: string) => /[一-鿿]/.test(s);
