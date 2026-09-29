import type { LlmClient } from "../clients/llmClient.js";
import type { RemoteOptimizerClient } from "../clients/optimizerClient.js";
import { renderTemplate, type TemplateRegistry } from "../templates/registry.js";
import { stripCodeFence } from "../utils/text.js";

export type PromptMode = "system" | "user";

export interface OptimizerBackend {
  readonly name: "remote" | "local";
  optimize(prompt: string, mode: PromptMode, opts: { template?: string; enforceLangGPT: boolean }): Promise<{ text: string; template: string }>;
  iterate(args: { original: string; last: string; requirements: string; template?: string }): Promise<{ text: string; template: string }>;
}

/** Delegates to prompt-optimizer's own MCP tools (only when a Docker deployment is configured). */
export class RemoteBackend implements OptimizerBackend {
  readonly name = "remote" as const;
  constructor(private readonly client: RemoteOptimizerClient) {}

  async optimize(prompt: string, mode: PromptMode, opts: { template?: string }) {
    const tool = mode === "system" ? "optimize-system-prompt" : "optimize-user-prompt";
    return { text: stripCodeFence(await this.client.callTool(tool, { prompt, template: opts.template ?? "" })), template: opts.template ?? "upstream-default" };
  }

  async iterate(args: { last: string; requirements: string; template?: string }) {
    return { text: stripCodeFence(await this.client.callTool("iterate-prompt", { prompt: args.last, requirements: args.requirements, template: args.template ?? "" })), template: args.template ?? "upstream-iterate" };
  }
}

/** Local template library executed against any OpenAI-compatible model (DeepSeek by default). */
export class LocalBackend implements OptimizerBackend {
  readonly name = "local" as const;
  constructor(
    private readonly llm: LlmClient,
    private readonly templates: TemplateRegistry,
  ) {}

  async optimize(prompt: string, mode: PromptMode, opts: { template?: string; enforceLangGPT: boolean }) {
    const type = mode === "system" ? "optimize-system" : "optimize-user";
    const id = opts.template ?? (mode === "system" ? (opts.enforceLangGPT ? "langgpt-strict" : "general") : "user-basic");
    const tpl = await this.templates.get(type, id);
    const { text } = await this.llm.chat(renderTemplate(tpl, { originalPrompt: prompt }), { temperature: 0.3, purpose: "optimize" });
    return { text: stripCodeFence(text), template: tpl.id };
  }

  async iterate(args: { original: string; last: string; requirements: string; template?: string }) {
    const tpl = await this.templates.get("iterate", args.template);
    const { text } = await this.llm.chat(renderTemplate(tpl, { originalPrompt: args.original, lastOptimizedPrompt: args.last, requirements: args.requirements }), { temperature: 0.3, purpose: "iterate" });
    return { text: stripCodeFence(text), template: tpl.id };
  }
}
