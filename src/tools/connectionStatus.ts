import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool, type AppContext } from "../context.js";
import { errMsg } from "../utils/errors.js";

export function registerConnectionStatus(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "optimizer_connection_status",
    {
      title: "Diagnose optimizer connection",
      description:
        "Diagnose the setup: which auth scheme the prompt-optimizer deployment uses and whether login succeeds, whether its /mcp backend is reachable, which upstream templates exist, and whether the local/eval LLMs are configured. Call this first when optimize_prompt_via_api fails.",
      inputSchema: {},
    },
    async () =>
      safeTool("optimizer_connection_status", async () => {
        const o = ctx.config.optimizer;
        const lines = ["# Ultimate Prompt Optimizer — status", "", `- PO_BASE_URL: ${o.baseUrl ?? "(not set)"}`, `- MCP URL: ${o.mcpUrl ?? "(not set)"}`];
        const status: Record<string, unknown> = { baseUrl: o.baseUrl, mcpUrl: o.mcpUrl };

        if (o.baseUrl && o.backend !== "local") {
          try {
            const a = await ctx.auth.ensure(true);
            lines.push(`- Auth: ✅ ${a.mode} — ${a.detail}`);
            status.auth = { ok: true, mode: a.mode, detail: a.detail };
          } catch (e) {
            lines.push(`- Auth: ❌ ${errMsg(e)}`);
            status.auth = { ok: false, error: errMsg(e) };
          }
          if ((status.auth as { ok: boolean }).ok) {
            try {
              await ctx.remote.reset();
              const av = await ctx.remote.checkAvailability(true);
              lines.push(`- Upstream MCP: ${av.ok ? "✅" : "❌"} ${av.reason}`);
              status.upstream = av;
              if (av.ok) {
                const templates = await ctx.remote.listTemplates();
                for (const [tool, ids] of Object.entries(templates)) lines.push(`  - ${tool} templates: ${ids.join(", ")}`);
                status.templates = templates;
              }
            } catch (e) {
              lines.push(`- Upstream MCP: ❌ ${errMsg(e)}`);
              status.upstream = { ok: false, reason: errMsg(e) };
            }
          }
        }
        lines.push(`- Local LLM: ${ctx.llm.available ? `✅ ${ctx.llm.model} @ ${ctx.config.llm.baseUrl}` : "❌ not configured (LLM_API_KEY)"}`);
        lines.push(`- Eval LLM: ${ctx.evalLlm.available ? `✅ ${ctx.evalLlm.model} (judge: ${ctx.config.judgeModel})` : "❌ not configured — evaluate_prompt_preview will run in mock mode"}`);
        lines.push(`- Backend preference: ${o.backend}${!o.baseUrl ? " (no PO_BASE_URL → local template library)" : ""}`);
        const templates = await ctx.templates.list();
        lines.push(`- Templates: ${templates.filter((t) => t.builtin).length} built-in, ${templates.filter((t) => !t.builtin).length} custom (${ctx.config.templatesDir})`);
        lines.push(`- Data folder (history, reports, cache): ${ctx.config.dataDir} · cache ${ctx.config.cacheEnabled ? "on" : "off"}`);
        lines.push(`- Call cap per tool run: ${ctx.config.maxCalls} · concurrency ${ctx.config.concurrency}`);
        lines.push(`- Pricing for cost estimates: ${ctx.config.prices ? `$${ctx.config.prices.inputPerM}/M in, $${ctx.config.prices.outputPerM}/M out` : "not set (tokens only)"}`);
        status.llm = { available: ctx.llm.available, model: ctx.llm.model };
        status.evalLlm = { available: ctx.evalLlm.available, model: ctx.evalLlm.model, judgeModel: ctx.config.judgeModel };
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: status };
      }),
  );
}
