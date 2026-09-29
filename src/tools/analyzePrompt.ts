import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isZh, safeTool, startRun, type AppContext } from "../context.js";
import { analyzePrompt, applyPatches, formatAnalysis, rewriteFromAnalysis } from "../analysis/analyzer.js";
import { reviewPrompt } from "../eval/staticReview.js";
import { formatCheck } from "../langgpt/template.js";
import { missingPlaceholders } from "../templates/registry.js";

export function registerAnalyzePrompt(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "analyze_prompt",
    {
      title: "Analyze prompt design",
      description:
        "Design review of a prompt WITHOUT running it: 0-100 scores on goal clarity, instruction completeness, structural executability, ambiguity control and robustness, plus strengths, issues, improvements and an exact patch plan (oldText → newText). " +
        "Optionally apply the patches locally (no extra call) and/or rewrite the prompt from the analysis (+1 call). Also reports LangGPT structure and static lint. Cost: 1 API call (cached if unchanged).",
      inputSchema: {
        prompt: z.string().min(1),
        focus: z.string().optional().describe("A specific concern to prioritize, e.g. 'the model keeps giving long derivations'"),
        applyPatches: z.boolean().default(false).describe("Apply exact, unique patches and return the patched prompt"),
        rewrite: z.boolean().default(false).describe("Also produce a full revised prompt from the analysis (+1 API call)"),
      },
    },
    async (args, extra) =>
      safeTool("analyze_prompt", async () => {
        const s = startRun(ctx, { extra });
        const zh = isZh(args.prompt);
        const analysis = await analyzePrompt(s.llm, args.prompt, args.focus);
        const review = reviewPrompt(args.prompt);
        const L = [`# ${zh ? "提示词设计分析" : "Prompt design analysis"}`, "", formatAnalysis(analysis, zh), "", formatCheck(review.langgpt)];
        if (review.suggestions.length) L.push(`${zh ? "静态检查" : "Static lint"}: ${review.suggestions.join(" · ")}`);

        let patched: string | undefined;
        if (analysis.patchPlan.length) {
          L.push("", `## ${zh ? "补丁计划" : "Patch plan"}`);
          const applied = args.applyPatches ? applyPatches(args.prompt, analysis.patchPlan) : undefined;
          analysis.patchPlan.forEach((p, i) => {
            const st = applied?.results[i];
            L.push(`${i + 1}. ${p.instruction}${st ? (st.applied ? " ✅ applied" : ` ⏭️ skipped (${st.reason})`) : ""}`, `   - old: \`${p.oldText.replace(/`/g, "'").slice(0, 160)}\``, `   - new: \`${p.newText.replace(/`/g, "'").slice(0, 240)}\``);
          });
          if (applied && applied.results.some((r) => r.applied)) {
            patched = applied.prompt;
            L.push("", `## ${zh ? "打补丁后的提示词" : "Patched prompt"}`, "", patched);
          }
        }
        let rewritten: string | undefined;
        if (args.rewrite) {
          rewritten = await rewriteFromAnalysis(s.llm, patched ?? args.prompt, analysis, args.focus);
          const lost = missingPlaceholders(args.prompt, rewritten);
          L.push("", `## ${zh ? "根据分析重写的提示词" : "Rewritten prompt"}`);
          if (lost.length) L.push(`> ⚠️ lost placeholders: ${lost.join(", ")}`);
          L.push("", rewritten);
        }
        let historyId: string | undefined;
        if (patched || rewritten) {
          const saved = await ctx.history.save({ tool: "analyze", title: args.prompt.slice(0, 60), input: args.prompt, final: rewritten ?? patched!, meta: { score: analysis.score.overall, focus: args.focus } });
          historyId = saved.id;
        }
        L.push("", "---", `**Usage:** ${s.usage()}${historyId ? ` · **History id:** ${historyId}` : ""}`);
        return { content: [{ type: "text", text: L.join("\n") }], structuredContent: { analysis, patched, rewritten, langgpt: review.langgpt, historyId, usage: s.run.meter.toJSON() } };
      }),
  );
}
