/** Join a path onto a base URL while keeping any sub-path (e.g. https://host/app + /api/auth). */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\/+/, ""), b).toString();
}

/** Remove a single wrapping ```lang ... ``` fence that LLMs like to add. */
export function stripCodeFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [+${s.length - max} chars]`;
}

/** Replace {{var}} placeholders. Unknown placeholders are left intact. */
export function renderVars(template: string, vars: Record<string, string> = {}): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, k: string) => (k in vars ? vars[k] : all));
}

export function approxTokens(s: string): number {
  // CJK chars ≈ 1 token each, other text ≈ 4 chars/token
  const cjk = (s.match(/[　-鿿＀-￯]/g) ?? []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

export function detectLanguage(s: string): "zh" | "en" {
  const cjk = (s.match(/[一-鿿]/g) ?? []).length;
  return cjk / Math.max(1, s.replace(/\s/g, "").length) > 0.15 ? "zh" : "en";
}

/** Parse the first JSON object in a model response (tolerates fences / prose). */
export function extractJson<T = unknown>(text: string): T {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error(`Model did not return JSON: ${truncate(cleaned, 200)}`);
  }
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
