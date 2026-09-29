/** Topic -> a small menu of genuinely different candidate prompts, each with a live sample of its behaviour. */
import { z } from "zod";
import type { LlmClient } from "../clients/llmClient.js";
import { generateLangGPT } from "../langgpt/generator.js";
import { formatCheck, validateLangGPT } from "../langgpt/template.js";
import { errMsg } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { detectLanguage, extractJson, mapPool, truncate } from "../utils/text.js";

export type Archetype = "concise" | "langgpt" | "coach" | "strict";

export const ARCHETYPES: Record<Archetype, { zh: string; en: string; whenZh: string; whenEn: string }> = {
  concise: { zh: "精简直给版", en: "Concise & direct", whenZh: "一次性问答，要快、要短、省钱", whenEn: "One-shot Q&A: fast, short, cheap" },
  langgpt: { zh: "LangGPT 结构化专家版", en: "LangGPT structured expert", whenZh: "长期反复使用的角色/助手，要稳定、可维护", whenEn: "A long-lived role that must stay stable and maintainable" },
  coach: { zh: "互动教练版", en: "Interactive coach", whenZh: "需要一步步引导、追问、根据你的水平调整", whenEn: "Step-by-step guidance, follow-up questions, adapts to your level" },
  strict: { zh: "严格输出格式版", en: "Strict output format", whenZh: "结果要被程序或固定模板使用（表格/JSON/固定栏目）", whenEn: "Output feeds a program or fixed template (table/JSON/sections)" },
};

const ORDER: Archetype[] = ["concise", "langgpt", "coach", "strict"];

export interface Candidate {
  id: number;
  archetype: Archetype;
  name: string;
  whenToUse: string;
  expectedEffect: string;
  prompt: string;
  preview?: string;
  notes?: string[];
}

export interface SuggestInput {
  topic: string;
  context?: string;
  count: number;
  language?: "zh" | "en" | "auto";
  sampleInput?: string;
  preview: boolean;
  previewChars: number;
  strategy: "auto" | "llm" | "template";
}

export interface SuggestResult {
  candidates: Candidate[];
  sampleInput: string;
  strategy: "llm" | "template";
  notes: string[];
}

const DESIGN_SYSTEM = (langName: string, kinds: Archetype[]) => `You are a Prompt Candidate Designer. Given a topic, write DIFFERENT ready-to-use system prompts for it — the candidates must differ in approach, not just wording.
Return ONLY JSON: {"sampleInput": string, "candidates": [{"archetype": string, "expectedEffect": string, "prompt": string}]}
- "sampleInput": one realistic first message a real user would send under this topic (in ${langName}).
- One candidate for each archetype, in this order: ${kinds.join(", ")}.
  concise = under ~120 words: role + task + 3-5 hard rules, no boilerplate.
  coach = interactive: asks at most 2 diagnostic questions first, works step by step, checks understanding, adapts difficulty/depth to the user.
  strict = fixed output structure (exact headings, table columns or JSON keys) plus rules to keep every reply inside it.
  (langgpt is generated elsewhere; skip it if it appears in the list.)
- "expectedEffect": ONE sentence in ${langName} describing how this prompt will behave in practice, incl. one honest trade-off.
- Each prompt is written in ${langName}, addressed to the model ("You are..."/"你是..."), never invents facts about the user, and contains no placeholders unless the topic implies variables.`;

const CandSchema = z.object({ archetype: z.string(), expectedEffect: z.string().default(""), prompt: z.string().min(10) });
const PlanSchema = z.object({ sampleInput: z.string().default(""), candidates: z.array(CandSchema).min(1) });

function fallbackPrompt(kind: Archetype, topic: string, zh: boolean): string {
  if (zh) {
    if (kind === "concise") return `你是「${topic}」方面的专家。直接回答用户的问题，先给结论再给必要理由。\n规则：\n1. 不编造事实或数据，不确定就明说。\n2. 关键信息缺失时只问一个最关键的问题。\n3. 控制在 300 字以内，除非用户要求详细。`;
    if (kind === "coach") return `你是「${topic}」方面的教练。开始前最多问 2 个问题了解用户水平与目标；然后一次只推进一小步，每步结束确认用户是否理解，并根据回答调整深度。不直接替用户完成全部工作，除非用户明确要求。`;
    return `你是「${topic}」方面的助手。每次回复必须严格使用以下结构：\n## 结论\n## 依据\n## 下一步\n不得省略任何栏目，不得添加其他栏目；信息不足时在「结论」中说明缺什么。`;
  }
  if (kind === "concise") return `You are an expert in ${topic}. Answer the user's question directly: conclusion first, then only the necessary reasoning.\nRules:\n1. Never invent facts or data; say so when unsure.\n2. If key information is missing, ask the single most important question.\n3. Stay under 200 words unless asked for detail.`;
  if (kind === "coach") return `You are a coach for ${topic}. Before starting, ask at most 2 questions to learn the user's level and goal; then advance one small step at a time, check understanding after each step, and adapt depth to their answers. Do not do all the work for the user unless they explicitly ask.`;
  return `You are an assistant for ${topic}. Every reply must use exactly this structure:\n## Conclusion\n## Rationale\n## Next step\nDo not omit or add sections; if information is missing, say what is missing under "Conclusion".`;
}

