/**
 * Authentication for a deployed linshenkx/prompt-optimizer instance.
 *
 * Two completely different mechanisms exist upstream:
 *
 * 1) Vercel (api/auth.js + middleware.js)
 *    POST {base}/api/auth   Content-Type: application/json
 *         {"action":"verify","password":"<ACCESS_PASSWORD>"}
 *      200 {"success":true,"message":"Authentication successful"}
 *          Set-Cookie: vercel_access_token=<ACCESS_PASSWORD>; HttpOnly; Path=/; Max-Age=604800; SameSite=Strict[; Secure]
 *      401 {"success":false,"message":"Invalid password"}
 *      200 {"success":true,"message":"No password protection configured"}   (no cookie)
 *    Every later request: `Cookie: vercel_access_token=<value>`. middleware.js compares the cookie
 *    value to ACCESS_PASSWORD verbatim; an unauthenticated request gets a 200 HTML login page (not 401!).
 *    GET {base}/api/auth?action=logout clears the cookie.
 *
 * 2) Docker (docker/generate-auth.sh + nginx.conf)
 *    nginx HTTP Basic auth: `Authorization: Basic base64(ACCESS_USERNAME:ACCESS_PASSWORD)`,
 *    username defaults to "admin". The /mcp and /healthz locations are explicitly `auth_basic off`.
 */
import { AuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { joinUrl } from "../utils/text.js";

export type AuthModeSetting = "auto" | "vercel-cookie" | "basic" | "none";
export type ResolvedAuthMode = "vercel-cookie" | "basic" | "none";

export interface ResolvedAuth {
  mode: ResolvedAuthMode;
  headers: Record<string, string>;
  detail: string;
  resolvedAt: number;
}

export interface AuthOptions {
  baseUrl?: string;
  password?: string;
  username: string;
  mode: AuthModeSetting;
  timeoutMs: number;
  extraHeaders: Record<string, string>;
}

const COOKIE_NAME = "vercel_access_token";

export class PromptOptimizerAuth {
  private resolved?: ResolvedAuth;
  private inflight?: Promise<ResolvedAuth>;

  constructor(private readonly opts: AuthOptions) {}

  /** Headers to attach to every upstream request (resolves/logs in lazily, de-duplicated). */
  async getHeaders(): Promise<Record<string, string>> {
    const auth = await this.ensure();
    return { ...this.opts.extraHeaders, ...auth.headers };
  }

  async ensure(force = false): Promise<ResolvedAuth> {
    if (!force && this.resolved) return this.resolved;
    if (!this.inflight) {
      this.inflight = this.resolve().finally(() => {
        this.inflight = undefined;
      });
    }
    this.resolved = await this.inflight;
    log.info(`Auth resolved: ${this.resolved.mode} (${this.resolved.detail})`);
    return this.resolved;
  }

  /** Forget the cached credentials — the next request logs in again (used after a 401). */
  invalidate() {
    this.resolved = undefined;
  }

  get current(): ResolvedAuth | undefined {
    return this.resolved;
  }

  private none(detail: string): ResolvedAuth {
    return { mode: "none", headers: {}, detail, resolvedAt: Date.now() };
  }

  private async resolve(): Promise<ResolvedAuth> {
    const { mode, password, baseUrl } = this.opts;
    if (mode === "none") return this.none("PO_AUTH_MODE=none");
    if (!password) {
      if (mode === "auto") return this.none("no PO_ACCESS_PASSWORD set");
      throw new AuthError(`PO_AUTH_MODE=${mode} requires PO_ACCESS_PASSWORD`);
    }
    if (!baseUrl) throw new AuthError("PO_BASE_URL is required to authenticate");

    if (mode === "vercel-cookie") return (await this.loginVercel(true))!;
    if (mode === "basic") return (await this.verifyBasic(true))!;

    // auto: try the Vercel handshake first (cheap, unambiguous JSON), then Basic.
    const vercel = await this.loginVercel(false);
    if (vercel) return vercel;
    const basic = await this.verifyBasic(false);
    if (basic) return basic;
    throw new AuthError(
      `Could not determine the auth scheme of ${baseUrl}: /api/auth is not a prompt-optimizer Vercel handler and Basic auth did not succeed. ` +
        `Set PO_AUTH_MODE explicitly (vercel-cookie | basic | none).`,
    );
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = joinUrl(this.opts.baseUrl!, path);
    try {
      return await fetch(url, {
        ...init,
        redirect: "manual",
        headers: { ...this.opts.extraHeaders, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(Math.min(this.opts.timeoutMs, 30_000)),
      });
    } catch (e) {
      throw new AuthError(`Network error contacting ${url}: ${(e as Error).message}`);
    }
  }

  /** Vercel flow. Returns null (in non-strict mode) when the endpoint is not the Vercel auth handler. */
  private async loginVercel(strict: boolean): Promise<ResolvedAuth | null> {
    const res = await this.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action: "verify", password: this.opts.password }),
    });

    const ct = res.headers.get("content-type") ?? "";
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    let body: { success?: boolean; message?: string } | undefined;
    if (ct.includes("application/json")) body = (await res.json().catch(() => undefined)) as typeof body;
    else await res.body?.cancel().catch(() => undefined);

    if (res.status === 401 && /basic/i.test(wwwAuth)) {
      // nginx Basic auth wall in front of /api/auth → this is the Docker image, not Vercel.
      if (strict) throw new AuthError("Got an HTTP Basic challenge from /api/auth — this looks like the Docker deployment; use PO_AUTH_MODE=basic");
      return null;
    }
    if (res.status === 401 && body && body.success === false) {
      throw new AuthError(`Vercel /api/auth rejected the password: ${body.message ?? "Invalid password"}`);
    }
    if (res.ok && body?.success === true) {
      const token = readCookie(res.headers, COOKIE_NAME);
      if (token !== undefined) {
        return {
          mode: "vercel-cookie",
          headers: { Cookie: `${COOKIE_NAME}=${token}` },
          detail: "POST /api/auth → Set-Cookie vercel_access_token",
          resolvedAt: Date.now(),
        };
      }
      if (/no password/i.test(body.message ?? "")) return this.none("server reports no password protection");
      // Success but the cookie was stripped (proxy / runtime). middleware.js only checks cookie === password,
      // so the cookie can be reconstructed deterministically.
      return {
        mode: "vercel-cookie",
        headers: { Cookie: `${COOKIE_NAME}=${this.opts.password}` },
        detail: "POST /api/auth succeeded, Set-Cookie not visible — reconstructed cookie from password",
        resolvedAt: Date.now(),
      };
    }
    if (strict) throw new AuthError(`Unexpected response from POST /api/auth: HTTP ${res.status} (${ct || "no content-type"})`);
    return null;
  }

  /** Docker/nginx flow. */
  private async verifyBasic(strict: boolean): Promise<ResolvedAuth | null> {
    const token = Buffer.from(`${this.opts.username}:${this.opts.password}`, "utf8").toString("base64");
    const headers = { Authorization: `Basic ${token}` };
    const res = await this.request("/", { method: "GET", headers });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`HTTP Basic auth rejected for user "${this.opts.username}" (HTTP ${res.status}) — check PO_ACCESS_USERNAME / PO_ACCESS_PASSWORD`);
    }
    if (res.status < 400) {
      return { mode: "basic", headers, detail: `HTTP Basic as "${this.opts.username}" (GET / → ${res.status})`, resolvedAt: Date.now() };
    }
    if (strict) throw new AuthError(`Basic auth probe failed: GET / → HTTP ${res.status}`);
    return null;
  }

  /** Vercel logout (best-effort; the cookie is just the password, so this is cosmetic server-side). */
  async logout(): Promise<void> {
    if (this.resolved?.mode === "vercel-cookie" && this.opts.baseUrl) {
      await this.request("/api/auth?action=logout", { method: "GET" }).catch(() => undefined);
    }
    this.invalidate();
  }
}

function readCookie(headers: Headers, name: string): string | undefined {
  const list: string[] =
    typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=\s*[\w-]+=)/);
  for (const raw of list) {
    const pair = raw.split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === name) {
      const value = pair.slice(eq + 1);
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}
