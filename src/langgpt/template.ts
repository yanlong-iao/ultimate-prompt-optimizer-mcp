/**
 * LangGPT structure: schema → deterministic Markdown renderer → structural validator.
 * Supports the current LangGPT spec ("v2": Goal with Outcome/Done Criteria/Non-Goals, Skill-N subsections, Rules,
 * optional Commands/Reminder/Examples) and the classic layout (Goals / Skills list / Constraints).
 * The LLM never writes the skeleton: it fills a validated JSON spec and we render it.
 */
import { z } from "zod";

const SkillSchema = z.union([z.string().min(1), z.object({ name: z.string().min(1), items: z.array(z.string().min(1)).min(1) })]);

export const LangGPTSpecSchema = z.object({
  role: z.string().min(1),
  profile: z.object({
    author: z.string().default("LangGPT"),
    version: z.string().default("1.0"),
    language: z.string().min(1),
    description: z.string().min(1),
  }),
  background: z.string().optional(),
  goal: z
    .object({
      outcome: z.string().min(1),
      doneCriteria: z.array(z.string().min(1)).min(1),
      nonGoals: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  goals: z.array(z.string().min(1)).default([]),
  skills: z.array(SkillSchema).min(1),
  constraints: z.array(z.string().min(1)).min(1),
  workflow: z.array(z.string().min(1)).min(1),
  outputFormat: z.string().optional(),
  examples: z.array(z.object({ input: z.string(), output: z.string() })).optional(),
  commands: z
    .object({ prefix: z.string().default("/"), items: z.array(z.object({ name: z.string().min(1), description: z.string().min(1) })).min(1) })
    .optional(),
  reminder: z.array(z.string().min(1)).optional(),
  initialization: z.string().min(1),
});
export type LangGPTSpec = z.infer<typeof LangGPTSpecSchema>;
export type LangGPTStyle = "v2" | "classic";

const strip = (s: string) => s.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
const bullets = (items: string[]) => items.map((i) => `- ${strip(i)}`).join("\n");
const numbered = (items: string[]) => items.map((i, n) => `${n + 1}. ${strip(i)}`).join("\n");

export function renderLangGPT(spec: LangGPTSpec, style: LangGPTStyle = "v2"): string {
  const out: string[] = [
    `# Role: ${spec.role}`,
    "",
    "## Profile",
    `- Author: ${spec.profile.author}`,
    `- Version: ${spec.profile.version}`,
    `- Language: ${spec.profile.language}`,
    `- Description: ${spec.profile.description}`,
  ];
  if (spec.background) out.push("", "## Background", spec.background.trim());

  if (style === "v2") {
    const goal = spec.goal ?? { outcome: spec.goals[0] ?? spec.profile.description, doneCriteria: spec.goals.slice(1).length ? spec.goals.slice(1) : spec.goals, nonGoals: [] };
    out.push("", "## Goal", `- Outcome: ${goal.outcome}`, `- Done Criteria: ${goal.doneCriteria.map(strip).join("; ")}`);
    if (goal.nonGoals.length) out.push(`- Non-Goals: ${goal.nonGoals.map(strip).join("; ")}`);
    out.push("", "## Skills");
    spec.skills.forEach((s, i) => {
      if (typeof s === "string") out.push(`### Skill-${i + 1}`, `1. ${strip(s)}`);
      else out.push(`### Skill-${i + 1}: ${s.name}`, numbered(s.items));
    });
    out.push("", "## Rules", numbered(spec.constraints));
  } else {
    const goals = spec.goals.length ? spec.goals : spec.goal ? [spec.goal.outcome, ...spec.goal.doneCriteria] : [];
    out.push("", "## Goals", bullets(goals));
    out.push("", "## Constraints", bullets(spec.constraints));
    out.push("", "## Skills", bullets(spec.skills.map((s) => (typeof s === "string" ? s : `${s.name}: ${s.items.join("; ")}`))));
  }

  out.push("", "## Workflow", numbered(spec.workflow));
  if (spec.outputFormat) out.push("", "## OutputFormat", spec.outputFormat.trim());
  if (spec.examples?.length) {
    out.push("", "## Examples");
    spec.examples.forEach((ex, i) => out.push(`### Example-${i + 1}`, `- Input: ${ex.input}`, `- Output: ${ex.output}`));
  }
  if (spec.commands?.items.length) {
    out.push("", "## Commands", `- Prefix: "${spec.commands.prefix}"`, "- Commands:");
    for (const c of spec.commands.items) out.push(`    - ${c.name}: ${c.description}`);
  }
  if (spec.reminder?.length) out.push("", "## Reminder", numbered(spec.reminder));
  out.push("", "## Initialization", spec.initialization.trim(), "");
  return out.join("\n");
}

// Heading aliases (English LangGPT + common Chinese variants). Trailing ":" / "：" allowed.
const H = (names: string) => new RegExp(`^#{2,3}\\s*(?:${names})(?=\\s*$|\\s*[:：(（\\-—])`, "im");
const REQUIRED: Array<{ name: string; re: RegExp }> = [
  { name: "Role", re: /^#{1,2}\s*(?:Role|角色)\s*[:：]\s*\S+/im },
  { name: "Profile", re: H("Profile|简介|档案") },
  { name: "Goal", re: H("Goals?|目标") },
  { name: "Rules", re: H("Rules?|Constraints?|约束|规则|限制") },
  { name: "Skills", re: /^(?:#{2,3}\s*(?:Skills?|技能)(?=\s*$|\s*[:：(（\-—])|###\s*(?:Skill|技能)[-\s]?\d)/im },
  { name: "Workflow", re: H("Workflows?|工作流程?|流程") },
  { name: "Initialization", re: H("Initiali[sz]ation|初始化") },
];
const OPTIONAL: Array<{ name: string; re: RegExp }> = [
  { name: "Background", re: H("Background|背景") },
  { name: "OutputFormat", re: H("Output\\s*Format|输出格式") },
  { name: "Examples", re: H("Examples?|示例|例子") },
  { name: "Commands", re: H("Commands?|命令|指令") },
  { name: "Reminder", re: H("Reminders?|提醒") },
];

/** Names a <Reference> may legally point to (sections + Profile fields + common aliases). */
const REF_ALIASES: Record<string, string> = {
  role: "Role", profile: "Profile", goal: "Goal", goals: "Goal", rules: "Rules", rule: "Rules", constraints: "Rules", constraint: "Rules",
  skills: "Skills", skill: "Skills", workflow: "Workflow", workflows: "Workflow", initialization: "Initialization",
  background: "Background", outputformat: "OutputFormat", examples: "Examples", commands: "Commands", reminder: "Reminder",
  language: "Profile", author: "Profile", version: "Profile", description: "Profile",
};

export interface LangGPTCheck {
  valid: boolean;
  score: number; // 0..1 share of required sections present & non-empty
  present: string[];
  missing: string[];
  emptySections: string[];
  optionalPresent: string[];
  danglingRefs: string[]; // <Reference>s pointing to sections that don't exist
  style: LangGPTStyle | "unknown";
}

export function validateLangGPT(markdown: string): LangGPTCheck {
  const present: string[] = [];
  const missing: string[] = [];
  const emptySections: string[] = [];
  for (const { name, re } of REQUIRED) {
    const m = re.exec(markdown);
    if (!m) {
      missing.push(name);
      continue;
    }
    present.push(name);
    if (name === "Role") continue;
    const fromHeading = markdown.slice(m.index);
    const nl = fromHeading.indexOf("\n");
    const after = nl >= 0 ? fromHeading.slice(nl + 1) : "";
    const next = after.search(/^#{1,2}\s/m);
    const body = (next >= 0 ? after.slice(0, next) : after).trim();
    if (!body) emptySections.push(name);
  }
  const optionalPresent = OPTIONAL.filter((o) => o.re.test(markdown)).map((o) => o.name);
  const sections = new Set([...present, ...optionalPresent]);

  const danglingRefs = [
    ...new Set(
      [...markdown.matchAll(/<([A-Z][A-Za-z]{2,24})>/g)]
        .map((m) => m[1])
        .filter((ref) => {
          const target = REF_ALIASES[ref.toLowerCase()];
          return target ? !sections.has(target) : false; // unknown words (e.g. <Name>) are not LangGPT refs
        }),
    ),
  ];

  const style: LangGPTCheck["style"] = /^###\s*Skill[-\s]?\d/im.test(markdown) || /Done Criteria|Non-Goals/i.test(markdown)
    ? "v2"
    : /^##\s*(Goals|Constraints)\s*[:：]?\s*$/im.test(markdown)
      ? "classic"
      : "unknown";
  const good = present.length - emptySections.length;
  return {
    valid: missing.length === 0 && emptySections.length === 0,
    score: Math.round((good / REQUIRED.length) * 100) / 100,
    present,
    missing,
    emptySections,
    optionalPresent,
    danglingRefs,
    style,
  };
}

export function formatCheck(c: LangGPTCheck): string {
  const refs = c.danglingRefs.length ? `; dangling refs: ${c.danglingRefs.map((r) => `<${r}>`).join(", ")}` : "";
  if (c.valid) return `✅ LangGPT structure valid (${c.style}, score ${c.score}; optional: ${c.optionalPresent.join(", ") || "none"}${refs})`;
  const parts = [];
  if (c.missing.length) parts.push(`missing: ${c.missing.join(", ")}`);
  if (c.emptySections.length) parts.push(`empty: ${c.emptySections.join(", ")}`);
  return `⚠️ LangGPT structure incomplete (score ${c.score}; ${parts.join("; ")}${refs})`;
}

/** Deterministically append a few-shot Examples section (used by the auto-optimizer's bootstrap strategy). */
export function withExamples(prompt: string, examples: Array<{ input: string; output: string }>, heading = "## Examples"): string {
  const block = [heading, ...examples.map((ex, i) => `### Example-${i + 1}\n- Input: ${ex.input}\n- Output:\n${ex.output.trim()}`)].join("\n");
  const existing = /^##\s*(?:Examples?|示例|例子)\s*[:：]?\s*$/im.exec(prompt);
  if (existing) {
    const after = prompt.slice(existing.index + existing[0].length);
    const next = after.search(/^#{1,2}\s/m);
    const tail = next >= 0 ? after.slice(next) : "";
    return `${prompt.slice(0, existing.index)}${block}\n\n${tail}`.trimEnd() + "\n";
  }
  const init = /^##\s*(?:Initiali[sz]ation|初始化)\s*[:：]?\s*$/im.exec(prompt);
  if (init) return `${prompt.slice(0, init.index)}${block}\n\n${prompt.slice(init.index)}`;
  return `${prompt.trimEnd()}\n\n${block}\n`;
}
