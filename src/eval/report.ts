/** Markdown (for the chat), self-contained HTML and JSON reports for eval runs. */
import { truncate } from "../utils/text.js";
import type { EvalPlan, EvalResult } from "./runner.js";
import { caseInput } from "./runner.js";
import type { StaticReview } from "./staticReview.js";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function evalMarkdown(plan: EvalPlan, r: EvalResult, reviews: StaticReview[], opts: { maxOutputChars: number; usage: string; reportPaths?: Record<string, string>; extraNotes: string[] }): string {
  const L: string[] = [];
  const multiModel = plan.models.length > 1;
  L.push(`# Prompt eval — ${plan.prompts.length} variant(s) × ${plan.models.length} model(s) × ${plan.cases.length} case(s)${plan.repeat > 1 ? ` × ${plan.repeat} repeats` : ""}`);
  for (const n of [...opts.extraNotes, ...r.notes]) L.push(`> ${n}`);
  L.push("", `| Variant${multiModel ? " | Model" : ""} | Pass rate | Score | Latency avg / p95 | Tokens in/out | Cost | Static |${plan.repeat > 1 ? " Consistency |" : ""}`);
  L.push(`|---${multiModel ? "|---" : ""}|---|---|---|---|---|---|${plan.repeat > 1 ? "---|" : ""}`);
  for (const s of r.summaries) {
    const lat = s.avgLatencyMs !== undefined ? `${Math.round(s.avgLatencyMs)} / ${Math.round(s.p95LatencyMs ?? 0)} ms` : "cached";
    const cost = s.costUsd !== undefined ? `$${s.costUsd.toFixed(4)}` : "—";
    const rv = reviews[s.promptIndex];
    L.push(
      `| ${s.label}${multiModel ? ` | ${s.model}` : ""} | ${pct(s.passRate)}${s.errors ? ` (${s.errors} err)` : ""} | ${s.avgScore.toFixed(2)} | ${lat} | ${s.promptTokens}/${s.completionTokens} | ${cost} | ${rv.score}/100 |${plan.repeat > 1 ? ` ${s.consistency !== undefined ? pct(s.consistency) : "—"} |` : ""}`,
    );
  }
  if (r.winner) L.push("", `**Winner:** ${r.winner === "tie" ? "tie" : plan.prompts.length > 1 ? `${r.winner.label}${multiModel ? ` (best on ${r.winner.model})` : ""}` : `model ${r.winner.model}`}`);
  for (const p of r.pairwise) L.push(`**Pairwise judge${multiModel ? ` (${p.model})` : ""}:** ${plan.prompts[0].label} wins ${p.winsA} · ${plan.prompts[1].label} wins ${p.winsB} · ties ${p.ties}`);

  const metricKeys = [...new Set(r.summaries.flatMap((s) => Object.keys(s.metrics)))];
  if (metricKeys.length) {
    L.push("", `| Metric | ${r.summaries.map((s) => `${s.label}${multiModel ? `@${s.model}` : ""}`).join(" | ")} |`, `|---|${r.summaries.map(() => "---").join("|")}|`);
    for (const k of metricKeys) L.push(`| ${k} | ${r.summaries.map((s) => (s.metrics[k] !== undefined ? s.metrics[k].toFixed(2) : "—")).join(" | ")} |`);
  }

  reviews.forEach((rv, i) => {
    if (rv.suggestions.length) L.push("", `**Static review ${plan.prompts[i].label}:** ${rv.suggestions.join(" · ")}`);
  });

  // Details: first repeat only, keep chat output compact
  L.push("", "## Cases");
  plan.cases.forEach((tc, c) => {
    L.push("", `### ${c + 1}. ${tc.description ?? truncate(caseInput(tc) || JSON.stringify(tc.vars), 60)}`);
    if (caseInput(tc)) L.push(`**Input:** ${truncate(caseInput(tc), 300)}`);
    for (const row of r.rows.filter((x) => x.caseIndex === c && x.repeat === 0)) {
      const head = `**${plan.prompts[row.promptIndex].label}${multiModel ? ` @ ${row.model}` : ""}** ${row.error ? "❌" : row.pass ? "✅" : "❌"} score ${row.score.toFixed(2)}${row.cached ? " (cached)" : ` · ${row.latencyMs} ms`}`;
      L.push("", head);
      if (row.error) {
        L.push(`> ${row.error}`);
        continue;
      }
      L.push("```text", truncate(row.output, opts.maxOutputChars), "```");
      for (const a of row.assertions) L.push(`- ${a.pass ? "✅" : "❌"} \`${a.type}\`${a.metric ? ` [${a.metric}]` : ""} ${a.score < 1 && a.score > 0 ? `(${a.score.toFixed(2)}) ` : ""}${a.reason}`);
    }
  });
  L.push("", `---`, `**Usage:** ${opts.usage}`);
  if (opts.reportPaths) L.push(`**Report:** ${Object.values(opts.reportPaths).join(" · ")}`);
  return L.join("\n");
}

