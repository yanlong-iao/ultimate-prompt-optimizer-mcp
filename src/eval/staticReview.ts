/** LLM-free prompt lint (mock mode, and shown alongside live runs). */
import { validateLangGPT, type LangGPTCheck } from "../langgpt/template.js";
import { placeholdersOf } from "../templates/registry.js";
import { approxTokens } from "../utils/text.js";

export interface StaticReview {
  score: number; // 0..100 heuristic
  approxTokens: number;
  langgpt: LangGPTCheck;
  placeholders: string[];
  vagueTerms: string[];
  hasOutputFormat: boolean;
  hasExamples: boolean;
  ruleCount: number;
  suggestions: string[];
}

const VAGUE = [
  /\betc\.?/gi, /\bsome\b/gi, /\bmaybe\b/gi, /\bas needed\b/gi, /\bappropriate(ly)?\b/gi, /\btry to\b/gi, /\bif possible\b/gi,
  /尽量/g, /等等/g, /适当/g, /一些/g, /可能/g, /比较好/g, /相关的/g,
];

export function reviewPrompt(prompt: string): StaticReview {
  const langgpt = validateLangGPT(prompt);
  const vagueTerms = [...new Set(VAGUE.flatMap((re) => prompt.match(re) ?? []).map((s) => s.toLowerCase()))];
  const hasOutputFormat = /output\s*format|输出格式|respond (in|with)|format:/i.test(prompt);
  const hasExamples = /^#+\s*(examples?|示例)|example[-\s]?\d|input:|输入[:：]/im.test(prompt);
  const rulesBlock = prompt.match(/^#{2,3}\s*(?:Rules?|Constraints?|约束|规则|限制)[^\n]*\n([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/im)?.[1] ?? "";
  const ruleCount = (rulesBlock.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) ?? []).length;
  const tokens = approxTokens(prompt);

  const suggestions: string[] = [];
  if (!langgpt.valid) suggestions.push(`Add/complete LangGPT sections: ${[...langgpt.missing, ...langgpt.emptySections].join(", ")}`);
  if (langgpt.danglingRefs.length) suggestions.push(`References to missing sections: ${langgpt.danglingRefs.map((r) => `<${r}>`).join(", ")}`);
  if (!hasOutputFormat) suggestions.push("Specify an explicit output format.");
  if (!hasExamples) suggestions.push("Consider 1–2 input/output examples for few-shot anchoring.");
  if (vagueTerms.length) suggestions.push(`Replace vague wording: ${vagueTerms.slice(0, 6).join(", ")}`);
  if (ruleCount < 3) suggestions.push("Add concrete, testable rules (≥3).");
  if (tokens < 40) suggestions.push("Prompt is very short — add context, goal and rules.");
  if (tokens > 3000) suggestions.push("Prompt is long — check for redundancy.");

  let score = 40 * langgpt.score;
  score += hasOutputFormat ? 15 : 0;
  score += hasExamples ? 10 : 0;
  score += Math.min(ruleCount, 6) * 3;
  score += tokens >= 80 && tokens <= 3000 ? 10 : 0;
  score += Math.max(0, 7 - vagueTerms.length * 2);
  score -= langgpt.danglingRefs.length * 3;
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    approxTokens: tokens,
    langgpt,
    placeholders: placeholdersOf(prompt),
    vagueTerms,
    hasOutputFormat,
    hasExamples,
    ruleCount,
    suggestions,
  };
}
