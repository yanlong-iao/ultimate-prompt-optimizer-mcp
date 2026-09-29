export class AuthError extends Error {
  override name = "AuthError";
}
/** The upstream deployment has no usable MCP endpoint (e.g. Vercel static build). */
export class UpstreamUnavailableError extends Error {
  override name = "UpstreamUnavailableError";
}
/** The upstream MCP tool ran but reported an error (e.g. model not configured). */
export class UpstreamToolError extends Error {
  override name = "UpstreamToolError";
}
export class LlmError extends Error {
  override name = "LlmError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
export class ConfigError extends Error {
  override name = "ConfigError";
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
/** A run hit its call budget (UPO_MAX_CALLS / maxCalls) — partial results are still returned where possible. */
export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
}
