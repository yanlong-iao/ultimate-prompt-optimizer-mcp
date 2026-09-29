/** Matrix eval runner: prompts × models × test cases × repeats, with assertions, pairwise judging and aggregation. */
import type { ChatMessage, LlmClient } from "../clients/llmClient.js";
import { pairJudge, type PairOutcome } from "../analysis/analyzer.js";
import { errMsg } from "../utils/errors.js";
import type { RunContext } from "../utils/run.js";
import { mapPool, renderVars } from "../utils/text.js";
import { aggregate, applyTransform, countGraded, runAssertions } from "./assertions.js";
import type { Assertion, RowResult, TestCase } from "./types.js";

export interface EvalPlan {
  prompts: Array<{ label: string; text: string }>;
  models: string[];
  cases: TestCase[];
  defaultAssert: Assertion[];
  repeat: number;
  promptMode: "system" | "user";
  temperature: number;
  pairwise: boolean;
  pairwiseCriteria?: string;
  useCache: boolean;
  concurrency: number;
}

export interface VariantSummary {
  promptIndex: number;
  label: string;
  model: string;
  rows: number;
  passRate: number;
  avgScore: number;
  metrics: Record<string, number>;
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
  errors: number;
  consistency?: number; // repeat > 1: share of cases whose pass/fail agreed across repeats
}

export interface PairwiseSummary {
  model: string;
  winsA: number;
  winsB: number;
  ties: number;
  details: Array<{ caseIndex: number; winner: PairOutcome; reasons: string[]; overfitWarning: string }>;
}

export interface EvalResult {
  rows: RowResult[];
  summaries: VariantSummary[];
  pairwise: PairwiseSummary[];
  winner?: { label: string; model: string } | "tie";
  notes: string[];
}

export function caseInput(tc: TestCase): string {
  return tc.input ?? tc.vars.input ?? tc.vars.query ?? tc.vars.question ?? "";
}

export function buildMessages(prompt: string, mode: "system" | "user", tc: TestCase): ChatMessage[] {
  const vars = { ...tc.vars, ...(tc.input !== undefined ? { input: tc.input } : {}) };
  const p = renderVars(prompt, vars);
  const input = renderVars(caseInput(tc), vars);
  if (mode === "system") return [{ role: "system", content: p }, { role: "user", content: input }];
  const usesInput = /\{\{\s*input\s*\}\}/.test(prompt);
  return [{ role: "user", content: usesInput || !input ? p : `${p}\n\n${input}` }];
}

export function estimateCalls(plan: EvalPlan): number {
  const perRow = plan.cases.reduce((n, c) => n + 1 + countGraded([...c.assert, ...plan.defaultAssert]), 0);
  const runs = perRow * plan.prompts.length * plan.models.length * plan.repeat;
  const pair = plan.pairwise && plan.prompts.length === 2 ? plan.cases.length * plan.models.length : 0;
  return runs + pair;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rank = (x: VariantSummary, y: VariantSummary) => y.passRate - x.passRate || y.avgScore - x.avgScore || (x.avgLatencyMs ?? 0) - (y.avgLatencyMs ?? 0);

const p95 = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};

