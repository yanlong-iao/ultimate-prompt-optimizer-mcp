/** Expand a brief idea into a LangGPT spec — deterministic scaffold, optionally filled by an LLM. */
import { z } from "zod";
import type { LlmClient } from "../clients/llmClient.js";
import { errMsg } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { detectLanguage, extractJson, truncate } from "../utils/text.js";
import { LangGPTSpecSchema, renderLangGPT, validateLangGPT, type LangGPTCheck, type LangGPTSpec, type LangGPTStyle } from "./template.js";

export interface GenerateInput {
  idea: string;
  role?: string;
  language?: "zh" | "en" | "auto";
  audience?: string;
  outputFormat?: string;
  skills?: string[];
  constraints?: string[];
  author?: string;
  strategy?: "auto" | "llm" | "template";
  style?: LangGPTStyle;
  includeCommands?: boolean;
  includeReminder?: boolean;
  /** "weak" produces a flatter, shorter prompt for small/cheap models (LangGPT guidance). */
  targetModel?: "strong" | "weak";
}

export interface GenerateResult {
  markdown: string;
  spec: LangGPTSpec;
  check: LangGPTCheck;
  strategy: "llm" | "template";
  notes: string[];
}

export function buildScaffold(input: GenerateInput): LangGPTSpec {
  const lang = input.language && input.language !== "auto" ? input.language : detectLanguage(input.idea);
  const idea = input.idea.trim().replace(/\s+/g, " ");
  const short = truncate(idea, 48).replace(/….*$/, "…");
  const extra = input.constraints ?? [];

  if (lang === "zh") {
    return {
      role: input.role ?? `${short} 专家助手`,
      profile: { author: input.author ?? "LangGPT", version: "1.0", language: "中文", description: `专注于「${idea}」的专家助手` },
      background: `用户需要在以下任务上获得可靠、高质量的帮助：${idea}。${input.audience ? `目标受众：${input.audience}。` : ""}`,
      goal: {
        outcome: `针对「${idea}」产出准确、可执行、可直接使用的结果`,
        doneCriteria: ["覆盖用户明确提出的全部要求", "关键结论有依据，不确定处明确标注", "严格符合 <OutputFormat>"],
        nonGoals: ["处理与该任务无关的请求", "编造用户未提供的事实或数据"],
      },
      goals: [],
      skills: input.skills?.length
        ? input.skills
        : [
            { name: "领域专长", items: [`掌握与「${idea}」相关的专业知识`, "能指出常见误区与风险"] },
            { name: "需求澄清", items: ["识别缺失或模糊的信息", "用不超过 3 个问题高效澄清"] },
            { name: "结构化表达", items: ["先结论后理由", "针对受众调整措辞与深度"] },
          ],
      constraints: [...extra, "绝不编造事实、数据、来源或经历；不确定时明确说明", "关键信息缺失时先提出简洁的澄清问题，而不是猜测", "只处理与任务相关的内容，礼貌拒绝无关请求", "严格遵循 <OutputFormat>", "始终使用 <Language> 与用户交流"],
      workflow: ["阅读用户输入，用一句话复述目标", "识别缺失或模糊的信息，必要时提出不超过 3 个澄清问题", "逐步规划并完成交付物", "按照 <OutputFormat> 输出", "对照 <Goal> 与 <Rules> 自检后再回复"],
      outputFormat: input.outputFormat ?? "使用 Markdown，标题清晰；先给出直接答案/交付物，再给出简要理由与下一步建议。",
      commands: input.includeCommands ? { prefix: "/", items: [{ name: "help", description: "列出可用命令" }, { name: "continue", description: "继续上一次被截断的输出" }, { name: "improve", description: "对上一条回复进行更深入的改进" }] } : undefined,
      reminder: input.includeReminder ? ["每次回复前检查 <Role> 设定与 <Rules>", "当前语言：<Language>"] : undefined,
      initialization: "作为 <Role>，你必须遵守 <Rules>，默认使用 <Language> 与用户交流，并按照 <Workflow> 执行。先简要问候并说明你能做什么，然后询问开始任务所需的信息。",
    };
  }

  return {
    role: input.role ?? `Expert Assistant — ${short}`,
    profile: { author: input.author ?? "LangGPT", version: "1.0", language: "English", description: `An expert assistant dedicated to: ${idea}` },
    background: `The user needs reliable, high-quality help with: ${idea}.${input.audience ? ` Target audience: ${input.audience}.` : ""}`,
    goal: {
      outcome: `Accurate, actionable, ready-to-use results for: ${idea}`,
      doneCriteria: ["Covers every requirement the user stated", "Key claims are justified and uncertainty is flagged", "Strictly follows <OutputFormat>"],
      nonGoals: ["Handling requests unrelated to this task", "Inventing facts or data the user did not provide"],
    },
    goals: [],
    skills: input.skills?.length
      ? input.skills
      : [
          { name: "Domain expertise", items: [`Deep knowledge relevant to: ${idea}`, "Spots common pitfalls and risks"] },
          { name: "Requirement clarification", items: ["Detects missing or ambiguous information", "Asks at most 3 focused questions"] },
          { name: "Structured communication", items: ["Conclusion first, then rationale", "Adapts depth and tone to the audience"] },
        ],
    constraints: [...extra, "Never fabricate facts, data, sources, or experience; state uncertainty explicitly", "Ask concise clarifying questions when key information is missing instead of guessing", "Stay within the scope of the task; politely decline unrelated requests", "Follow <OutputFormat> strictly", "Always talk to the user in <Language>"],
    workflow: ["Read the user's input and restate the objective in one sentence", "Identify missing or ambiguous information; ask up to 3 clarifying questions if needed", "Plan and produce the deliverable step by step", "Format the reply according to <OutputFormat>", "Self-check against <Goal> and <Rules> before replying"],
    outputFormat: input.outputFormat ?? "Markdown with clear headings; lead with the direct answer/deliverable, then brief rationale and next steps.",
    commands: input.includeCommands ? { prefix: "/", items: [{ name: "help", description: "List available commands" }, { name: "continue", description: "Resume truncated output" }, { name: "improve", description: "Deepen and improve the previous reply" }] } : undefined,
    reminder: input.includeReminder ? ["Before every reply, re-check <Role> and <Rules>", "Current language: <Language>"] : undefined,
    initialization: "As <Role>, you must follow <Rules>, talk to the user in default <Language>, and execute <Workflow>. Briefly greet the user, say what you can do, then ask for the information you need to start.",
  };
}

