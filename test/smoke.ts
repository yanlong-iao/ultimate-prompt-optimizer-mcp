/** End-to-end smoke tests: spawn dist/index.js over stdio (exactly like Claude does) and drive every tool against offline mocks. */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockLlm, startUpstream, type UpstreamMode } from "./mocks.js";

type Env = Record<string, string>;
const text = (r: any) => (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
const sc = (r: any) => r.structuredContent as any;
const DATA = mkdtempSync(join(tmpdir(), "upo-data-"));
const TPL = join(DATA, "custom-templates");
mkdirSync(TPL, { recursive: true });

async function withServer(env: Env, fn: (c: Client) => Promise<void>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { PATH: process.env.PATH ?? "", UPO_ENV_FILE: "/nonexistent", LOG_LEVEL: "warn", UPO_DATA_DIR: DATA, UPO_TEMPLATES_DIR: TPL, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`✔ ${name}`);
  } catch (e) {
    console.error(`✘ ${name}\n`, e);
    process.exitCode = 1;
  }
}

const llm = await startMockLlm();
const llmEnv = { LLM_BASE_URL: llm.url, LLM_API_KEY: "test-key", LLM_MODEL: "mock-flash", LLM_PRICE_INPUT_PER_M: "0.3", LLM_PRICE_OUTPUT_PER_M: "1.2" };

async function upstreamCase(mode: UpstreamMode, pw: string | undefined, fn: (url: string, stats: { authCalls: number; mcpCalls: number }, drop: () => void) => Promise<void>) {
  const up = await startUpstream(mode, pw);
  try {
    await fn(up.url, up.stats, up.dropSessions);
  } finally {
    await up.close();
  }
}

const TOOLS = ["analyze_prompt", "auto_optimize_prompt", "evaluate_prompt_preview", "generate_langgpt_structure", "list_templates", "optimize_prompt_via_api", "optimizer_connection_status", "prompt_history", "suggest_prompts"];

await test("lists 9 tools", () =>
  withServer({}, async (c) => {
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  }));

// ───────────── local template library ─────────────
await test("optimize (local): langgpt-strict template, fence stripped, lost {{placeholder}} auto-repaired, usage + history", () =>
  withServer(llmEnv, async (c) => {
    const r = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "You help {{company}} staff. Mention {{drop_me}}.", rounds: 1 } });
    const t = text(r);
    assert.equal(r.isError, undefined, t);
    const s = sc(r);
    assert.equal(s.backend, "local");
    assert.equal(s.rounds[0].template, "langgpt-strict");
    assert.deepEqual(s.rounds[0].missingPlaceholders, ["drop_me"]);
    assert.equal(s.rounds.at(-1).action, "repair");
    assert.match(s.final, /\{\{drop_me\}\}/);
    assert.match(s.final, /\{\{company\}\}/);
    assert.match(t, /LangGPT structure valid \(v2/);
    assert.match(t, /\*\*Usage:\*\* 2 API call\(s\).*≈ \$/);
    assert.ok(existsSync(join(DATA, "history", `${s.historyId}.json`)));
  }));

await test("optimize: explicit templates (user-planning, output-format) + requirements reach iterate", () =>
  withServer(llmEnv, async (c) => {
    const u = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "plan my week", mode: "user", template: "user-planning", rounds: 1 } });
    assert.equal(sc(u).rounds[0].template, "user-planning");
    assert.ok(llm.calls.some((x) => x.startsWith("optimize:Task Planner")));
    const s = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "report bot", template: "output-format", rounds: 2, requirements: "Always end with DONE." } });
    assert.equal(s.isError, undefined, text(s));
    assert.match(sc(s).final, /Always end with DONE/);
    assert.match(text(s), /1\. Always end with DONE\./);
  }));

await test("list_templates + custom Markdown template overrides/extends and is usable", async () => {
  writeFileSync(join(TPL, "house.md"), "---\nid: house-style\ntype: optimize-system\nname: House\ndescription: Our style\n---\n# Role: House Style Editor\nRewrite originalPrompt. Output only the prompt.");
  await withServer(llmEnv, async (c) => {
    const l = await c.callTool({ name: "list_templates", arguments: {} });
    const ids = sc(l).templates.map((t: any) => t.id);
    for (const id of ["langgpt-strict", "general", "output-format", "analytical", "user-basic", "user-professional", "user-planning", "iterate", "house-style"]) assert.ok(ids.includes(id), id);
    const r = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "x bot", template: "house-style", rounds: 1 } });
    assert.equal(r.isError, undefined, text(r));
    assert.ok(llm.calls.some((x) => x.startsWith("optimize:House Style Editor")));
    const bad = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "x", template: "nope", rounds: 1 } });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /Unknown optimize-system template "nope"/);
  });
});