export async function runEval(
  plan: EvalPlan,
  deps: { llm: LlmClient; judge: LlmClient; judgeModel: string; prices?: { inputPerM: number; outputPerM: number }; run: RunContext },
): Promise<EvalResult> {
  const notes: string[] = [];
  const jobs: Array<{ promptIndex: number; model: string; caseIndex: number; repeat: number }> = [];
  for (let p = 0; p < plan.prompts.length; p++)
    for (const model of plan.models)
      for (let c = 0; c < plan.cases.length; c++) for (let r = 0; r < plan.repeat; r++) jobs.push({ promptIndex: p, model, caseIndex: c, repeat: r });

  let done = 0;
  let budgetHit = false;
  let timeHit = false;
  const rows = await mapPool(jobs, plan.concurrency, async (job): Promise<RowResult> => {
    const tc = plan.cases[job.caseIndex];
    const prompt = plan.prompts[job.promptIndex].text;
    const base = { ...job, output: "", latencyMs: 0, cached: false, assertions: [], pass: false, score: 0 };
    if (deps.run.deadline && Date.now() > deps.run.deadline) {
      timeHit = true;
      return { ...base, error: "skipped: time limit reached" };
    }
    if (plan.promptMode === "system" && !caseInput(tc)) return { ...base, error: "test case has no input (set `input` or vars.input)" };
    try {
      const res = await deps.llm.chat(buildMessages(prompt, plan.promptMode, tc), {
        model: job.model,
        temperature: plan.temperature,
        cache: plan.useCache,
        cacheSalt: plan.repeat > 1 ? `rep${job.repeat}` : undefined,
        purpose: "eval-run",
      });
      let output = res.text;
      if (tc.transform) output = applyTransform(tc.transform, output, { vars: tc.vars, prompt, input: caseInput(tc), latencyMs: res.latencyMs });
      const costUsd = deps.prices && res.usage && !res.cached ? (res.usage.promptTokens * deps.prices.inputPerM + res.usage.completionTokens * deps.prices.outputPerM) / 1e6 : deps.prices ? 0 : undefined;
      const assertions = await runAssertions([...tc.assert, ...plan.defaultAssert], {
        prompt, input: renderVars(caseInput(tc), tc.vars), vars: tc.vars, output, latencyMs: res.latencyMs, cached: res.cached, costUsd, judge: deps.judge, judgeModel: deps.judgeModel, salt: plan.repeat > 1 ? `rep${job.repeat}` : 0,
      });
      const { score, allPass } = aggregate(assertions);
      return {
        ...job,
        output,
        latencyMs: res.latencyMs,
        cached: res.cached,
        tokens: res.usage ? { prompt: res.usage.promptTokens, completion: res.usage.completionTokens } : undefined,
        costUsd,
        assertions,
        score,
        pass: tc.threshold !== undefined ? score >= tc.threshold : allPass,
      };
    } catch (e) {
      if ((e as Error).name === "BudgetExceededError") budgetHit = true;
      return { ...base, error: errMsg(e) };
    } finally {
      done++;
      deps.run.progress(`eval ${done}/${jobs.length}`, done, jobs.length);
    }
  });
  if (budgetHit) notes.push("Some rows were not run because the call budget was exhausted.");
  if (timeHit) notes.push("Some rows were skipped because the time limit was reached.");

  // ── aggregate per prompt × model
  const summaries: VariantSummary[] = [];
  for (let p = 0; p < plan.prompts.length; p++) {
    for (const model of plan.models) {
      const rs = rows.filter((r) => r.promptIndex === p && r.model === model);
      const ok = rs.filter((r) => !r.error);
      const metrics: Record<string, { sum: number; n: number }> = {};
      for (const r of ok)
        for (const a of r.assertions) {
          const k = a.metric ?? a.type;
          (metrics[k] ??= { sum: 0, n: 0 }).sum += a.score;
          metrics[k].n++;
        }
      const lat = ok.filter((r) => !r.cached).map((r) => r.latencyMs);
      let consistency: number | undefined;
      if (plan.repeat > 1) {
        let agree = 0;
        for (let c = 0; c < plan.cases.length; c++) {
          const reps = ok.filter((r) => r.caseIndex === c);
          if (reps.length && reps.every((r) => r.pass === reps[0].pass)) agree++;
        }
        consistency = plan.cases.length ? agree / plan.cases.length : undefined;
      }
      summaries.push({
        promptIndex: p,
        label: plan.prompts[p].label,
        model,
        rows: rs.length,
        passRate: rs.length ? rs.filter((r) => r.pass).length / rs.length : 0,
        avgScore: rs.length ? rs.reduce((s, r) => s + r.score, 0) / rs.length : 0,
        metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v.sum / v.n])),
        avgLatencyMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : undefined,
        p95LatencyMs: p95(lat),
        promptTokens: ok.reduce((s, r) => s + (r.cached ? 0 : r.tokens?.prompt ?? 0), 0),
        completionTokens: ok.reduce((s, r) => s + (r.cached ? 0 : r.tokens?.completion ?? 0), 0),
        costUsd: deps.prices ? ok.reduce((s, r) => s + (r.costUsd ?? 0), 0) : undefined,
        errors: rs.length - ok.length,
        consistency,
      });
    }
  }

  // ── pairwise A vs B
  const pairwise: PairwiseSummary[] = [];
  if (plan.pairwise && plan.prompts.length === 2) {
    for (const model of plan.models) {
      const pairs = plan.cases
        .map((_, c) => ({ c, a: rows.find((r) => r.promptIndex === 0 && r.model === model && r.caseIndex === c && r.repeat === 0), b: rows.find((r) => r.promptIndex === 1 && r.model === model && r.caseIndex === c && r.repeat === 0) }))
        .filter((x) => x.a && x.b && !x.a.error && !x.b.error);
      const criteria =
        plan.pairwiseCriteria ??
        `Which output better accomplishes the user's request while following this task specification (the original prompt):\n${plan.prompts[0].text}`;
      const details = await mapPool(pairs, plan.concurrency, async ({ c, a, b }) => {
        try {
          const j = await pairJudge(deps.judge, { criteria, input: renderVars(caseInput(plan.cases[c]), plan.cases[c].vars), outputA: a!.output, outputB: b!.output, index: c, model: deps.judgeModel });
          return { caseIndex: c, ...j };
        } catch (e) {
          return { caseIndex: c, winner: "tie" as PairOutcome, reasons: [`judge error: ${errMsg(e)}`], overfitWarning: "" };
        }
      });
      pairwise.push({ model, winsA: details.filter((d) => d.winner === "A").length, winsB: details.filter((d) => d.winner === "B").length, ties: details.filter((d) => d.winner === "tie").length, details });
    }
  }

  // Winner = best prompt variant averaged over models; bestModel = best model for that variant.
  let winner: EvalResult["winner"];
  if (plan.prompts.length > 1 || plan.models.length > 1) {
    const byLabel = plan.prompts.map((p, i) => {
      const ss = summaries.filter((s) => s.promptIndex === i);
      return { label: p.label, passRate: avg(ss.map((s) => s.passRate)), score: avg(ss.map((s) => s.avgScore)), best: [...ss].sort(rank)[0] };
    });
    const ranked = byLabel.sort((x, y) => y.passRate - x.passRate || y.score - x.score);
    const [first, second] = ranked;
    if (second && Math.abs(first.passRate - second.passRate) < 1e-9 && Math.abs(first.score - second.score) < 1e-9) winner = "tie";
    else winner = { label: first.label, model: first.best.model };
  }
  return { rows, summaries, pairwise, winner, notes };
}