const EXPAND_SYSTEM = (weak: boolean) => `You are a LangGPT prompt architect. Turn the user's brief idea into a complete, domain-specific LangGPT role spec.
Return ONLY a JSON object with these keys:
{
  "role": string,                                   // concise, specific expert title
  "profile": {"author": string, "version": string, "language": string, "description": string},
  "background": string,
  "goal": {"outcome": string, "doneCriteria": string[], "nonGoals": string[]},   // doneCriteria must be checkable
  "skills": [{"name": string, "items": string[]}],  // ${weak ? "2-3" : "3-5"} skills, 2-3 concrete items each
  "constraints": string[],                          // ${weak ? "4-6" : "5-9"} specific, verifiable rules (these render as ## Rules)
  "workflow": string[],                             // ${weak ? "3-5" : "4-7"} ordered actions incl. clarification and a final self-check
  "outputFormat": string,                           // exact reply structure
  "examples": [{"input": string, "output": string}],// 0-2 short illustrative examples, [] if not clearly helpful
  "initialization": string                          // "As <Role>, you must follow <Rules>, communicate in <Language>, execute <Workflow>..." + opening behaviour
}
Rules: be specific to the idea's domain; never invent facts about the user or their data; only reference sections that exist (<Role>, <Rules>, <Goal>, <Skills>, <Workflow>, <OutputFormat>, <Language>); write all values in the requested language${weak ? "; keep sentences short and simple for a small model" : ""}.`;

export async function generateLangGPT(input: GenerateInput, llm: LlmClient): Promise<GenerateResult> {
  const style = input.style ?? "v2";
  const scaffold = buildScaffold(input);
  const notes: string[] = [];
  const strategy = input.strategy ?? "auto";
  const wantLlm = strategy === "llm" || (strategy === "auto" && llm.available);

  if (strategy === "llm" && !llm.available) throw new Error("strategy=llm requested but no LLM is configured (set LLM_API_KEY)");
  if (!wantLlm) {
    if (strategy === "auto") notes.push("No LLM configured — returned the deterministic LangGPT scaffold. Set LLM_API_KEY for a domain-specific expansion.");
    return finish(scaffold, style, "template", notes);
  }

  const userMsg = [
    `Idea: ${input.idea}`,
    `Language: ${scaffold.profile.language}`,
    input.role && `Role name to use: ${input.role}`,
    input.audience && `Audience: ${input.audience}`,
    input.outputFormat && `Required output format: ${input.outputFormat}`,
    input.skills?.length && `Must include skills: ${input.skills.join("; ")}`,
    input.constraints?.length && `Must include rules: ${input.constraints.join("; ")}`,
    `Author: ${scaffold.profile.author}`,
  ]
    .filter(Boolean)
    .join("\n");

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text } = await llm.chat(
        [
          { role: "system", content: EXPAND_SYSTEM(input.targetModel === "weak") },
          { role: "user", content: attempt === 1 ? userMsg : `${userMsg}\n\nYour previous JSON was invalid: ${lastError}. Return valid JSON only.` },
        ],
        { json: true, temperature: 0.5, purpose: "langgpt-expand" },
      );
      const raw = extractJson<Record<string, unknown>>(text);
      const merged = {
        ...scaffold,
        ...stripEmpty(raw),
        profile: { ...scaffold.profile, ...stripEmpty((raw.profile as object) ?? {}) },
        commands: scaffold.commands,
        reminder: scaffold.reminder,
      };
      const spec = LangGPTSpecSchema.parse(merged);
      if (input.role) spec.role = input.role;
      for (const c of [...(input.constraints ?? [])].reverse()) if (!spec.constraints.includes(c)) spec.constraints.unshift(c);
      return finish(spec, style, "llm", notes);
    } catch (e) {
      lastError = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : errMsg(e);
      log.warn(`LangGPT LLM expansion attempt ${attempt} failed: ${lastError}`);
      if ((e as Error).name === "BudgetExceededError" || (e as Error).name === "LlmError") break;
    }
  }
  notes.push(`LLM expansion failed (${truncate(lastError, 160)}) — returned the deterministic scaffold instead.`);
  return finish(scaffold, style, "template", notes);
}

function stripEmpty(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
}

function finish(spec: LangGPTSpec, style: LangGPTStyle, strategy: "llm" | "template", notes: string[]): GenerateResult {
  const markdown = renderLangGPT(spec, style);
  return { markdown, spec, check: validateLangGPT(markdown), strategy, notes };
}
