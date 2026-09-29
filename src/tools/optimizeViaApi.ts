import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeTool, startRun, type AppContext } from "../context.js";
import { formatOptimizeReport, runOptimization } from "../optimize/pipeline.js";

export function registerOptimizeViaApi(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "optimize_prompt_via_api",
    {
      title: "Optimize prompt (iterative)",
      description:
        "Iteratively rewrite a prompt with the built-in template library (see list_templates): round 1 optimizes with a strategy template (default: langgpt-strict for system prompts, user-basic for user prompts); rounds 2..N apply your requirements with the iterate template, which sees both the original draft and the latest version. " +
        "Every round is checked for LangGPT structure, dangling <References> and lost {{placeholders}}, which are repaired automatically. Cost: 1 API call per round (+1 repair if needed). " +
        "Uses a prompt-optimizer Docker deployment instead only if PO_BASE_URL is configured and PO_BACKEND allows it. For score-driven optimization with test cases, use auto_optimize_prompt.",
      inputSchema: {
        prompt: z.string().min(1).describe("Draft prompt to optimize"),
        mode: z.enum(["system", "user"]).default("system").describe("system = role/system prompt; user = a single one-off request"),
        rounds: z.number().int().min(1).max(5).default(2).describe("1 = optimize only; each extra round is an iterate pass"),
        requirements: z.string().optional().describe("What the iterate rounds should change, e.g. 'reply as a Markdown table; max 200 words'"),
        template: z.string().optional().describe("Optimize template id: langgpt-strict | general | output-format | analytical | user-basic | user-professional | user-planning | custom id"),
        iterateTemplate: z.string().optional().describe("Iterate template id (default iterate)"),
        enforceLangGPT: z.boolean().optional().describe("Validate & repair LangGPT structure (default: true for system mode)"),
        autoRepair: z.boolean().default(true),
        backend: z.enum(["auto", "remote", "local"]).optional().describe("Override PO_BACKEND for this call"),
        showHistory: z.boolean().default(true),
      },
    },
    async (args, extra) =>
      safeTool("optimize_prompt_via_api", async () => {
        const s = startRun(ctx, { extra });
        const result = await runOptimization(
          {
            prompt: args.prompt,
            mode: args.mode,
            rounds: args.rounds,
            requirements: args.requirements,
            template: args.template,
            iterateTemplate: args.iterateTemplate,
            enforceLangGPT: args.enforceLangGPT ?? (args.mode === "system" && (!args.template || ["langgpt-strict", "analytical", "output-format"].includes(args.template))),
            autoRepair: args.autoRepair,
            backend: args.backend ?? ctx.config.optimizer.backend,
          },
          { remote: ctx.remote, auth: ctx.auth, llm: s.llm, templates: ctx.templates },
        );
        const saved = await ctx.history.save({
          tool: "optimize",
          title: args.prompt.slice(0, 60),
          input: args.prompt,
          final: result.final,
          meta: { backend: result.backend, requirements: args.requirements, usage: s.run.meter.toJSON() },
          versions: [{ label: "original", prompt: args.prompt }, ...result.rounds.map((r) => ({ label: `round ${r.round} (${r.action}, ${r.template})`, prompt: r.output }))],
        });
        return {
          content: [{ type: "text", text: formatOptimizeReport(result, args.showHistory, [`**Usage:** ${s.usage()}`, `**History id:** ${saved.id}`]) }],
          structuredContent: {
            final: result.final,
            backend: result.backend,
            authMode: result.authMode,
            notes: result.notes,
            historyId: saved.id,
            usage: s.run.meter.toJSON(),
            rounds: result.rounds.map(({ output, ...rest }) => ({ ...rest, outputChars: output.length })),
          },
        };
      }),
  );
}
