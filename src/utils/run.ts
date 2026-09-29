/** Per-tool-run bookkeeping: token usage, spend estimate, call budget, response cache, progress. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BudgetExceededError } from "./errors.js";
import { log } from "./logger.js";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export class UsageMeter {
  calls = 0;
  cachedCalls = 0;
  promptTokens = 0;
  completionTokens = 0;
  readonly byPurpose: Record<string, { calls: number; cached: number; promptTokens: number; completionTokens: number }> = {};

  record(purpose: string, usage: Usage | undefined, cached: boolean) {
    const p = (this.byPurpose[purpose] ??= { calls: 0, cached: 0, promptTokens: 0, completionTokens: 0 });
    if (cached) {
      this.cachedCalls++;
      p.cached++;
      return;
    }
    this.calls++;
    p.calls++;
    this.promptTokens += usage?.promptTokens ?? 0;
    this.completionTokens += usage?.completionTokens ?? 0;
    p.promptTokens += usage?.promptTokens ?? 0;
    p.completionTokens += usage?.completionTokens ?? 0;
  }

  costUsd(prices?: { inputPerM: number; outputPerM: number }): number | undefined {
    if (!prices) return undefined;
    return (this.promptTokens * prices.inputPerM + this.completionTokens * prices.outputPerM) / 1_000_000;
  }

  summary(prices?: { inputPerM: number; outputPerM: number }): string {
    const cost = this.costUsd(prices);
    const parts = [
      `${this.calls} API call(s)`,
      this.cachedCalls ? `${this.cachedCalls} served from cache (free)` : "",
      `${this.promptTokens.toLocaleString()} in / ${this.completionTokens.toLocaleString()} out tokens`,
      cost !== undefined ? `≈ $${cost.toFixed(4)} (≈ ¥${(cost * 7.2).toFixed(3)})` : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }

  toJSON() {
    return { calls: this.calls, cachedCalls: this.cachedCalls, promptTokens: this.promptTokens, completionTokens: this.completionTokens, byPurpose: this.byPurpose };
  }
}

export class CallBudget {
  used = 0;
  constructor(readonly max: number) {}
  consume(purpose: string) {
    if (this.used >= this.max) throw new BudgetExceededError(`Call budget of ${this.max} exhausted (at: ${purpose}). Raise maxCalls / UPO_MAX_CALLS to allow more.`);
    this.used++;
  }
  get remaining() {
    return this.max - this.used;
  }
}

export interface CachedResponse {
  text: string;
  model: string;
  usage?: Usage;
  createdAt: number;
}

/** Content-addressed JSON cache on disk (identical request → identical stored response, zero cost). */
export class DiskCache {
  private ready?: Promise<void>;
  constructor(
    private readonly dir: string,
    private readonly ttlMs = 14 * 24 * 3600_000,
  ) {}

  static key(parts: unknown): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  private path(key: string) {
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<CachedResponse | undefined> {
    try {
      const v = JSON.parse(await readFile(this.path(key), "utf8")) as CachedResponse;
      return Date.now() - v.createdAt < this.ttlMs ? v : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: CachedResponse) {
    try {
      const p = this.path(key);
      await mkdir(join(this.dir, key.slice(0, 2)), { recursive: true });
      await writeFile(p, JSON.stringify(value));
    } catch (e) {
      log.debug(`cache write failed: ${(e as Error).message}`);
    }
  }
}

export type ProgressFn = (message: string, progress?: number, total?: number) => void;

export interface RunContext {
  meter: UsageMeter;
  budget: CallBudget;
  progress: ProgressFn;
  deadline?: number; // epoch ms — long runs stop gracefully after this
}

export function newRun(maxCalls: number, progress: ProgressFn = () => undefined, maxMinutes?: number): RunContext {
  return { meter: new UsageMeter(), budget: new CallBudget(maxCalls), progress, deadline: maxMinutes ? Date.now() + maxMinutes * 60_000 : undefined };
}
