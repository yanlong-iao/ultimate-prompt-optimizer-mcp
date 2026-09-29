#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { registerConnectionStatus } from "./tools/connectionStatus.js";
import { registerEvaluatePreview } from "./tools/evaluatePreview.js";
import { registerGenerateLanggpt } from "./tools/generateLanggpt.js";
import { registerOptimizeViaApi } from "./tools/optimizeViaApi.js";
import { registerAnalyzePrompt } from "./tools/analyzePrompt.js";
import { registerAutoOptimize } from "./tools/autoOptimize.js";
import { registerSuggestPrompts } from "./tools/suggestPrompts.js";
import { registerTemplatesAndHistory } from "./tools/templatesAndHistory.js";
import { errMsg } from "./utils/errors.js";
import { log, setLogLevel } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const ctx = createContext(config);

  const server = new McpServer(
    { name: "ultimate-prompt-optimizer", version: "0.3.0" },
    {
      instructions:
        "Prompt engineering toolkit (all tools that call the LLM report API calls and cost). For ANY new topic, start with suggest_prompts: it returns several candidate prompts with live sample replies so the user just picks a number. Typical flows: " +
        "idea → generate_langgpt_structure → analyze_prompt → optimize_prompt_via_api → evaluate_prompt_preview (prompt=original, promptB=optimized). " +
        "When quality must be proven on test cases, use auto_optimize_prompt (score-driven search). " +
        "Before expensive runs, tell the user the estimated number of calls. list_templates / prompt_history cost nothing. Use optimizer_connection_status to debug configuration.",
    },
  );

  registerSuggestPrompts(server, ctx);
  registerGenerateLanggpt(server, ctx);
  registerOptimizeViaApi(server, ctx);
  registerAnalyzePrompt(server, ctx);
  registerEvaluatePreview(server, ctx);
  registerAutoOptimize(server, ctx);
  registerTemplatesAndHistory(server, ctx);
  registerConnectionStatus(server, ctx);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    await ctx.remote.reset();
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(new StdioServerTransport());
  log.info(
    `ready · upstream=${config.optimizer.mcpUrl ?? "none"} auth=${config.optimizer.authMode} backend=${config.optimizer.backend} llm=${ctx.llm.available ? config.llm.model : "off"}`,
  );
}

main().catch((e) => {
  process.stderr.write(`ultimate-prompt-optimizer failed to start: ${errMsg(e)}\n`);
  process.exit(1);
});