await test("analyze_prompt: 5 dimensions, exact patches applied/skipped, rewrite", () =>
  withServer(llmEnv, async (c) => {
    const r = await c.callTool({ name: "analyze_prompt", arguments: { prompt: "你是一个量化面试陪练，出概率题。", applyPatches: true, rewrite: true, focus: "太啰嗦" } });
    const t = text(r);
    assert.equal(r.isError, undefined, t);
    assert.match(t, /总分: 62\/100/);
    assert.match(t, /目标清晰度 \| 50/);
    assert.match(t, /✅ applied/);
    assert.match(t, /skipped \(oldText not found\)/);
    assert.match(sc(r).patched, /\[PATCHED\]/);
    assert.match(sc(r).rewritten, /revised/);
  }));

await test("generate_langgpt_structure: v2 via LLM with Commands/Reminder; classic template", async () => {
  await withServer(llmEnv, async (c) => {
    const r = await c.callTool({ name: "generate_langgpt_structure", arguments: { idea: "reviewer for quant research reports", constraints: ["Reply in under 400 words"], includeCommands: true, includeReminder: true } });
    const t = text(r);
    assert.match(t, /strategy: llm/);
    assert.match(t, /## Goal\n- Outcome: A prioritized issue list/);
    assert.match(t, /### Skill-1: Backtest auditing/);
    assert.match(t, /## Rules\n1\. Reply in under 400 words/);
    assert.match(t, /## Commands\n- Prefix: "\/"/);
    assert.match(t, /## Reminder/);
    assert.equal(sc(r).check.valid, true);
    assert.deepEqual(sc(r).check.danglingRefs, []);
  });
  await withServer({}, async (c) => {
    const r = await c.callTool({ name: "generate_langgpt_structure", arguments: { idea: "帮我审阅量化研究报告", style: "classic" } });
    const t = text(r);
    assert.match(t, /strategy: template/);
    assert.match(t, /## Goals\n/);
    assert.match(t, /## Constraints\n/);
    assert.equal(sc(r).check.valid, true);
  });
});

// ───────────── evaluation engine ─────────────
const B = "# Role: B\n\n## Profile\n- d\n\n## Goal\n- g\n\n## Rules\n1. a\n2. b\n3. c\n\n## Skills\n- s\n\n## Workflow\n1. w\n\n## OutputFormat\nJSON\n\n## Initialization\nAs <Role> follow <Rules>";

await test("evaluate: mock mode without LLM (0 calls)", () =>
  withServer({}, async (c) => {
    const r = await c.callTool({ name: "evaluate_prompt_preview", arguments: { prompt: "You are helpful", promptB: B } });
    const t = text(r);
    assert.match(t, /MOCK \(0 API calls\)/);
    assert.match(t, /\*\*Static leader:\*\* B/);
  }));

await test("evaluate: promptfoo assertions (not-, any/all, JSON schema, javascript, transform, assert-set, weights, graders, refusal)", () =>
  withServer(llmEnv, async (c) => {
    const r = await c.callTool({
      name: "evaluate_prompt_preview",
      arguments: {
        prompt: B,
        testCases: [
          {
            description: "json",
            input: "q {{x}}",
            vars: { x: "42" },
            assert: [
              { type: "contains", value: "q 42" },
              { type: "not-contains", value: "ERROR" },
              { type: "icontains-any", value: ["mock answer", "zzz"] },
              { type: "contains-all", value: "MOCK,JSON" },
              { type: "contains-json", value: { type: "object", required: ["ok"], properties: { ok: { const: true } } } },
              { type: "not-is-json" },
              { type: "javascript", value: "output.length > 10" },
              { type: "javascript", value: "return { pass: output.includes('B'), score: 0.8, reason: 'has B' }", metric: "custom" },
              { type: "equals", value: "MOCK", transform: "output.slice(0, 4)" },
              { type: "assert-set", threshold: 0.5, assert: [{ type: "regex", value: "^MOCK" }, { type: "contains", value: "nope" }] },
              { type: "max-length", value: 5, weight: 0 },
              { type: "g-eval", value: "Is helpful" },
              { type: "factuality", value: "ok is true" },
              { type: "answer-relevance" },
              { type: "llm-rubric", value: "answers", metric: "quality" },
              { type: "latency", threshold: 60000 },
              { type: "cost", threshold: 1 },
            ],
          },
          { description: "refusal", input: "please refuse me", assert: [{ type: "not-is-refusal", weight: 2 }] },
        ],
      },
    });
    const t = text(r);
    assert.equal(r.isError, undefined, t);
    const row = t.split("### 1.")[1].split("### 2.")[0];
    for (const needle of ["✅ `contains`", "✅ `not-contains`", "✅ `icontains-any`", "✅ `contains-all`", "✅ `contains-json`", "✅ `not-is-json`", "✅ `javascript`", "[custom]", "✅ `equals`", "✅ `assert-set`", "❌ `max-length`", "✅ `g-eval`", "✅ `factuality`", "✅ `answer-relevance`", "✅ `llm-rubric` [quality]", "✅ `latency`", "✅ `cost`"]) assert.ok(row.includes(needle), `missing ${needle}\n${row}`);
    assert.match(row, /✅ score/); // weight-0 failure does not fail the test
    assert.match(t, /### 2\. refusal[\s\S]*❌ `not-is-refusal`/);
    assert.equal(sc(r).summaries[0].passRate, 0.5);
    assert.ok(existsSync(sc(r).reportPaths.html));
    assert.match(readFileSync(sc(r).reportPaths.html, "utf8"), /<table>/);
  }));

await test("evaluate: A/B × 2 models × repeat 2 + pairwise + consistency; identical re-run is fully cached (0 calls)", () =>
  withServer(llmEnv, async (c) => {
    const args = { prompt: "# Role: A\nplain", promptB: B, models: ["mock-flash", "mock-pro"], repeat: 2, pairwise: true, rubric: "answers the question", testCases: [{ input: "hello" }, { input: "world" }] };
    llm.reset();
    const r = await c.callTool({ name: "evaluate_prompt_preview", arguments: args });
    const t = text(r);
    assert.equal(r.isError, undefined, t);
    assert.equal(sc(r).summaries.length, 4);
    assert.equal(sc(r).winner.label, "B");
    assert.equal(sc(r).pairwise[0].winsB, 2);
    assert.match(t, /Consistency/);
    assert.ok(llm.calls.some((x) => x === "eval-run:mock-pro"));
    // 16 runs + 16 rubric grades + 4 pairwise = 36 requests; identical grader requests are de-duplicated by the cache
    assert.equal(sc(r).usage.calls + sc(r).usage.cachedCalls, 36);
    assert.ok(sc(r).usage.calls < 36);
    const again = await c.callTool({ name: "evaluate_prompt_preview", arguments: args });
    assert.equal(sc(again).usage.calls, 0);
    assert.match(text(again), /0 API call\(s\) · 36 served from cache/);
  }));

await test("evaluate: refuses to run over budget (no calls spent)", () =>
  withServer(llmEnv, async (c) => {
    llm.reset();
    const r = await c.callTool({ name: "evaluate_prompt_preview", arguments: { prompt: "p", promptB: "q", testCases: [{ input: "1" }, { input: "2" }, { input: "3" }], rubric: "x", maxCalls: 5 } });
    assert.equal(r.isError, true);
    assert.match(text(r), /Estimated 12 API calls exceeds/);
    assert.equal(llm.calls.length, 0);
  }));

await test("evaluate: promptfoo YAML config (providers, defaultTest, var matrix) + CSV tests with __expected", () =>
  withServer(llmEnv, async (c) => {
    writeFileSync(join(DATA, "tests.csv"), 'input,__expected1,__expected2,__description\n"hello, there",contains: hello,not-contains: zzz,greet\nbye,icontains: BYE,grade: answers,farewell\n');
    writeFileSync(
      join(DATA, "promptfooconfig.yaml"),
      `description: Demo suite\nprompts:\n  - "Reply to {{input}} as {{persona}}"\nproviders:\n  - deepseek:mock-flash\ndefaultTest:\n  assert:\n    - type: icontains\n      value: reply\ntests:\n  - vars:\n      input: ["a", "b"]\n      persona: ["pirate", "robot"]\n    assert:\n      - type: contains\n        value: "as"\n  - file://tests.csv\n`,
    );
    const r = await c.callTool({ name: "evaluate_prompt_preview", arguments: { configPath: join(DATA, "promptfooconfig.yaml") } });
    const t = text(r);
    assert.equal(r.isError, undefined, t);
    assert.match(t, /1 variant\(s\) × 1 model\(s\) × 6 case\(s\)/);
    assert.match(t, /Reply to a as robot/);
    assert.match(t, /### 5\. greet/);
    assert.match(t, /✅ `contains` contains "hello"/);
  }));

// ───────────── DSPy-style auto optimization ─────────────
await test("auto_optimize_prompt: reflect finds the fix, dev score improves, scoreboard + report + history", () =>
  withServer(llmEnv, async (c) => {
    llm.reset();
    const r = await c.callTool({
      name: "auto_optimize_prompt",
      arguments: {
        prompt: "# Role: Helper\n\n## Rules\n1. Be brief.",
        testCases: [{ input: "one" }, { input: "two" }, { input: "three" }, { input: "four" }],
        assert: [{ type: "contains", value: "DONE" }],
        budget: "light",
        strategies: ["reflect", "fewshot"],
      },
    });
    const t = text(r);
    assert.equal(r.isError, undefined, t);
    const s = sc(r);
    assert.equal(s.baselineDevScore, 0);
    assert.equal(s.bestDevScore, 1);
    assert.equal(s.bestStrategy, "reflect");
    assert.match(s.bestPrompt, /Always end with DONE/);
    assert.match(t, /Dev score 0\.00 \(0%\) → 1\.00 \(100%\)/);
    assert.match(t, /\| c1 ⭐ \| 1 \| reflect/);
    assert.ok(llm.calls.includes("reflect:mock-flash"));
    assert.ok(existsSync(s.reportPaths.md));
    const h = await c.callTool({ name: "prompt_history", arguments: { action: "get", id: s.historyId } });
    assert.match(text(h), /c1 reflect \(accepted\)/);
    const list = await c.callTool({ name: "prompt_history", arguments: {} });
    assert.match(text(list), /auto-optimize/);
  }));

await test("auto_optimize_prompt: generated cases with criteria, budget scaling, never-worse guarantee", () =>
  withServer(llmEnv, async (c) => {
    const r = await c.callTool({ name: "auto_optimize_prompt", arguments: { prompt: "You are a helper. Always end with DONE.", numCases: 4, budget: "medium", maxCalls: 30, strategies: ["template"] } });
    const t = text(r);
    assert.equal(r.isError, undefined, t);
    assert.match(t, /Generated 4 test cases/);
    assert.match(t, /Scaled the search down/);
    assert.ok(sc(r).usage.calls <= 30);
    assert.ok(sc(r).bestDevScore >= sc(r).baselineDevScore);
  }));

// ───────────── upstream prompt-optimizer (optional backend) ─────────────
await test("Docker upstream: Basic auth detected, remote optimization + LangGPT repair", () =>
  upstreamCase("docker", "secret", (url) =>
    withServer({ PO_BASE_URL: url, PO_ACCESS_PASSWORD: "secret" }, async (c) => {
      const st = text(await c.callTool({ name: "optimizer_connection_status", arguments: {} }));
      assert.match(st, /Auth: ✅ basic/);
      assert.match(st, /Upstream MCP: ✅/);
      const r = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "You are a helpful assistant", rounds: 2 } });
      assert.equal(r.isError, undefined, text(r));
      assert.equal(sc(r).backend, "remote");
      assert.match(sc(r).final, /^# Role: Optimized Assistant/);
      assert.match(sc(r).final, /## Initialization/);
    }),
  ));

await test("Upstream restart (session lost) → transparent reconnect", () =>
  upstreamCase("docker", "secret", (url, _s, drop) =>
    withServer({ PO_BASE_URL: url, PO_ACCESS_PASSWORD: "secret" }, async (c) => {
      assert.equal((await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "one", rounds: 1, enforceLangGPT: false } })).isError, undefined);
      drop();
      const r2 = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "two", rounds: 1, enforceLangGPT: false } });
      assert.equal(r2.isError, undefined, text(r2));
    }),
  ));

await test("Wrong passwords surface AuthError (Docker Basic + Vercel cookie)", async () => {
  await upstreamCase("docker", "secret", (url) =>
    withServer({ PO_BASE_URL: url, PO_ACCESS_PASSWORD: "wrong", ...llmEnv }, async (c) => {
      const r = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "x" } });
      assert.equal(r.isError, true);
      assert.match(text(r), /HTTP Basic auth rejected/);
    }),
  );
  await upstreamCase("vercel", "secret", (url) =>
    withServer({ PO_BASE_URL: url, PO_ACCESS_PASSWORD: "nope", ...llmEnv }, async (c) => {
      const r = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "draft" } });
      assert.match(text(r), /Invalid password/);
    }),
  );
});

