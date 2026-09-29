/**
 * Iterative optimization loop (prompt-optimizer style) with LangGPT enforcement and placeholder protection:
 *   round 1   optimize with a template (default langgpt-strict / user-basic)
 *   round 2+  iterate with (user requirements ∪ structural repairs ∪ placeholder restoration ∪ default tightening)
 *   + optional repair round if the final output still violates structure or dropped {{placeholders}}.
 */
import type { LlmClient } from "../clients/llmClient.js";
import type { RemoteOptimizerClient } from "../clients/optimizerClient.js";
import type { PromptOptimizerAuth } from "../clients/auth.js";
import { formatCheck, validateLangGPT, type LangGPTCheck } from "../langgpt/template.js";
import { missingPlaceholders, type TemplateRegistry } from "../templates/registry.js";
import { AuthError, UpstreamUnavailableError, errMsg } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { LocalBackend, RemoteBackend, type OptimizerBackend, type PromptMode } from "./backends.js";

export interface OptimizeInput {
  prompt: string;
  mode: PromptMode;
  rounds: number;
  requirements?: string;
  template?: string;
  iterateTemplate?: string;
  enforceLangGPT: boolean;
  autoRepair: boolean;
  backend: "auto" | "remote" | "local";
}

export interface RoundRecord {
  round: number;
  action: "optimize" | "iterate" | "repair";
  template: string;
  requirements?: string;
  output: string;
  langgpt?: LangGPTCheck;
  missingPlaceholders: string[];
  ms: number;
}

export interface OptimizeResult {
  final: string;
  backend: "remote" | "local";
  authMode: string;
  rounds: RoundRecord[];
  notes: string[];
}

export interface PipelineDeps {
  remote: RemoteOptimizerClient;
  auth: PromptOptimizerAuth;
  llm: LlmClient;
  templates: TemplateRegistry;
}

export async function selectBackend(pref: OptimizeInput["backend"], deps: PipelineDeps, notes: string[]): Promise<OptimizerBackend> {
  const local = () => new LocalBackend(deps.llm, deps.templates);
  if (pref === "local") {
    if (!deps.llm.available) throw new Error("backend=local requires LLM_API_KEY (or a local LLM_BASE_URL)");
    return local();
  }
  if (!deps.remote.mcpUrl) {
    if (pref === "remote") throw new UpstreamUnavailableError("backend=remote but PO_BASE_URL / PO_MCP_URL is not set");
    if (deps.llm.available) return local();
    throw new Error("Nothing to optimize with: set LLM_API_KEY (or PO_BASE_URL for a prompt-optimizer Docker deployment).");
  }
  const avail = await deps.remote.checkAvailability();
  if (avail.ok) return new RemoteBackend(deps.remote);
  if (pref === "remote") throw new UpstreamUnavailableError(`Upstream prompt-optimizer MCP unavailable: ${avail.reason}`);
  if (!deps.llm.available) throw new UpstreamUnavailableError(`Upstream prompt-optimizer MCP unavailable (${avail.reason}) and no LLM_API_KEY configured.`);
  notes.push(`Upstream MCP unavailable (${avail.reason}) — used the local template library with ${deps.llm.model}. Set PO_BACKEND=local to skip this check.`);
  return local();
}

function buildRequirements(user: string | undefined, check: LangGPTCheck | undefined, missing: string[]): string {
  const parts: string[] = [];
  if (user?.trim()) parts.push(user.trim());
  if (missing.length) parts.push(`Restore these placeholders exactly as written (they were lost): ${missing.map((m) => `{{${m}}}`).join(", ")}.`);
  if (check && !check.valid) {
    const fix = [...check.missing, ...check.emptySections];
    parts.push(`Restore the LangGPT structure: ${fix.map((s) => (s === "Role" ? '"# Role: <name>" as the first heading' : `a non-empty "## ${s}" section`)).join(", ")}. Keep every existing section and requirement.`);
  }
  if (check?.danglingRefs.length) parts.push(`These references point to sections that don't exist: ${check.danglingRefs.map((r) => `<${r}>`).join(", ")} — add the section or fix the reference.`);
  if (!parts.length) {
    parts.push("Tighten the prompt: remove ambiguity, make every rule specific and testable, make the workflow explicit step by step (including what to do when information is missing), and specify the exact output format. Keep the structure intact.");
  }
  return parts.map((p, i) => `${i + 1}. ${p}`).join("\n");
}

