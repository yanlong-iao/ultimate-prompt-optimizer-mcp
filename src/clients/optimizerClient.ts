/**
 * Client for the prompt-optimizer "core optimization endpoints".
 *
 * prompt-optimizer has no REST optimize API — the web UI calls LLMs from the browser. The only
 * programmatic backend is its built-in MCP server (packages/mcp-server), exposed by the Docker
 * image at {base}/mcp over Streamable HTTP, with tools:
 *   optimize-user-prompt   { prompt, template? }
 *   optimize-system-prompt { prompt, template? }
 *   iterate-prompt         { prompt, requirements, template? }
 * So this module is an MCP *client* whose fetch layer injects the resolved auth headers.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PromptOptimizerAuth } from "./auth.js";
import { AuthError, UpstreamToolError, UpstreamUnavailableError, errMsg } from "../utils/errors.js";
import { log } from "../utils/logger.js";

export const UPSTREAM_TOOLS = ["optimize-user-prompt", "optimize-system-prompt", "iterate-prompt"] as const;
export type UpstreamTool = (typeof UPSTREAM_TOOLS)[number];

export interface Availability {
  ok: boolean;
  reason: string;
  tools?: string[];
  checkedAt: number;
}

export class RemoteOptimizerClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private connecting?: Promise<Client>;
  private availability?: Availability;

  constructor(
    private readonly auth: PromptOptimizerAuth,
    private readonly opts: { mcpUrl?: string; timeoutMs: number },
  ) {}

  get mcpUrl() {
    return this.opts.mcpUrl;
  }

  /** fetch wrapper: inject auth headers, re-login once on 401/403, reject HTML (auth wall / SPA fallback). */
  private authFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const send = async () => {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(await this.auth.getHeaders())) headers.set(k, v);
      return fetch(input, { ...init, headers });
    };
    let res = await send();
    if (res.status === 401 || res.status === 403) {
      log.warn(`Upstream ${res.status} on ${init?.method ?? "GET"} ${input} — re-authenticating once`);
      await res.body?.cancel().catch(() => undefined);
      this.auth.invalidate();
      res = await send();
      if (res.status === 401 || res.status === 403) throw new AuthError(`Upstream still returns HTTP ${res.status} after re-authentication`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && ct.includes("text/html")) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamUnavailableError(
        `${input} returned an HTML page instead of an MCP response. This is the Vercel login page or the SPA fallback — ` +
          `a Vercel/Cloudflare static deployment has no /mcp backend. Use the Docker image, or let PO_BACKEND=auto fall back to the local LLM.`,
      );
    }
    return res;
  };

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.opts.mcpUrl) throw new UpstreamUnavailableError("PO_BASE_URL / PO_MCP_URL not configured");
    if (!this.connecting) {
      this.connecting = (async () => {
        const transport = new StreamableHTTPClientTransport(new URL(this.opts.mcpUrl!), { fetch: this.authFetch });
        const client = new Client({ name: "ultimate-prompt-optimizer", version: "0.1.0" });
        client.onerror = (e) => log.debug(`upstream MCP transport error: ${errMsg(e)}`);
        await client.connect(transport);
        this.client = client;
        this.transport = transport;
        log.info(`Connected to upstream MCP ${this.opts.mcpUrl} (session ${transport.sessionId ?? "n/a"})`);
        return client;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  async reset() {
    const c = this.client;
    this.client = undefined;
    this.transport = undefined;
    await c?.close().catch(() => undefined);
  }

  /** Probe once and cache (success cached 10 min, failure 30 s). */
  async checkAvailability(force = false): Promise<Availability> {
    const a = this.availability;
    if (!force && a && Date.now() - a.checkedAt < (a.ok ? 600_000 : 30_000)) return a;
    try {
      const client = await this.connect();
      const { tools } = await client.listTools(undefined, { timeout: 30_000 });
      const names = tools.map((t) => t.name);
      const missing = UPSTREAM_TOOLS.filter((t) => !names.includes(t));
      this.availability = missing.length
        ? { ok: false, reason: `Upstream MCP is missing tools: ${missing.join(", ")}`, tools: names, checkedAt: Date.now() }
        : { ok: true, reason: `upstream MCP ok (${names.length} tools)`, tools: names, checkedAt: Date.now() };
    } catch (e) {
      await this.reset();
      if (e instanceof AuthError) throw e; // wrong password must surface, never silently fall back
      this.availability = { ok: false, reason: errMsg(e), checkedAt: Date.now() };
    }
    return this.availability;
  }

  async listTemplates(): Promise<Record<string, string[]>> {
    const client = await this.connect();
    const { tools } = await client.listTools();
    const out: Record<string, string[]> = {};
    for (const t of tools) {
      const tmpl = (t.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.template;
      if (tmpl?.enum) out[t.name] = tmpl.enum;
    }
    return out;
  }

  async callTool(name: UpstreamTool, args: Record<string, string>): Promise<string> {
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ""));
    for (let attempt = 1; ; attempt++) {
      try {
        const client = await this.connect();
        const result = await client.callTool({ name, arguments: clean }, undefined, {
          timeout: this.opts.timeoutMs,
          resetTimeoutOnProgress: true,
        });
        const text = ((result.content as Array<{ type: string; text?: string }>) ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n")
          .trim();
        if (result.isError) throw new UpstreamToolError(`${name}: ${text || "unknown upstream error"}`);
        if (!text) throw new UpstreamToolError(`${name} returned empty content`);
        return text;
      } catch (e) {
        const sessionLost =
          (e instanceof StreamableHTTPError && (e.code === 400 || e.code === 404)) || /session/i.test((e as Error).message ?? "");
        if (attempt === 1 && sessionLost) {
          log.warn(`Upstream MCP session lost (${errMsg(e)}); reconnecting`);
          await this.reset();
          continue;
        }
        throw e;
      }
    }
  }
}
