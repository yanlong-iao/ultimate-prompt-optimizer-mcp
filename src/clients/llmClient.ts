/** OpenAI-compatible Chat Completions client (DeepSeek, OpenAI, SiliconFlow, OpenRouter, Ollama...) with cache, usage metering and call budget. */
import type { LlmConfig } from "../config.js";
import { LlmError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { DiskCache, type RunContext } from "../utils/run.js";
import { joinUrl } from "../utils/text.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  model?: string;
  /** Reuse an identical earlier response from disk (default false — generation tasks usually want fresh output). */
  cache?: boolean;
  /** Extra cache-key material, e.g. the repeat index so repeated samples are distinct. */
  cacheSalt?: string | number;
  /** Label for usage accounting (e.g. "optimize", "judge"). */
  purpose?: string;
}

export interface ChatResult {
  text: string;
  latencyMs: number;
  model: string;
  cached: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

export class LlmClient {
  constructor(
    private readonly cfg: LlmConfig,
    private readonly cache?: DiskCache,
    private readonly run?: RunContext,
  ) {}

  /** Same endpoint/cache, but metered against a specific tool run. */
  withRun(run: RunContext): LlmClient {
    return new LlmClient(this.cfg, this.cache, run);
  }

  withModel(model: string): LlmClient {
    return new LlmClient({ ...this.cfg, model }, this.cache, this.run);
  }

  get model() {
    return this.cfg.model;
  }

  get baseUrl() {
    return this.cfg.baseUrl;
  }

  /** A key is required unless the endpoint is local (e.g. Ollama at localhost:11434/v1). */
  get available(): boolean {
    return Boolean(this.cfg.apiKey) || /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(this.cfg.baseUrl);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (!this.available) throw new LlmError("LLM not configured: set LLM_API_KEY (and LLM_BASE_URL / LLM_MODEL)");
    const model = opts.model ?? this.cfg.model;
    const purpose = opts.purpose ?? "chat";
    const temperature = opts.temperature ?? 0.4;

    const useCache = Boolean(opts.cache && this.cache);
    const key = useCache
      ? DiskCache.key({ b: this.cfg.baseUrl, model, messages, temperature, json: !!opts.json, max: opts.maxTokens ?? null, salt: opts.cacheSalt ?? null })
      : "";
    if (useCache) {
      const hit = await this.cache!.get(key);
      if (hit) {
        this.run?.meter.record(purpose, hit.usage, true);
        return { text: hit.text, latencyMs: 0, model: hit.model, cached: true, usage: hit.usage };
      }
    }

    this.run?.budget.consume(purpose);
    const body: Record<string, unknown> = { model, messages, temperature };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    let useJsonMode = Boolean(opts.json);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(joinUrl(this.cfg.baseUrl, "/chat/completions"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          },
          body: JSON.stringify(useJsonMode ? { ...body, response_format: { type: "json_object" } } : body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (e) {
        if (attempt === 3) throw new LlmError(`LLM request failed: ${(e as Error).message}`);
        await sleep(800 * attempt);
        continue;
      }

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };
        const text = data.choices?.[0]?.message?.content ?? "";
        const usage = { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 };
        this.run?.meter.record(purpose, usage, false);
        const result: ChatResult = { text, latencyMs: Date.now() - started, model: data.model ?? model, cached: false, usage };
        if (useCache && text) await this.cache!.set(key, { text, model: result.model, usage, createdAt: Date.now() });
        return result;
      }

      const errText = await res.text().catch(() => "");
      if (res.status === 400 && useJsonMode && /response_format|json/i.test(errText)) {
        log.debug("Provider rejected response_format; retrying without JSON mode");
        useJsonMode = false;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const hint =
        res.status === 401 ? " (invalid API key)" : res.status === 402 ? " (insufficient balance — top up your account)" : res.status === 404 ? " (wrong LLM_BASE_URL or model name)" : "";
      throw new LlmError(`LLM HTTP ${res.status}${hint}: ${errText.slice(0, 300)}`, res.status);
    }
    throw new LlmError("LLM request failed after retries");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
