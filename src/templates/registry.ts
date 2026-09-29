/** Template registry: built-ins + user templates from custom-templates/ (Markdown with frontmatter, or JSON). */
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { log } from "../utils/logger.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";
import { buildEvidence } from "./shared.js";
import type { PromptTemplate, TemplateMessage, TemplateType, TemplateVars } from "./types.js";

const TemplateFileSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  type: z.enum(["optimize-system", "optimize-user", "iterate"]),
  name: z.string().optional(),
  description: z.string().optional(),
  messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string().min(1) })).min(1).optional(),
});

export const DEFAULT_TEMPLATE: Record<TemplateType, string> = {
  "optimize-system": "langgpt-strict",
  "optimize-user": "user-basic",
  iterate: "iterate",
};

export class TemplateRegistry {
  private custom: PromptTemplate[] = [];
  private loadedAt = 0;

  constructor(private readonly dir: string) {}

  /** Re-read custom templates at most every 5 s so edits apply without restarting Claude. */
  private async refresh() {
    if (Date.now() - this.loadedAt < 5_000) return;
    this.loadedAt = Date.now();
    const found: PromptTemplate[] = [];
    let files: string[] = [];
    try {
      files = await readdir(this.dir);
    } catch {
      this.custom = [];
      return;
    }
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      if (![".md", ".json", ".yaml", ".yml"].includes(ext)) continue;
      const path = join(this.dir, f);
      try {
        const raw = await readFile(path, "utf8");
        let data: unknown;
        if (ext === ".md") {
          // Markdown: YAML frontmatter + body. Body = system message; user message defaults to evidence.
          const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
          if (!m) throw new Error("missing --- frontmatter ---");
          const fm = parseYaml(m[1]) as Record<string, unknown>;
          data = { ...fm, messages: [{ role: "system", content: m[2].trim() }, { role: "user", content: "{{evidence}}\n\nOutput only the resulting prompt." }] };
        } else {
          data = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
        }
        const t = TemplateFileSchema.parse(data);
        if (!t.messages) throw new Error("messages required");
        found.push({ id: t.id, type: t.type, name: t.name ?? t.id, description: t.description ?? "Custom template", messages: t.messages, builtin: false, source: path });
      } catch (e) {
        log.warn(`Skipping custom template ${path}: ${(e as Error).message}`);
      }
    }
    this.custom = found;
  }

  async list(type?: TemplateType): Promise<PromptTemplate[]> {
    await this.refresh();
    const customIds = new Set(this.custom.map((t) => t.id));
    const all = [...this.custom, ...BUILTIN_TEMPLATES.filter((t) => !customIds.has(t.id))]; // custom overrides builtin id
    return type ? all.filter((t) => t.type === type) : all;
  }

  async get(type: TemplateType, id?: string): Promise<PromptTemplate> {
    const list = await this.list(type);
    const wanted = id ?? DEFAULT_TEMPLATE[type];
    const t = list.find((x) => x.id === wanted);
    if (!t) throw new Error(`Unknown ${type} template "${wanted}". Available: ${list.map((x) => x.id).join(", ")}`);
    return t;
  }

  async has(id: string): Promise<boolean> {
    return (await this.list()).some((t) => t.id === id);
  }
}

/** Single-pass substitution: inserted values are never re-scanned, so {{placeholders}} inside user prompts survive. */
export function renderTemplate(t: PromptTemplate, vars: TemplateVars): TemplateMessage[] {
  const evidence =
    vars.evidence ??
    buildEvidence({
      originalPrompt: vars.originalPrompt,
      lastOptimizedPrompt: vars.lastOptimizedPrompt,
      requirements: vars.requirements,
    });
  const table: Record<string, string> = {
    originalPrompt: vars.originalPrompt,
    lastOptimizedPrompt: vars.lastOptimizedPrompt ?? vars.originalPrompt,
    requirements: vars.requirements ?? "",
    language: vars.language ?? "",
    evidence,
  };
  return t.messages.map((m) => ({
    role: m.role,
    content: m.content.replace(/\{\{\s*(originalPrompt|lastOptimizedPrompt|requirements|language|evidence)\s*\}\}/g, (_, k: string) => table[k]),
  }));
}

export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]))];
}

export function missingPlaceholders(source: string, output: string): string[] {
  const have = new Set(placeholdersOf(output));
  return placeholdersOf(source).filter((p) => !have.has(p));
}
