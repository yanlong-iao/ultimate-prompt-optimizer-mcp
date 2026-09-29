import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeTool, startRun, type AppContext } from "../context.js";
import { validateAssertions } from "../eval/assertions.js";
import { generateCases } from "../eval/caseGen.js";
import { loadConfig, loadTestsFile } from "../eval/config.js";
import { evalHtml, evalMarkdown } from "../eval/report.js";
import { buildMessages, estimateCalls, runEval, type EvalPlan } from "../eval/runner.js";
import { reviewPrompt } from "../eval/staticReview.js";
import { AssertionInputSchema, TestCaseInputSchema, type Assertion, type TestCase } from "../eval/types.js";
import { stamp, writeReport } from "../utils/store.js";
import { truncate } from "../utils/text.js";

export function registerEvaluatePreview(server: McpServer, ctx: AppContext) {
  server.registerTool(
    "evaluate_prompt_preview",
    {
      title: "Evaluate / A-B test prompts",
      description:
        "promptfoo-style evaluation. Runs prompt variants (A, B, C…) × models × test cases × repeats against the real model, applies assertions and model graders, and reports pass rate, weighted score, per-metric averages, latency, tokens, cost, repeat consistency, an optional pairwise judge, and a winner. Writes an HTML + JSON report. " +
        "Assertions (prefix not- to negate; weight/metric/transform/threshold supported): equals, contains, icontains, contains-any/all, icontains-any/all, starts-with, regex, is-json/contains-json (+JSON schema), javascript, levenshtein, latency, cost, min/max-length, is-refusal, llm-rubric, g-eval, factuality, answer-relevance, prompt-compliance, assert-set. " +
        "Tests can come from testCases, a YAML/JSON/CSV testsFile, or a promptfoo-style configPath (prompts/providers/tests/defaultTest; array vars expand as a matrix); if none are given, cases are auto-generated. Responses are cached on disk so re-runs are free. " +
        "The call count is estimated first and the run is refused if it exceeds maxCalls. mock=true → static lint + request preview, 0 calls.",
      inputSchema: {
        prompt: z.string().optional().describe("Variant A (e.g. the original). Optional when configPath provides prompts"),
        promptB: z.string().optional().describe("Variant B (e.g. the optimized prompt)"),
        extraPrompts: z.array(z.string()).max(4).optional().describe("Variants C, D…"),
        labels: z.array(z.string()).optional().describe("Names for the variants, in order"),
        promptMode: z.enum(["system", "user"]).optional().describe("system: prompt = system message, case input = user message. user: prompt is the user message with {{vars}}. Default system (user when configPath is used)"),
        testCases: z.array(TestCaseInputSchema).max(50).optional(),
        testsFile: z.string().optional().describe("Path to tests (.yaml/.json/.csv with __expected columns), relative to the project folder or absolute"),
        configPath: z.string().optional().describe("Path to a promptfoo-style config (.yaml/.json)"),
        autoGenerateCases: z.number().int().min(0).max(10).default(3).describe("Generated when no tests are given (each with its own grading criteria)"),
        rubric: z.string().optional().describe("llm-rubric applied to every case"),
        defaultAssert: z.array(AssertionInputSchema).optional().describe("Assertions applied to every case"),
        models: z.array(z.string()).max(4).optional().describe("Model ids to compare on the same endpoint, e.g. ['deepseek-flash','deepseek-v4-pro']"),
        repeat: z.number().int().min(1).max(5).optional().describe("Run each case N times to measure consistency (default 1)"),
        pairwise: z.boolean().default(false).describe("With exactly 2 variants: LLM judge picks the better output per case (position-bias controlled)"),
        temperature: z.number().min(0).max(2).default(0.3),
        useCache: z.boolean().default(true),
        saveReport: z.boolean().default(true),
        maxCalls: z.number().int().min(1).max(1000).optional().describe("Refuse to run if the estimated API calls exceed this (default UPO_MAX_CALLS)"),
        mock: z.boolean().default(false),
        maxOutputChars: z.number().int().min(100).max(8000).default(600),
      },
    },
    async (args, extra) =>
      safeTool("evaluate_prompt_preview", async () => {
        const notes: string[] = [];
        const maxCalls = args.maxCalls ?? ctx.config.maxCalls;
        const cfg = args.configPath ? await loadConfig(args.configPath) : undefined;

        const texts = [...(cfg?.prompts.map((p) => p.text) ?? []), ...[args.prompt, args.promptB, ...(args.extraPrompts ?? [])].filter((x): x is string => Boolean(x))];
        if (!texts.length) throw new Error("Provide `prompt` (and optionally promptB) or a configPath with prompts.");
        const letters = "ABCDEFGH";
        const prompts = texts.map((text, i) => ({ label: args.labels?.[i] ?? cfg?.prompts[i]?.label ?? letters[i], text }));
        const promptMode = args.promptMode ?? cfg?.promptMode ?? (cfg ? "user" : "system");
        const models = args.models?.length ? args.models : cfg?.models.length ? cfg.models : [ctx.evalLlm.model];

        let cases: TestCase[] = [...(cfg?.tests ?? [])];
        if (args.testsFile) cases.push(...(await loadTestsFile(args.testsFile)));
        for (const [i, t] of (args.testCases ?? []).entries()) {
          cases.push({ description: t.description, input: t.input, vars: t.vars ?? {}, assert: validateAssertions(t.assert ?? [], `testCases[${i}].assert`), threshold: t.threshold });
        }

        let defaultAssert: Assertion[] = [...(cfg?.defaultAssert ?? []), ...validateAssertions(args.defaultAssert ?? [], "defaultAssert")];
        if (args.rubric) defaultAssert.push({ type: "llm-rubric", value: args.rubric, metric: "rubric" });

        const reviews = prompts.map((p) => reviewPrompt(p.text));
        const live = !args.mock && ctx.evalLlm.available;
        if (!live) {
          if (!args.mock) notes.push("No eval LLM configured (LLM_API_KEY) — MOCK mode: static review + request preview, no model calls.");
          const sample = cases[0] ?? { input: "Hi! What can you help me with?", vars: {}, assert: [] };
          const L = [`# Prompt preview — MOCK (0 API calls)`, ...notes.map((n) => `> ${n}`), "", "| Variant | Static score | LangGPT | Tokens | Suggestions |", "|---|---|---|---|---|"];
          reviews.forEach((rv, i) => L.push(`| ${prompts[i].label} | ${rv.score}/100 | ${rv.langgpt.valid ? "✅" : `⚠️ ${rv.langgpt.score}`} | ~${rv.approxTokens} | ${rv.suggestions.join("; ") || "—"} |`));
          if (prompts.length > 1) {
            const best = [...reviews.keys()].sort((a, b) => reviews[b].score - reviews[a].score);
            L.push("", `**Static leader:** ${reviews[best[0]].score === reviews[best[1]].score ? "tie" : prompts[best[0]].label} (heuristic only)`);
          }
          prompts.forEach((p) => L.push("", `**Request that would be sent (${p.label}, first case):**`, "```json", truncate(JSON.stringify({ messages: buildMessages(p.text, promptMode, sample) }, null, 2), 1500), "```"));
          return { content: [{ type: "text", text: L.join("\n") }], structuredContent: { mode: "mock", reviews: reviews.map((r, i) => ({ label: prompts[i].label, score: r.score, langgpt: r.langgpt })) } };
        }

        const s = startRun(ctx, { maxCalls, extra, maxMinutes: 15 });
        const noAssertionsAnywhere = !defaultAssert.length && cases.every((c) => !c.assert.length);
        if (!cases.length) {
          if (args.autoGenerateCases > 0) {
            if (maxCalls < 1 + args.autoGenerateCases * prompts.length * models.length * 2) throw new Error(`maxCalls=${maxCalls} is too low to generate and run ${args.autoGenerateCases} cases.`);
            cases = await generateCases(s.llm, prompts[0].text, args.autoGenerateCases, noAssertionsAnywhere);
            notes.push(`Auto-generated ${cases.length} test case(s) from ${prompts[0].label}${noAssertionsAnywhere ? ", each graded against its own criteria" : ""}.`);
          } else {
            cases = [{ description: "smoke", input: /[一-鿿]/.test(prompts[0].text) ? "你好，请介绍一下你能帮我做什么。" : "Hi! What can you help me with?", vars: {}, assert: [] }];
          }
        }
        if (!defaultAssert.length && cases.every((c) => !c.assert.length)) {
          defaultAssert = [{ type: "prompt-compliance", value: prompts[0].text, metric: "compliance" }];
          notes.push(`No assertions given — every output is graded with prompt-compliance against ${prompts[0].label}'s instructions.`);
        }

        const plan: EvalPlan = {
          prompts,
          models,
          cases,
          defaultAssert,
          repeat: args.repeat ?? cfg?.repeat ?? 1,
          promptMode,
          temperature: args.temperature,
          pairwise: args.pairwise && prompts.length === 2,
          pairwiseCriteria: args.rubric,
          useCache: args.useCache,
          concurrency: ctx.config.concurrency,
        };
        const est = estimateCalls(plan);
        if (est > s.run.budget.remaining) {
          throw new Error(`Estimated ${est} API calls exceeds the remaining budget (${s.run.budget.remaining} of maxCalls=${maxCalls}). Reduce variants/models/cases/repeat or raise maxCalls. (Cached rows don't count, so the real number may be lower.)`);
        }
        notes.push(`Estimated ≤ ${est} API calls (cached responses are free).`);

        const result = await runEval(plan, { llm: s.evalLlm, judge: s.judge, judgeModel: ctx.config.judgeModel, prices: ctx.config.prices, run: s.run });
        const usage = s.usage();
        let reportPaths: Record<string, string> | undefined;
        if (args.saveReport) {
          const name = `eval-${stamp()}`;
          reportPaths = await writeReport(ctx.config.dataDir, name, {
            html: evalHtml(plan, result, reviews, cfg?.description ?? "Prompt evaluation", usage),
            json: JSON.stringify({ plan, result, usage: s.run.meter.toJSON() }, null, 2),
          });
        }
        return {
          content: [{ type: "text", text: evalMarkdown(plan, result, reviews, { maxOutputChars: args.maxOutputChars, usage, reportPaths, extraNotes: notes }) }],
          structuredContent: { mode: "live", winner: result.winner, summaries: result.summaries, pairwise: result.pairwise.map(({ details, ...p }) => p), reportPaths, usage: s.run.meter.toJSON() },
        };
      }),
  );
}
