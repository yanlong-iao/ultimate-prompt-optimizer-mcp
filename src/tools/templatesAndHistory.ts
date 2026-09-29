import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeTool, type AppContext } from "../context.js";
import { truncate } from "../utils/text.js";

export function registerTemplatesAndHistory(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "list_templates",
    {
      title: "List optimization templates",
      description: "List built-in and custom optimization templates (ids usable as `template` / `iterateTemplate`). Custom templates are Markdown files with frontmatter in the custom-templates folder and override built-ins with the same id. 0 API calls.",
      inputSchema: { type: z.enum(["optimize-system", "optimize-user", "iterate"]).optional(), showContent: z.boolean().default(false) },
    },
    async (args) =>
      safeTool("list_templates", async () => {
        const list = await ctx.templates.list(args.type);
        const L = ["| id | type | name | source | description |", "|---|---|---|---|---|"];
        for (const t of list) L.push(`| \`${t.id}\` | ${t.type} | ${t.name} | ${t.builtin ? "built-in" : "custom"} | ${t.description} |`);
        L.push(
          "",
          `Custom template folder: \`${ctx.config.templatesDir}\``,
          "Add a file like `my-style.md`:",
          "```markdown\n---\nid: my-style\ntype: optimize-system\nname: My house style\ndescription: What it is for\n---\n# Role: Prompt Engineer\n...your instructions. The draft arrives as JSON evidence (originalPrompt).\nOutput only the optimized prompt.\n```",
        );
        if (args.showContent) for (const t of list) L.push("", `### ${t.id}`, ...t.messages.map((m) => `**${m.role}:**\n\n${truncate(m.content, 4000)}`));
        return { content: [{ type: "text", text: L.join("\n") }], structuredContent: { templates: list.map(({ messages, ...t }) => t) } };
      }),
  );

  server.registerTool(
    "prompt_history",
    {
      title: "Prompt version history",
      description: "Browse saved results of generate/optimize/analyze/auto-optimize runs (every version is stored locally). action=list shows recent runs; action=get returns the full record with all versions. 0 API calls.",
      inputSchema: { action: z.enum(["list", "get"]).default("list"), id: z.string().optional(), limit: z.number().int().min(1).max(100).default(15) },
    },
    async (args) =>
      safeTool("prompt_history", async () => {
        if (args.action === "get") {
          if (!args.id) throw new Error("id is required for action=get");
          const rec = await ctx.history.get(args.id);
          if (!rec) throw new Error(`No history record ${args.id}`);
          const L = [`# ${rec.tool} · ${rec.createdAt}`, "", "## Input", "", rec.input, "", "## Final", "", rec.final];
          for (const v of rec.versions ?? []) L.push("", `### ${v.label}${v.score !== undefined ? ` · score ${v.score.toFixed(2)}` : ""}`, "", "<details><summary>show</summary>", "", v.prompt, "", "</details>");
          return { content: [{ type: "text", text: L.join("\n") }], structuredContent: rec as unknown as Record<string, unknown> };
        }
        const list = await ctx.history.list(args.limit);
        if (!list.length) return { content: [{ type: "text", text: "No history yet." }] };
        const L = ["| id | tool | title | final chars |", "|---|---|---|---|"];
        for (const r of list) L.push(`| \`${r.id}\` | ${r.tool} | ${r.title.replace(/\|/g, "/").replace(/\n/g, " ")} | ${r.final.length} |`);
        return { content: [{ type: "text", text: L.join("\n") }], structuredContent: { items: list.map((r) => ({ id: r.id, tool: r.tool, title: r.title, createdAt: r.createdAt })) } };
      }),
  );
}
