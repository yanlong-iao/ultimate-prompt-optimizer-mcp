import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeTool, startRun, type AppContext } from "../context.js";
import { validateAssertions } from "../eval/assertions.js";
import { loadTestsFile } from "../eval/config.js";
import { AssertionInputSchema, TestCaseInputSchema, type Assertion, type TestCase } from "../eval/types.js";
import { autoOptimize, formatAutoReport } from "../optimize/autoOptimizer.js";
import { stamp, writeReport } from "../utils/store.js";

export function registerAutoOptimize(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "auto_optimize_prompt",
    {
      title: "Auto-optimize prompt (score-driven)",
      description:
        "DSPy-style, metric-driven optimization: builds a test set (given or auto-generated with per-case criteria), splits it into train/dev, scores the original prompt, then for several rounds proposes candidates — reflect (analyse failing outputs → targeted edits, GEPA-like), template (rewrite with a different optimization strategy, MIPRO-like), fewshot (insert the best passing outputs as Examples, BootstrapFewShot-like) — evaluates them on train, confirms finalists on dev, and keeps a candidate only if the dev score improves. " +
        "Returns the best prompt, a scoreboard of every candidate, per-case before/after, cost, and a saved report. Budget-guarded: the search is scaled down to fit maxCalls and stops early on no improvement or time limit. Typical light run with 6 cases: ~40-60 API calls.",
      inputSchema: {
        prompt: z.string().min(1).describe("The prompt to optimize"),
        promptMode: z.enum(["system", "user"]).default("system"),
        goal: z.string().optional().describe("What a good response looks like — used for grading and reflection, e.g. 'short interview-style answers, always asks for missing info'"),
        testCases: z.array(TestCaseInputSchema).max(30).optional(),
        testsFile: z.string().optional().describe("YAML/JSON/CSV tests file"),
        numCases: z.number().int().min(2).max(12).default(6).describe("Cases to generate when none are given"),
        assert: z.array(AssertionInputSchema).optional().describe("Assertions applied to every case (e.g. is-json, max-length)"),
        rubric: z.string().optional().describe("llm-rubric applied to every case"),
        budget: z.enum(["light", "medium", "heavy"]).default("light").describe("light: 2 rounds × 2 candidates · medium: 3×3 · heavy: 5×4"),
        rounds: z.number().int().min(1).max(8).optional(),
        candidatesPerRound: z.number().int().min(1).max(6).optional(),
        strategies: z.array(z.enum(["reflect", "template", "fewshot"])).min(1).default(["reflect", "template", "fewshot"]),
        model: z.string().optional().describe("Model the prompt will run on (default EVAL_MODEL)"),
        temperature: z.number().min(0).max(1.5).default(0.2),
        maxCalls: z.number().int().min(10).max(1000).optional().describe("Hard cap on API calls (default UPO_MAX_CALLS)"),
        maxMinutes: z.number().min(1).max(60).default(10),
        seed: z.number().int().default(42),
      },
    },
    async (args, extra) =>
      safeTool("auto_optimize_prompt", async () => {
        if (!ctx.llm.available || !ctx.evalLlm.available) throw new Error("auto_optimize_prompt needs a configured LLM (LLM_API_KEY).");
        const s = startRun(ctx, { maxCalls: args.maxCalls ?? ctx.config.maxCalls, maxMinutes: args.maxMinutes, extra });
        const cases: TestCase[] = [];
        if (args.testsFile) cases.push(...(await loadTestsFile(args.testsFile)));
        for (const [i, t] of (args.testCases ?? []).entries()) cases.push({ description: t.description, input: t.input, vars: t.vars ?? {}, assert: validateAssertions(t.assert ?? [], `testCases[${i}].assert`), threshold: t.threshold });
        const assert: Assertion[] = validateAssertions(args.assert ?? [], "assert");
        if (args.rubric) assert.push({ type: "llm-rubric", value: args.rubric, metric: "rubric" });

        const result = await autoOptimize(
          { prompt: args.prompt, promptMode: args.promptMode, goal: args.goal, cases: cases.length ? cases : undefined, numCases: args.numCases, assert, budget: args.budget, rounds: args.rounds, candidatesPerRound: args.candidatesPerRound, strategies: args.strategies, model: args.model, temperature: args.temperature, seed: args.seed },
          { llm: s.llm, evalLlm: s.evalLlm, judge: s.judge, judgeModel: ctx.config.judgeModel, templates: ctx.templates, run: s.run, concurrency: ctx.config.concurrency, maxCalls: args.maxCalls ?? ctx.config.maxCalls },
        );
        const usage = s.usage();
        const saved = await ctx.history.save({
          tool: "auto-optimize",
          title: args.prompt.slice(0, 60),
          input: args.prompt,
          final: result.best.prompt,
          meta: { baselineDev: result.baseline.dev?.score, bestDev: result.best.dev?.score, strategy: result.best.strategy, stoppedReason: result.stoppedReason, usage: s.run.meter.toJSON() },
          versions: result.candidates.map((c) => ({ label: `${c.id} ${c.strategy} (${c.status})`, prompt: c.prompt, score: c.dev?.score ?? c.train?.score })),
        });
        const name = `auto-optimize-${stamp()}`;
        const md = formatAutoReport(result, usage, undefined, saved.id);
        const paths = await writeReport(ctx.config.dataDir, name, { md, json: JSON.stringify({ ...result, usage: s.run.meter.toJSON() }, null, 2) });
        return {
          content: [{ type: "text", text: `${md}\n**Report:** ${paths.md}` }],
          structuredContent: {
            bestPrompt: result.best.prompt,
            baselineDevScore: result.baseline.dev?.score,
            bestDevScore: result.best.dev?.score,
            bestStrategy: result.best.strategy,
            stoppedReason: result.stoppedReason,
            candidates: result.candidates.map((c) => ({ id: c.id, round: c.round, strategy: c.strategy, status: c.status, train: c.train?.score, dev: c.dev?.score })),
            historyId: saved.id,
            reportPaths: paths,
            usage: s.run.meter.toJSON(),
          },
        };
      }),
  );
}