export async function runOptimization(input: OptimizeInput, deps: PipelineDeps): Promise<OptimizeResult> {
  const notes: string[] = [];
  const backend = await selectBackend(input.backend, deps, notes);
  if (backend.name === "remote" && input.template && (await deps.templates.has(input.template))) {
    notes.push(`Template "${input.template}" is a local template; the upstream deployment uses its own template ids, so it was ignored.`);
    input = { ...input, template: undefined, iterateTemplate: undefined };
  }
  const rounds: RoundRecord[] = [];
  const check = (s: string) => (input.enforceLangGPT ? validateLangGPT(s) : undefined);
  const record = (round: number, action: RoundRecord["action"], r: { text: string; template: string }, ms: number, requirements?: string) =>
    rounds.push({ round, action, template: r.template, requirements, output: r.text, langgpt: check(r.text), missingPlaceholders: missingPlaceholders(input.prompt, r.text), ms });

  try {
    let t = Date.now();
    let res = await backend.optimize(input.prompt, input.mode, { template: input.template, enforceLangGPT: input.enforceLangGPT });
    record(1, "optimize", res, Date.now() - t);

    for (let r = 2; r <= input.rounds; r++) {
      const last = rounds.at(-1)!;
      const requirements = buildRequirements(input.requirements, last.langgpt, last.missingPlaceholders);
      t = Date.now();
      res = await backend.iterate({ original: input.prompt, last: last.output, requirements, template: input.iterateTemplate });
      record(r, "iterate", res, Date.now() - t, requirements);
    }

    const last = rounds.at(-1)!;
    const needsRepair = (last.langgpt && (!last.langgpt.valid || last.langgpt.danglingRefs.length > 0)) || last.missingPlaceholders.length > 0;
    if (input.autoRepair && needsRepair) {
      const requirements = buildRequirements(undefined, last.langgpt, last.missingPlaceholders);
      t = Date.now();
      res = await backend.iterate({ original: input.prompt, last: last.output, requirements, template: input.iterateTemplate });
      record(rounds.length + 1, "repair", res, Date.now() - t, requirements);
    }
  } catch (e) {
    if (e instanceof AuthError || !rounds.length) throw e;
    notes.push(`Stopped after round ${rounds.length}: ${errMsg(e)}`);
    log.warn(`Optimization aborted mid-way: ${errMsg(e)}`);
  }

  const final = rounds.at(-1)!;
  if (final.missingPlaceholders.length) notes.push(`⚠️ Final prompt is still missing placeholders: ${final.missingPlaceholders.map((m) => `{{${m}}}`).join(", ")}`);
  return { final: final.output, backend: backend.name, authMode: backend.name === "local" ? "n/a (local)" : deps.auth.current?.mode ?? "none", rounds, notes };
}

export function formatOptimizeReport(r: OptimizeResult, showHistory: boolean, footer: string[]): string {
  const lines = [
    `**Backend:** ${r.backend === "remote" ? "prompt-optimizer upstream MCP" : "local template library"} · **Template:** ${r.rounds[0]?.template} · **Rounds:** ${r.rounds.length}`,
  ];
  const lastCheck = r.rounds.at(-1)?.langgpt;
  if (lastCheck) lines.push(formatCheck(lastCheck));
  for (const n of r.notes) lines.push(`> ${n}`);
  lines.push("", "## Optimized prompt", "", r.final);
  if (showHistory && r.rounds.length > 1) {
    lines.push("", "---", "## Iteration history");
    for (const rd of r.rounds) {
      lines.push("", `### Round ${rd.round} — ${rd.action} · ${rd.template} (${(rd.ms / 1000).toFixed(1)}s)${rd.langgpt ? ` · LangGPT ${rd.langgpt.score}` : ""}`);
      if (rd.requirements) lines.push("", "Requirements sent:", rd.requirements);
      if (rd.round < r.rounds.length) lines.push("", "<details><summary>output</summary>", "", rd.output, "", "</details>");
    }
  }
  if (footer.length) lines.push("", "---", ...footer);
  return lines.join("\n");
}
