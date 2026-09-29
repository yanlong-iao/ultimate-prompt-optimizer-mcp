import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeTool, startRun, type AppContext } from "../context.js";
import { generateLangGPT } from "../langgpt/generator.js";
import { formatCheck } from "../langgpt/template.js";

export function registerGenerateLanggpt(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "generate_langgpt_structure",
    {
      title: "Generate LangGPT prompt",
      description:
        "Expand a brief idea into a strict LangGPT Markdown system prompt. Default style 'v2' follows the current LangGPT spec (Role, Profile, Background, Goal with Outcome/Done Criteria/Non-Goals, Skill-N subsections, Rules, Workflow, OutputFormat, optional Commands/Reminder/Examples, Initialization); 'classic' uses Goals/Constraints/Skills lists. " +
        "With an LLM configured the content is domain-specific (the model fills a validated JSON spec; Markdown is rendered deterministically, so structure is guaranteed). Checks that every <Reference> points to an existing section. 1 API call (0 with strategy=template).",
      inputSchema: {
        idea: z.string().min(3).describe("Brief description of the assistant/prompt you want"),
        role: z.string().optional().describe("Explicit role name; inferred if omitted"),
        language: z.enum(["auto", "zh", "en"]).default("auto"),
        audience: z.string().optional(),
        outputFormat: z.string().optional().describe("Required response format"),
        skills: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional().describe("Rules that must appear verbatim"),
        author: z.string().optional(),
        style: z.enum(["v2", "classic"]).default("v2"),
        includeCommands: z.boolean().default(false).describe("Add a LangGPT ## Commands section (/help, /continue, /improve)"),
        includeReminder: z.boolean().default(false).describe("Add a ## Reminder section for long conversations"),
        targetModel: z.enum(["strong", "weak"]).default("strong").describe("weak = shorter, flatter prompt for small models"),
        strategy: z.enum(["auto", "llm", "template"]).default("auto").describe("auto = LLM if configured, else deterministic template"),
      },
    },
    async (args, extra) =>
      safeTool("generate_langgpt_structure", async () => {
        const s = startRun(ctx, { extra });
        const r = await generateLangGPT(args, s.llm);
        const saved = await ctx.history.save({ tool: "generate", title: args.idea.slice(0, 60), input: args.idea, final: r.markdown, meta: { strategy: r.strategy, style: args.style } });
        const header = [`<!-- strategy: ${r.strategy} · ${formatCheck(r.check)} · ${s.usage()} · history: ${saved.id} -->`, ...r.notes.map((n) => `<!-- ${n} -->`)].join("\n");
        return {
          content: [{ type: "text", text: `${header}\n\n${r.markdown}` }],
          structuredContent: { strategy: r.strategy, check: r.check, spec: r.spec, notes: r.notes, historyId: saved.id, usage: s.run.meter.toJSON() },
        };
      }),
  );
}
