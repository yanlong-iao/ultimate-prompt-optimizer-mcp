// Reproducible case study: drives the built server over stdio (like Claude does) against a REAL OpenAI-compatible LLM.
// Flow: suggest_prompts → analyze_prompt → optimize_prompt_via_api → evaluate_prompt_preview (A/B, pairwise, repeat 2).
// Costs money: reads LLM_* from .env. Per-tool call caps keep the whole run ≤ 75 API calls.
// Usage: node scripts/case-study.mjs <prompt.md> [outDir]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [promptPath, outDir = "private/case-study"] = process.argv.slice(2);
if (!promptPath) {
  console.error("Usage: node scripts/case-study.mjs <prompt.md> [outDir]");
  process.exit(2);
}
const original = readFileSync(promptPath, "utf8");
mkdirSync(outDir, { recursive: true });

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")),
  UPO_MAX_CALLS: "10", // cap for suggest / analyze / optimize (evaluate gets its own maxCalls below)
  UPO_DATA_DIR: resolve(outDir, "data"), // fresh cache → every number below is a real call
  LOG_LEVEL: "warn",
};
const client = new Client({ name: "case-study", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "inherit" }));

const steps = [];
async function step(name, args) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 20 * 60_000 });
  const ms = Date.now() - t;
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name}: ${text}`);
  const usage = r.structuredContent?.usage ?? {};
  steps.push({ name, ms, calls: usage.calls ?? 0, cachedCalls: usage.cachedCalls ?? 0, promptTokens: usage.promptTokens ?? 0, completionTokens: usage.completionTokens ?? 0 });
  writeFileSync(resolve(outDir, `${steps.length}-${name}.md`), text);
  writeFileSync(resolve(outDir, `${steps.length}-${name}.json`), JSON.stringify(r.structuredContent ?? {}, null, 2));
  console.log(`✔ ${name}: ${usage.calls ?? "?"} calls, ${ms} ms`);
  return r;
}

try {
  await step("suggest_prompts", {
    topic: "香港量化交易/量化研究岗位的面试陪练：每次出一道概率题或脑筋急转弯，等我作答后判断对错并给出面试可口述的最快解法",
    count: 3,
  });
  await step("analyze_prompt", { prompt: original, focus: "回复是否足够简短、是否严格一次只出一道题并等待作答" });
  const opt = await step("optimize_prompt_via_api", {
    prompt: original,
    rounds: 2,
    requirements: "每次反馈控制在 150 字以内；出题后立即停止，不附带任何提示；保持中文。",
  });
  const optimized = opt.structuredContent?.final ?? opt.structuredContent?.optimized;
  if (!optimized) throw new Error("optimize_prompt_via_api returned no final prompt in structuredContent");
  writeFileSync(resolve(outDir, "optimized-prompt.md"), optimized);
  await step("evaluate_prompt_preview", {
    prompt: original,
    promptB: optimized,
    labels: ["original", "optimized"],
    autoGenerateCases: 3,
    repeat: 2,
    pairwise: true,
    rubric: "一次只出一道题并停下等待作答；用户作答后必须给出判定（正确/部分正确/错误）、面试可直接口述的最快解法和关键技巧；表述精炼，不做冗长推导。",
    maxCalls: 45,
  });
} finally {
  const total = steps.reduce((a, s) => ({ calls: a.calls + s.calls, ms: a.ms + s.ms, pt: a.pt + s.promptTokens, ct: a.ct + s.completionTokens }), { calls: 0, ms: 0, pt: 0, ct: 0 });
  writeFileSync(resolve(outDir, "summary.json"), JSON.stringify({ steps, total }, null, 2));
  console.log(`Total: ${total.calls} API calls, ${total.pt} in / ${total.ct} out tokens, ${(total.ms / 1000).toFixed(1)} s`);
  await client.close();
}
