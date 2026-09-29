/**
 * Offline mocks that faithfully replicate the upstream behaviours we depend on:
 *  - Vercel: api/auth.js + middleware.js (cookie == password, HTML login page for unauthenticated requests)
 *  - Docker: nginx Basic auth everywhere except /mcp and /healthz
 *  - prompt-optimizer MCP tools (optimize-user-prompt / optimize-system-prompt / iterate-prompt)
 *  - OpenAI-compatible /v1/chat/completions
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const html = (res: ServerResponse, body: string) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
};

function buildUpstreamMcp() {
  const s = new McpServer({ name: "prompt-optimizer-mcp-server", version: "0.1.0" });
  s.registerTool(
    "optimize-user-prompt",
    { inputSchema: { prompt: z.string(), template: z.enum(["user-prompt-basic", "user-prompt-professional"]).optional() } },
    async ({ prompt }) => ({ content: [{ type: "text", text: `Please do the following, with explicit context and output format:\n${prompt}` }] }),
  );
  s.registerTool(
    "optimize-system-prompt",
    { inputSchema: { prompt: z.string(), template: z.enum(["general-optimize", "output-format-optimize"]).optional() } },
    async ({ prompt }) => ({
      // deliberately fenced and missing "## Initialization" to exercise fence stripping + LangGPT repair
      content: [
        {
          type: "text",
          text: `\`\`\`markdown\n# Role: Optimized Assistant\n\n## Profile\n- language: English\n- description: ${prompt}\n\n## Goals\n- Help precisely\n\n## Constraints\n- Never fabricate\n- Ask when unclear\n- Use Markdown\n\n## Skills\n- Analysis\n\n## Workflow\n1. Understand\n2. Answer\n\`\`\``,
        },
      ],
    }),
  );
  s.registerTool(
    "iterate-prompt",
    { inputSchema: { prompt: z.string(), requirements: z.string(), template: z.enum(["iterate"]).optional() } },
    async ({ prompt, requirements }) => {
      let out = prompt;
      for (const m of requirements.matchAll(/"## (\w+)"/g)) if (!new RegExp(`^## ${m[1]}`, "m").test(out)) out += `\n\n## ${m[1]}\nAdded by iterate-prompt.`;
      out += `\n<!-- iterated -->`;
      return { content: [{ type: "text", text: out }] };
    },
  );
  return s;
}

export type UpstreamMode = "vercel" | "vercel-mcp" | "docker";

export async function startUpstream(mode: UpstreamMode, password: string | undefined, username = "admin") {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const stats = { authCalls: 0, mcpCalls: 0 };

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    stats.mcpCalls++;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const raw = req.method === "POST" ? await readBody(req) : "";
    const body = raw ? JSON.parse(raw) : undefined;
    let t: StreamableHTTPServerTransport | undefined = sid ? transports[sid] : undefined;
    if (!t) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null });
      }
      const nt = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => (transports[id] = nt) });
      t = nt;
      await buildUpstreamMcp().connect(nt);
    }
    await t.handleRequest(req, res, body);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (mode === "docker") {
        if (url.pathname === "/mcp") return handleMcp(req, res);
        if (password) {
          const expected = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
          if (req.headers.authorization !== expected) {
            res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Please enter your credentials"', "Content-Type": "text/html" });
            return res.end("<html>401 Authorization Required</html>");
          }
        }
        if (req.method === "POST") {
          res.writeHead(405, { "Content-Type": "text/html" });
          return res.end("<html>405 Not Allowed</html>");
        }
        return html(res, "<html><body>SPA</body></html>");
      }

      // ---- Vercel ----
      if (url.pathname === "/api/auth") {
        stats.authCalls++;
        if (!password) return json(res, 200, { success: true, message: "No password protection configured" });
        if (req.method === "POST") {
          const { password: pw, action } = JSON.parse((await readBody(req)) || "{}");
          if (action === "verify") {
            if (pw === password) {
              return json(res, 200, { success: true, message: "Authentication successful" }, {
                "Set-Cookie": [`vercel_access_token=${password}; HttpOnly; Path=/; Max-Age=604800; SameSite=Strict`],
              });
            }
            return json(res, 401, { success: false, message: "Invalid password" });
          }
        }
        return json(res, 405, { error: "Method not allowed" });
      }
      if (password) {
        const cookie = (req.headers.cookie ?? "").split(";").find((c) => c.trim().startsWith("vercel_access_token="));
        if (!cookie || cookie.split("=")[1] !== password) return html(res, "<html><title>Access Verification - Prompt Optimizer</title></html>");
      }
      if (mode === "vercel-mcp" && url.pathname === "/mcp") return handleMcp(req, res);
      return html(res, "<!doctype html><div id=app></div>"); // SPA rewrite → index.html
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const dropSessions = () => { for (const k of Object.keys(transports)) delete transports[k]; };
  return { url: `http://127.0.0.1:${port}`, stats, dropSessions, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function evidenceOf(user: string): Record<string, string> {
  const m = user.match(/```json\n([\s\S]*?)\n```/);
  try {
    return m ? JSON.parse(m[1]) : {};
  } catch {
    return {};
  }
}

const LANGGPT_DOC = (desc: string, extra = "") =>
  `# Role: Local Optimized\n\n## Profile\n- Language: English\n- Description: ${desc}\n\n## Goal\n- Outcome: help\n\n## Skills\n### Skill-1: s\n1. s\n\n## Rules\n1. c\n\n## Workflow\n1. w\n\n## OutputFormat\nMarkdown\n${extra}\n## Initialization\nAs <Role>, follow <Rules> in <Language>.`;

export async function startMockLlm(apiKey = "test-key") {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") return json(res, 404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${apiKey}`) return json(res, 401, { error: { message: "bad key" } });
    const body = JSON.parse(await readBody(req));
    const sys: string = body.messages.find((m: { role: string }) => m.role === "system")?.content ?? "";
    const user: string = body.messages.filter((m: { role: string }) => m.role === "user").at(-1)?.content ?? "";
    const ev = evidenceOf(user);
    let content: string;
    const tag = (t: string) => calls.push(`${t}:${body.model}`);
    if (sys.includes("LangGPT prompt architect")) {
      tag("expand");
      content = JSON.stringify({
        role: "Quant Research Report Reviewer",
        profile: { author: "Liao", version: "1.0", language: "English", description: "Reviews quant research reports" },
        background: "Buy-side research QA.",
        goal: { outcome: "A prioritized issue list", doneCriteria: ["Every issue cites a section"], nonGoals: ["Rewriting the report"] },
        skills: [{ name: "Backtest auditing", items: ["Detect look-ahead bias"] }, { name: "Statistics", items: ["Check significance"] }],
        constraints: ["Cite the exact section for every issue", "Never invent numbers"],
        workflow: ["Read report", "Audit data", "Audit methodology", "Summarize issues"],
        outputFormat: "Markdown table: Issue | Severity | Section | Fix",
        examples: [],
        initialization: "As <Role>, you must follow <Rules> and talk in <Language>.",
      });
    } else if (sys.includes("Prompt Candidate Designer")) {
      tag("suggest-design");
      const kinds = (sys.match(/in this order: ([^\n.]+)/)?.[1] ?? "concise").split(",").map((x) => x.trim());
      content = JSON.stringify({ sampleInput: "Help me plan my first week.", candidates: kinds.map((k) => ({ archetype: k, expectedEffect: `Effect of ${k}: does X, trade-off Y.`, prompt: `You are a ${k} assistant for the topic. Follow the ${k} style and never invent facts.` })) });
    } else if (sys.includes("Prompt Design Reviewer")) {
      tag("analyze");
      const wp = ev.workspacePrompt ?? "";
      content = JSON.stringify({
        score: { overall: 62, dimensions: ["goalClarity", "instructionCompleteness", "structuralExecutability", "ambiguityControl", "robustness"].map((k, i) => ({ key: k, score: 50 + i * 5, comment: `c${i}` })) },
        strengths: ["short"], issues: ["no output format"], improvements: ["add output format"],
        patchPlan: [{ oldText: wp.slice(0, 12), newText: `${wp.slice(0, 12)} [PATCHED]`, instruction: "clarify role" }, { oldText: "NOT-IN-PROMPT", newText: "x", instruction: "bogus" }],
        summary: "usable with gaps",
      });
    } else if (sys.includes("Prompt Revision Editor")) {
      tag(ev.workspacePrompt !== undefined ? "rewrite" : "iterate");
      let out = ev.lastOptimizedPrompt ?? ev.workspacePrompt ?? "";
      const reqs = ev.requirements ?? "";
      for (const m of reqs.matchAll(/\{\{(\w+)\}\}/g)) if (!out.includes(`{{${m[1]}}}`)) out += `\nUses {{${m[1]}}}.`;
      for (const m of reqs.matchAll(/"## (\w+)"/g)) if (!new RegExp(`^## ${m[1]}`, "m").test(out)) out += `\n\n## ${m[1]}\nAdded.`;
      if (reqs.includes("Always end with DONE") && !out.includes("Always end with DONE")) out = out.replace("## Rules\n", "## Rules\n0. Always end with DONE.\n") + (out.includes("## Rules") ? "" : "\nAlways end with DONE.");
      content = `${out}\n<!-- revised -->`;
    } else if (/Senior Prompt Architect|Prompt Engineer|Request Clarifier|Brief Writer|Task Planner|House Style/.test(sys)) {
      tag(`optimize:${sys.match(/# Role: ([^\n]+)/)?.[1] ?? "?"}`);
      const src = ev.originalPrompt ?? "";
      const keep = [...src.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((p) => p !== "drop_me");
      content = "```markdown\n" + LANGGPT_DOC(src.split("\n")[0].replace(/\{\{\w+\}\}/g, "").slice(0, 80), keep.map((k) => `Context: {{${k}}}\n`).join("")) + "\n```";
    } else if (sys.includes("Prompt Failure Analyst")) {
      tag("reflect");
      content = JSON.stringify({ diagnosis: ["responses never terminate with the required marker"], changes: ["Always end with DONE."] });
    } else if (sys.includes("Strict Output Grader")) {
      tag("grade");
      const good = (ev.output ?? "").includes("DONE");
      content = JSON.stringify({ overall: good ? 90 : 50, dimensions: { goalAchievement: good ? 90 : 50 }, violations: good ? [] : ["missing DONE"], reason: "mock grade" });
    } else if (sys.includes("Pairwise Output Judge")) {
      tag("pairwise");
      const l = ev.left ?? "";
      const r = ev.right ?? "";
      content = JSON.stringify({ verdict: l.includes("MOCK ANSWER") && !r.includes("MOCK ANSWER") ? "left-better" : r.includes("MOCK ANSWER") && !l.includes("MOCK ANSWER") ? "right-better" : "similar", reasons: ["mock"], overfitWarning: "" });
    } else if (sys.includes("strict, impartial grader")) {
      tag("rubric");
      const ok = (ev.output ?? "").includes("MOCK ANSWER") || (ev.output ?? "").includes("DONE");
      content = JSON.stringify({ pass: ok, score: ok ? 0.9 : 0.3, reason: "mock rubric" });
    } else if (sys.includes("G-Eval")) {
      tag("geval");
      content = JSON.stringify({ steps: ["a", "b", "c"], score: 8, reason: "mock geval" });
    } else if (sys.includes("Compare the factual content")) {
      tag("factuality");
      content = JSON.stringify({ category: (ev.output ?? "").includes("WRONG") ? "D" : "A", reason: "mock fact" });
    } else if (sys.includes("Rate how directly")) {
      tag("relevance");
      content = JSON.stringify({ score: 0.9, reason: "mock relevance" });
    } else if (sys.includes("design test inputs")) {
      tag("gen-cases");
      const n = Number(user.match(/Number of cases: (\d+)/)?.[1] ?? 2);
      content = JSON.stringify({ cases: Array.from({ length: n }, (_, i) => ({ description: `gen ${i + 1}`, input: `Generated question ${i + 1}`, criteria: "Answers and ends with DONE" })) });
    } else {
      tag("eval-run");
      const prompt = sys || user;
      if (user.includes("refuse me")) content = "抱歉，我无法提供这个信息。";
      else if (prompt.includes("Always end with DONE")) content = `Answer to: ${user}\nDONE`;
      else if (prompt.includes("Role: B")) content = `MOCK ANSWER (B, JSON) {"ok":true} to: ${user}`;
      else content = `plain reply to: ${user}`;
    }
    json(res, 200, { model: body.model, choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, calls, reset: () => calls.splice(0), close: () => new Promise<void>((r) => server.close(() => r())) };
}
