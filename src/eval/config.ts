/** Load a promptfoo-style config (YAML/JSON) or test files (YAML/JSON/CSV) into our eval plan. */
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { PROJECT_ROOT } from "../config.js";
import { BASE_TYPES, type Assertion, type TestCase } from "./types.js";
import { validateAssertions } from "./assertions.js";

export interface LoadedConfig {
  description?: string;
  prompts: Array<{ label: string; text: string }>;
  models: string[];
  tests: TestCase[];
  defaultAssert: Assertion[];
  repeat?: number;
  temperature?: number;
  promptMode?: "system" | "user";
}

const resolvePath = (p: string, base: string) => (isAbsolute(p) ? p : resolve(base, p.replace(/^~\//, `${process.env.HOME ?? ""}/`)));

async function readRef(value: string, base: string): Promise<string> {
  return readFile(resolvePath(value.replace(/^file:\/\//, ""), base), "utf8");
}

/** Cartesian expansion of vars whose values are arrays (promptfoo semantics). */
export function expandVars(vars: Record<string, unknown>): Array<Record<string, string>> {
  let rows: Array<Record<string, string>> = [{}];
  for (const [k, v] of Object.entries(vars)) {
    const values = Array.isArray(v) ? v : [v];
    rows = rows.flatMap((row) => values.map((x) => ({ ...row, [k]: typeof x === "string" ? x : JSON.stringify(x) })));
  }
  return rows;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** "contains: foo" / "not-regex: ^x" / "grade: be polite" / plain text (→ equals). */
function parseExpected(s: string): Assertion {
  const m = s.match(/^(not-)?([a-z][a-z-]*)\s*:\s*([\s\S]*)$/);
  if (m) {
    if (m[2] === "grade" || m[2] === "llm-rubric") return { type: `${m[1] ?? ""}llm-rubric`, value: m[3] };
    if ((BASE_TYPES as readonly string[]).includes(m[2])) return { type: `${m[1] ?? ""}${m[2]}`, value: m[3] };
  }
  return { type: "equals", value: s };
}

function normalizeTest(raw: Record<string, unknown>, where: string): TestCase[] {
  const assert = validateAssertions((raw.assert as unknown[]) ?? [], `${where}.assert`);
  const vars = (raw.vars as Record<string, unknown>) ?? {};
  const options = (raw.options as { transform?: string }) ?? {};
  return expandVars(vars).map((v) => ({
    description: raw.description as string | undefined,
    input: (raw.input as string | undefined) ?? v.input,
    vars: v,
    assert,
    threshold: raw.threshold as number | undefined,
    transform: options.transform,
  }));
}

export async function loadTestsFile(path: string, base = PROJECT_ROOT): Promise<TestCase[]> {
  const full = resolvePath(path.replace(/^file:\/\//, ""), base);
  const text = await readFile(full, "utf8");
  const ext = extname(full).toLowerCase();
  if (ext === ".csv") {
    const [header, ...rows] = parseCsv(text);
    if (!header) return [];
    return rows.map((cells) => {
      const vars: Record<string, string> = {};
      const assert: Assertion[] = [];
      let description: string | undefined;
      header.forEach((h, i) => {
        const cell = cells[i] ?? "";
        if (/^__expected\d*$/.test(h)) {
          if (cell.trim()) assert.push(parseExpected(cell.trim()));
        } else if (h === "__description") description = cell;
        else vars[h] = cell;
      });
      return { description, input: vars.input, vars, assert: validateAssertions(assert, `${path}`) };
    });
  }
  const data = ext === ".json" ? JSON.parse(text) : parseYaml(text);
  const list = Array.isArray(data) ? data : (data as { tests?: unknown[] }).tests ?? [];
  return (list as Record<string, unknown>[]).flatMap((t, i) => normalizeTest(t, `${path}[${i}]`));
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const full = resolvePath(path, PROJECT_ROOT);
  const base = dirname(full);
  const text = await readFile(full, "utf8");
  const cfg = (extname(full).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text)) as Record<string, unknown>;

  const prompts: LoadedConfig["prompts"] = [];
  for (const [i, p] of ((cfg.prompts as unknown[]) ?? []).entries()) {
    if (typeof p === "string") prompts.push({ label: `P${i + 1}`, text: p.startsWith("file://") ? await readRef(p, base) : p });
    else if (p && typeof p === "object") {
      const o = p as { raw?: string; id?: string; label?: string };
      const t = o.raw ?? (o.id?.startsWith("file://") ? await readRef(o.id, base) : o.id ?? "");
      prompts.push({ label: o.label ?? `P${i + 1}`, text: t });
    }
  }

  const models = ((cfg.providers as unknown[]) ?? [])
    .map((p) => (typeof p === "string" ? p : (p as { id?: string }).id ?? ""))
    .filter(Boolean)
    .map((id) => id.split(":").pop()!);

  let tests: TestCase[] = [];
  const t = cfg.tests;
  if (typeof t === "string") tests = await loadTestsFile(t, base);
  else if (Array.isArray(t)) {
    for (const [i, item] of t.entries()) {
      if (typeof item === "string") tests.push(...(await loadTestsFile(item, base)));
      else tests.push(...normalizeTest(item as Record<string, unknown>, `tests[${i}]`));
    }
  }

  const dt = (cfg.defaultTest as { assert?: unknown[]; vars?: Record<string, string>; options?: { transform?: string } }) ?? {};
  if (dt.vars) tests = tests.map((x) => ({ ...x, vars: { ...dt.vars, ...x.vars } }));
  if (dt.options?.transform) tests = tests.map((x) => ({ ...x, transform: x.transform ?? dt.options!.transform }));
  const opts = (cfg.evaluateOptions as { repeat?: number }) ?? {};

  return {
    description: cfg.description as string | undefined,
    prompts,
    models,
    tests,
    defaultAssert: validateAssertions(dt.assert ?? [], "defaultTest.assert"),
    repeat: opts.repeat,
    // extension: promptfoo prompts are user messages; set `promptMode: system` to send the prompt as the system message
    promptMode: cfg.promptMode === "system" || cfg.promptMode === "user" ? cfg.promptMode : undefined,
  };
}