export function evalHtml(plan: EvalPlan, r: EvalResult, reviews: StaticReview[], title: string, usage: string): string {
  const multiModel = plan.models.length > 1;
  const summaryRows = r.summaries
    .map(
      (s) =>
        `<tr><td>${esc(s.label)}</td>${multiModel ? `<td>${esc(s.model)}</td>` : ""}<td class="num">${pct(s.passRate)}</td><td class="num">${s.avgScore.toFixed(2)}</td><td class="num">${s.avgLatencyMs !== undefined ? Math.round(s.avgLatencyMs) + " ms" : "cached"}</td><td class="num">${s.promptTokens}/${s.completionTokens}</td><td class="num">${s.costUsd !== undefined ? "$" + s.costUsd.toFixed(4) : "—"}</td><td class="num">${reviews[s.promptIndex].score}</td></tr>`,
    )
    .join("");
  const header = plan.prompts.flatMap((p) => plan.models.map((m) => `<th>${esc(p.label)}${multiModel ? `<br><small>${esc(m)}</small>` : ""}</th>`)).join("");
  const body = plan.cases
    .map((tc, c) => {
      const cells = plan.prompts
        .flatMap((_, p) =>
          plan.models.map((m) => {
            const reps = r.rows.filter((x) => x.caseIndex === c && x.promptIndex === p && x.model === m);
            return `<td>${reps
              .map((row) => {
                if (row.error) return `<div class="bad">${esc(row.error)}</div>`;
                const asserts = row.assertions.map((a) => `<li class="${a.pass ? "ok" : "bad"}">${a.pass ? "✓" : "✗"} <code>${esc(a.type)}</code> ${esc(a.reason)}</li>`).join("");
                return `<div class="cell ${row.pass ? "pass" : "fail"}"><div class="meta">${row.pass ? "PASS" : "FAIL"} · ${row.score.toFixed(2)}${plan.repeat > 1 ? ` · rep ${row.repeat + 1}` : ""}${row.cached ? " · cached" : ` · ${row.latencyMs} ms`}</div><details><summary>${esc(truncate(row.output, 140))}</summary><pre>${esc(row.output)}</pre></details><ul>${asserts}</ul></div>`;
              })
              .join("")}</td>`;
          }),
        )
        .join("");
      return `<tr><th class="case">${esc(tc.description ?? `Case ${c + 1}`)}<pre>${esc(truncate(caseInput(tc) || JSON.stringify(tc.vars), 600))}</pre></th>${cells}</tr>`;
    })
    .join("");
  const prompts = plan.prompts.map((p) => `<details><summary>${esc(p.label)}</summary><pre>${esc(p.text)}</pre></details>`).join("");
  const pair = r.pairwise.map((p) => `<p><b>Pairwise${multiModel ? ` (${esc(p.model)})` : ""}:</b> ${esc(plan.prompts[0].label)} ${p.winsA} · ${esc(plan.prompts[1].label)} ${p.winsB} · ties ${p.ties}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--ok:#15803d;--bad:#b91c1c;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--ok:#4ade80;--bad:#f87171;--card:#292524}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin-bottom:16px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border:1px solid var(--line);padding:8px;vertical-align:top;text-align:left}
td.num{text-align:right;font-variant-numeric:tabular-nums}th.case{min-width:220px;max-width:320px}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:6px 0}
.cell{margin-bottom:8px}.pass .meta{color:var(--ok);font-weight:600}.fail .meta{color:var(--bad);font-weight:600}ul{margin:4px 0;padding-left:18px}li.ok{color:var(--ok)}li.bad{color:var(--bad)}
details summary{cursor:pointer;color:var(--fg)}section{margin:20px 0}
</style></head><body>
<h1>${esc(title)}</h1><div class="sub">${esc(usage)}${r.winner ? ` · Winner: ${r.winner === "tie" ? "tie" : esc(r.winner.label + (multiModel ? " @ " + r.winner.model : ""))}` : ""}</div>
<section class="wrap"><table><thead><tr><th>Variant</th>${multiModel ? "<th>Model</th>" : ""}<th>Pass</th><th>Score</th><th>Latency</th><th>Tokens</th><th>Cost</th><th>Static</th></tr></thead><tbody>${summaryRows}</tbody></table>${pair}</section>
<section><h2>Prompts</h2>${prompts}</section>
<section class="wrap"><h2>Results</h2><table><thead><tr><th>Case</th>${header}</tr></thead><tbody>${body}</tbody></table></section>
</body></html>`;
}