export async function suggestPrompts(input: SuggestInput, llm: LlmClient, previewLlm: LlmClient): Promise<SuggestResult> {
  const lang = input.language && input.language !== "auto" ? input.language : detectLanguage(input.topic);
  const zh = lang === "zh";
  const langName = zh ? "Chinese" : "English";
  const kinds = ORDER.slice(0, Math.max(2, Math.min(4, input.count)));
  const notes: string[] = [];
  const topicFull = input.context ? `${input.topic}\nContext: ${input.context}` : input.topic;
  const wantLlm = input.strategy === "llm" || (input.strategy === "auto" && llm.available);
  if (input.strategy === "llm" && !llm.available) throw new Error("strategy=llm requested but no LLM is configured (set LLM_API_KEY)");

  const bodies = new Map<Archetype, { prompt: string; effect: string; notes?: string[] }>();
  let sampleInput = input.sampleInput ?? "";
  let strategy: "llm" | "template" = "template";

  // 1) non-LangGPT candidates: one LLM call for all of them
  const needLlmKinds = kinds.filter((k) => k !== "langgpt");
  if (wantLlm && needLlmKinds.length) {
    try {
      const { text } = await llm.chat(
        [
          { role: "system", content: DESIGN_SYSTEM(langName, needLlmKinds) },
          { role: "user", content: `Topic: ${topicFull}` },
        ],
        { json: true, temperature: 0.7, purpose: "suggest-design" },
      );
      const plan = PlanSchema.parse(extractJson(text));
      if (!sampleInput) sampleInput = plan.sampleInput;
      needLlmKinds.forEach((k, i) => {
        const c = plan.candidates.find((x) => x.archetype === k) ?? plan.candidates[i];
        if (c) bodies.set(k, { prompt: c.prompt.trim(), effect: c.expectedEffect });
      });
      strategy = "llm";
    } catch (e) {
      log.warn(`suggest design failed: ${errMsg(e)}`);
      notes.push(`LLM design step failed (${truncate(errMsg(e), 140)}) — used built-in templates for those candidates.`);
      if ((e as Error).name === "BudgetExceededError") throw e;
    }
  }
  for (const k of needLlmKinds) if (!bodies.has(k)) bodies.set(k, { prompt: fallbackPrompt(k, input.topic, zh), effect: "" });

  // 2) LangGPT candidate: reuse the validated generator
  if (kinds.includes("langgpt")) {
    const g = await generateLangGPT({ idea: input.context ? `${input.topic}（${input.context}）` : input.topic, language: lang, strategy: wantLlm ? "auto" : "template", style: "v2" }, llm);
    const chk = validateLangGPT(g.markdown);
    bodies.set("langgpt", { prompt: g.markdown, effect: "", notes: [g.strategy === "llm" ? "LLM-expanded, structure validated" : "template scaffold", ...g.notes, formatCheck(chk)] });
  }

  if (!sampleInput) sampleInput = zh ? `我想开始做这件事：${input.topic}，请帮我。` : `I want to get started with this: ${input.topic}. Please help.`;

  const candidates: Candidate[] = kinds.map((k, i) => {
    const a = ARCHETYPES[k];
    const b = bodies.get(k)!;
    return {
      id: i + 1,
      archetype: k,
      name: zh ? a.zh : a.en,
      whenToUse: zh ? a.whenZh : a.whenEn,
      expectedEffect: b.effect || (zh ? "（未生成效果说明，请看下方试运行）" : "(no effect note — see the live sample)"),
      prompt: b.prompt,
      notes: b.notes,
    };
  });

  // 3) live preview: each candidate answers the same first message
  if (input.preview && previewLlm.available) {
    const out = await mapPool(candidates, 4, async (c) => {
      try {
        const { text } = await previewLlm.chat(
          [
            { role: "system", content: c.prompt },
            { role: "user", content: sampleInput },
          ],
          { temperature: 0.3, maxTokens: 700, purpose: "suggest-preview", cache: true },
        );
        return truncate(text.trim(), input.previewChars);
      } catch (e) {
        if ((e as Error).name === "BudgetExceededError") throw e;
        return `(preview failed: ${truncate(errMsg(e), 120)})`;
      }
    });
    out.forEach((p, i) => (candidates[i]!.preview = p));
  } else if (input.preview) {
    notes.push("No LLM configured — live previews skipped.");
  }

  return { candidates, sampleInput, strategy, notes };
}

export function formatMenu(r: SuggestResult, zh: boolean, usage: string, historyId: string): string {
  const lines: string[] = [];
  lines.push(zh ? `## 为你准备了 ${r.candidates.length} 个候选提示词` : `## ${r.candidates.length} candidate prompts`);
  lines.push(zh ? `试运行用的同一条用户消息：「${r.sampleInput}」` : `Same first message used for every preview: "${r.sampleInput}"`);
  lines.push("");
  for (const c of r.candidates) {
    lines.push(`### ${c.id}. ${c.name}`);
    lines.push(`- ${zh ? "适合" : "Best for"}：${c.whenToUse}`);
    lines.push(`- ${zh ? "预期效果" : "Expected effect"}：${c.expectedEffect}`);
    if (c.preview) lines.push(`\n${zh ? "**试运行回复：**" : "**Live sample reply:**"}\n> ${c.preview.replace(/\n/g, "\n> ")}`);
    lines.push(`\n<details><summary>${zh ? "查看完整提示词" : "Full prompt"}</summary>\n\n\`\`\`markdown\n${c.prompt}\n\`\`\`\n</details>\n`);
  }
  lines.push(zh ? `请回复编号选择（如「选 2」），也可以说「把 2 再优化一下」或「把 1 和 3 合并」。` : `Reply with a number to pick one, or ask to refine or merge candidates.`);
  lines.push(`\n<!-- ${usage} · history: ${historyId}${r.notes.length ? " · " + r.notes.join(" | ") : ""} -->`);
  return lines.join("\n");
}
