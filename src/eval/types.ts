import { z } from "zod";

export const DETERMINISTIC_TYPES = [
  "equals", "contains", "icontains", "contains-any", "contains-all", "icontains-any", "icontains-all", "starts-with", "regex",
  "is-json", "contains-json", "javascript", "levenshtein", "latency", "cost", "min-length", "max-length", "is-refusal",
] as const;
export const MODEL_GRADED_TYPES = ["llm-rubric", "g-eval", "factuality", "answer-relevance", "prompt-compliance"] as const;
export const BASE_TYPES = [...DETERMINISTIC_TYPES, ...MODEL_GRADED_TYPES, "assert-set"] as const;

export interface Assertion {
  type: string; // any BASE_TYPE, optionally prefixed with "not-"
  value?: unknown;
  threshold?: number;
  weight?: number;
  metric?: string;
  transform?: string;
  provider?: string; // grader model override, e.g. "deepseek:deepseek-v4-pro"
  assert?: Assertion[]; // for assert-set
}

/** MCP-facing schema (non-recursive; nested assert-set children are validated at runtime). */
export const AssertionInputSchema = z.object({
  type: z.string().describe(`Assertion type (prefix "not-" to negate): ${BASE_TYPES.join(", ")}`),
  value: z.any().optional().describe("Expected string / list / JSON schema / JS expression / rubric, depending on type"),
  threshold: z.number().optional().describe("Score threshold (graded & similarity types), max ms for latency, max USD for cost, max distance for levenshtein"),
  weight: z.number().min(0).optional().describe("Relative weight in the test score (default 1)"),
  metric: z.string().optional().describe("Named metric to aggregate in the report"),
  transform: z.string().optional().describe("JS expression applied to `output` before this assertion"),
  provider: z.string().optional().describe("Grader model override for model-graded types"),
  assert: z.array(z.any()).optional().describe("Child assertions for assert-set"),
});

export const TestCaseInputSchema = z.object({
  description: z.string().optional(),
  input: z.string().optional().describe("User message (system mode) or value for {{input}} (user mode)"),
  vars: z.record(z.string(), z.string()).optional().describe("Values for {{placeholders}}"),
  assert: z.array(AssertionInputSchema).optional(),
  threshold: z.number().min(0).max(1).optional().describe("Pass if weighted score ≥ threshold (default: every assertion must pass)"),
});

export interface TestCase {
  description?: string;
  input?: string;
  vars: Record<string, string>;
  assert: Assertion[];
  threshold?: number;
  transform?: string;
}

export interface AssertionResult {
  type: string;
  pass: boolean;
  score: number;
  reason: string;
  weight: number;
  metric?: string;
  children?: AssertionResult[];
}

export interface RowResult {
  promptIndex: number;
  model: string;
  caseIndex: number;
  repeat: number;
  output: string;
  latencyMs: number;
  cached: boolean;
  tokens?: { prompt: number; completion: number };
  costUsd?: number;
  error?: string;
  assertions: AssertionResult[];
  pass: boolean;
  score: number;
}