await test("Vercel + /mcp cookie login; Vercel static falls back to local; PO_BACKEND=local skips upstream", async () => {
  await upstreamCase("vercel-mcp", "secret", (url, stats) =>
    withServer({ PO_BASE_URL: url, PO_ACCESS_PASSWORD: "secret" }, async (c) => {
      const r = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "draft", rounds: 1 } });
      assert.equal(sc(r).authMode, "vercel-cookie");
      assert.equal(sc(r).backend, "remote");
      assert.ok(stats.authCalls >= 1);
    }),
  );
  await upstreamCase("vercel", "secret", (url) =>
    withServer({ PO_BASE_URL: url, PO_ACCESS_PASSWORD: "secret", ...llmEnv }, async (c) => {
      const r = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "draft", rounds: 2, requirements: "be concise" } });
      assert.equal(sc(r).backend, "local");
      assert.match(sc(r).notes.join(" "), /HTML page instead of an MCP response/);
      assert.match(sc(r).final, /revised/);
    }),
  );
  await upstreamCase("vercel", "secret", (url, stats) =>
    withServer({ PO_BASE_URL: url, PO_ACCESS_PASSWORD: "secret", PO_BACKEND: "local", ...llmEnv }, async (c) => {
      const r = await c.callTool({ name: "optimize_prompt_via_api", arguments: { prompt: "draft", rounds: 1 } });
      assert.equal(sc(r).backend, "local");
      assert.equal(sc(r).notes.length, 0);
      assert.equal(stats.authCalls, 0);
      assert.equal(stats.mcpCalls, 0);
    }),
  );
});

