import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isZh, safeTool, startRun, type AppContext } from "../context.js";
import { formatMenu, suggestPrompts } from "../prompts/suggest.js";

export function registerSuggestPrompts(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "suggest_prompts",
    {
      title: "Suggest prompt candidates for any topic",
      description:
        "START HERE for any new topic. Given a topic/goal in plain words, returns 2-4 genuinely different ready-to-use prompts (concise / LangGPT structured / interactive coach / strict output format), each with when-to-use, expected effect and a LIVE sample reply produced by the real model on the same first message, so the user can pick by seeing the effect. " +
        "Present the returned menu to the user and let them choose by number; then offer optimize_prompt_via_api / auto_optimize_prompt / evaluate_prompt_preview on the chosen one. Cost ≈ 1 design call + 1 LangGPT call + 1 preview call per candidate (≈ 6 calls for 4 candidates); previews can be turned off.",
      inputSchema: {
        topic: z.string().min(2).describe("What the user wants to do or the assistant they want, in their own words"),
        context: z.string().optional().describe("Extra facts: audience, tools, constraints, examples of what good looks like"),
        count: z.number().int().min(2).max(4).default(3).describe("How many candidates (order: concise, langgpt, coach, strict)"),
        language: z.enum(["auto", "zh", "en"]).default("auto"),
        sampleInput: z.string().optional().describe("The first user message used for the live preview; generated if omitted"),
        preview: z.boolean().default(true).describe("Run every candidate on the sample message (1 call each)"),
        previewChars: z.number().int().min(100).max(2000).default(500),
        strategy: z.enum(["auto", "llm", "template"]).default("auto"),
      },
    },
    async (args, extra) =>
      safeTool("suggest_prompts", async () => {
        const s = startRun(ctx, { extra });
        const r = await suggestPrompts(args, s.llm, s.evalLlm);
        const saved = await ctx.history.save({
          tool: "suggest",
          title: args.topic.slice(0, 60),
          input: args.topic,
          final: "",
          meta: { strategy: r.strategy, sampleInput: r.sampleInput },
          versions: r.candidates.map((c) => ({ label: `${c.id}. ${c.name}`, prompt: c.prompt })),
        });
        const text = formatMenu(r, isZh(args.topic) || args.language === "zh", s.usage(), saved.id);
        return { content: [{ type: "text", text }], structuredContent: { strategy: r.strategy, sampleInput: r.sampleInput, candidates: r.candidates, historyId: saved.id, usage: s.run.meter.toJSON() } };
      }),
  );
}
