export type TemplateType = "optimize-system" | "optimize-user" | "iterate";

export interface TemplateMessage {
  role: "system" | "user";
  content: string;
}

export interface PromptTemplate {
  id: string;
  type: TemplateType;
  name: string;
  description: string;
  messages: TemplateMessage[];
  builtin: boolean;
  source?: string;
}

/** Variables available to every template. Values are inserted verbatim and never re-scanned. */
export interface TemplateVars {
  originalPrompt: string;
  lastOptimizedPrompt?: string;
  requirements?: string;
  language?: string;
  /** JSON evidence block built from the fields above (injection-safe framing). */
  evidence?: string;
}