await test("suggest_prompts: candidates + live previews + budget + no-LLM fallback", async () => {
  await withServer(llmEnv, async (c) => {
    llm.reset();
    const r = await c.callTool({ name: "suggest_prompts", arguments: { topic: "帮我准备香港量化面试", count: 4 } });
    assert.ok(!r.isError, text(r));
    const cands = sc(r).candidates as Array<{ archetype: string; prompt: string; preview?: string; expectedEffect: string }>;
    assert.deepEqual(cands.map((x) => x.archetype), ["concise", "langgpt", "coach", "strict"]);
    assert.ok(cands.every((x) => x.preview && x.prompt.length > 20));
    assert.match(cands[1]!.prompt, /## Initialization/);
    assert.match(text(r), /选 2|选择/);
    assert.equal(llm.calls.filter((x) => x.startsWith("suggest-design")).length, 1);
    assert.equal(llm.calls.filter((x) => x.startsWith("eval-run")).length, 4);
    const r2 = await c.callTool({ name: "suggest_prompts", arguments: { topic: "write release notes", count: 2, preview: false } });
    assert.equal((sc(r2).candidates as unknown[]).length, 2);
    assert.ok(!(sc(r2).candidates as Array<{ preview?: string }>).some((x) => x.preview));
  });
  await withServer({}, async (c) => {
    const r = await c.callTool({ name: "suggest_prompts", arguments: { topic: "写周报", count: 3 } });
    assert.ok(!r.isError, text(r));
    assert.equal(sc(r).strategy, "template");
    assert.equal((sc(r).candidates as unknown[]).length, 3);
  });
});

await llm.close();
console.log(`\n${passed} test group(s) passed${process.exitCode ? " — SOME FAILED" : ""}`);
