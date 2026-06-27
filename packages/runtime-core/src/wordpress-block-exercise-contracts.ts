import type { PerformanceObservation } from "./performance-observation.js"

export const WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA = "wp-codebox/wordpress-block-exercise-result/v1" as const

export type WordPressBlockExerciseCommand = "wordpress.block-render" | "wordpress.block-exercise"
export type WordPressBlockExerciseMode = "render" | "serialize-parse" | "editor-insert-save"
export type WordPressBlockExerciseStatus = "ok" | "error" | "unsupported"

export interface WordPressBlockExerciseInput {
  blockName: string
  attrs?: Record<string, unknown>
  content?: string
  markup?: string
  mode?: WordPressBlockExerciseMode
  source?: string
  metadata?: Record<string, unknown>
}

export interface WordPressBlockExerciseIssue {
  code: string
  message: string
  severity?: "info" | "warning" | "error"
}

export interface WordPressBlockExerciseOutputSummary {
  bytes: number
  excerpt: string
  hash: string
}

export interface WordPressBlockExerciseResult {
  schema: typeof WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA
  command: WordPressBlockExerciseCommand
  status: WordPressBlockExerciseStatus
  blockName: string
  attrs: Record<string, unknown>
  input: WordPressBlockExerciseInput
  mode: WordPressBlockExerciseMode
  source: string
  render?: WordPressBlockExerciseOutputSummary
  serialized?: WordPressBlockExerciseOutputSummary
  parsed?: { blockName?: string; attrs?: Record<string, unknown>; innerHTMLBytes?: number }
  validation?: { status: "ok" | "error"; roundTripStable?: boolean }
  notices: WordPressBlockExerciseIssue[]
  errors: WordPressBlockExerciseIssue[]
  diagnostics: WordPressBlockExerciseIssue[]
  artifacts: Record<string, unknown>
  artifactRefs: unknown[]
  performance?: PerformanceObservation
  metadata?: Record<string, unknown>
}

export const WORDPRESS_BLOCK_EXERCISE_RESULT_JSON_SCHEMA = {
  $id: WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA,
  type: "object",
  additionalProperties: true,
  required: ["schema", "command", "status", "blockName", "attrs", "input", "mode", "source", "notices", "errors", "diagnostics", "artifacts", "artifactRefs"],
  properties: {
    schema: { const: WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA },
    command: { enum: ["wordpress.block-render", "wordpress.block-exercise"] },
    status: { enum: ["ok", "error", "unsupported"] },
    blockName: { type: "string" },
    attrs: { type: "object" },
    input: { type: "object" },
    mode: { enum: ["render", "serialize-parse", "editor-insert-save"] },
    source: { type: "string" },
    render: { type: "object" },
    serialized: { type: "object" },
    parsed: { type: "object" },
    validation: { type: "object" },
    notices: { type: "array" },
    errors: { type: "array" },
    diagnostics: { type: "array" },
    artifacts: { type: "object" },
    artifactRefs: { type: "array" },
    performance: { type: "object" },
    metadata: { type: "object" },
  },
} as const

export function normalizeWordPressBlockExerciseInput(input: Partial<Omit<WordPressBlockExerciseInput, "blockName" | "attrs" | "mode" | "metadata">> & { blockName?: unknown; attrs?: unknown; mode?: unknown; metadata?: unknown }): WordPressBlockExerciseInput {
  const blockName = typeof input.blockName === "string" ? input.blockName.trim() : ""
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(blockName)) {
    throw new Error(`WordPress block exercise blockName must be a registered block name slug such as core/paragraph: ${String(input.blockName ?? "")}`)
  }

  return {
    blockName,
    ...(input.attrs === undefined ? {} : { attrs: normalizeObject(input.attrs, "attrs") }),
    ...(typeof input.content === "string" ? { content: input.content } : {}),
    ...(typeof input.markup === "string" ? { markup: input.markup } : {}),
    mode: normalizeWordPressBlockExerciseMode(input.mode),
    ...(typeof input.source === "string" && input.source.length > 0 ? { source: input.source } : {}),
    ...(input.metadata === undefined ? {} : { metadata: normalizeObject(input.metadata, "metadata") }),
  }
}

export function createUnsupportedWordPressBlockExerciseResult(input: WordPressBlockExerciseInput, command: WordPressBlockExerciseCommand = "wordpress.block-exercise"): WordPressBlockExerciseResult {
  return {
    schema: WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA,
    command,
    status: "unsupported",
    blockName: input.blockName,
    attrs: input.attrs ?? {},
    input,
    mode: input.mode ?? "render",
    source: input.source ?? "contract",
    notices: [],
    errors: [],
    diagnostics: [{ code: "block-exercise-unsupported", message: `${command} is not implemented by this runtime backend.`, severity: "warning" }],
    artifacts: {},
    artifactRefs: [],
  }
}

function normalizeWordPressBlockExerciseMode(mode: unknown): WordPressBlockExerciseMode {
  if (mode === undefined || mode === null || mode === "") return "render"
  if (mode === "render" || mode === "serialize-parse" || mode === "editor-insert-save") return mode
  throw new Error(`WordPress block exercise mode must be render, serialize-parse, or editor-insert-save: ${String(mode)}`)
}

function normalizeObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`WordPress block exercise ${field} must be a JSON object`)
  }
  return value as Record<string, unknown>
}
