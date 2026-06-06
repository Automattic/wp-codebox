import { isPlainObject, stringList } from "./object-utils.js"
import type { SandboxToolPolicySnapshot } from "./sandbox-tool-policy.js"

export type TaskTargetKind = "repo" | "site" | "plugin" | "theme" | (string & {})

export const TASK_INPUT_SCHEMA = "wp-codebox/task-input/v1" as const
export const AGENTS_API_TASK_INPUT_SCHEMA = "agents-api/task-input/v1" as const
export const TASK_INPUT_VERSION = 1 as const

export interface TaskTarget {
  kind: TaskTargetKind
  ref?: string
  path?: string
  url?: string
}

export interface TaskInputPolicy {
  approvals?: "never" | "on-write" | "on-command"
  applyBack?: "disabled" | "reviewed"
  sandbox?: "required" | "preferred"
  [key: string]: unknown
}

export interface TaskInputAgentBundle {
  source?: string
  bundle?: Record<string, unknown>
  slug?: string
  on_conflict?: "error" | "skip" | "upgrade"
  owner_id?: number
  token_env?: string
}

export interface TaskInput {
  schema: typeof TASK_INPUT_SCHEMA | typeof AGENTS_API_TASK_INPUT_SCHEMA
  version: typeof TASK_INPUT_VERSION
  goal: string
  target: Partial<TaskTarget>
  allowed_tools: string[]
  expected_artifacts: string[]
  agent_bundles: TaskInputAgentBundle[]
  sandbox_tool_policy: SandboxToolPolicySnapshot | Record<string, never>
  policy: TaskInputPolicy
  context: Record<string, unknown>
}

export type TaskInputRequest = Partial<Omit<TaskInput, "schema" | "version" | "goal">> & {
  goal?: string
  task?: string
  sandboxToolPolicy?: SandboxToolPolicySnapshot
}

export const TASK_INPUT_JSON_SCHEMA = {
  $id: TASK_INPUT_SCHEMA,
  type: "object",
  required: ["schema", "version", "goal", "target", "allowed_tools", "expected_artifacts", "agent_bundles", "sandbox_tool_policy", "policy", "context"],
  properties: {
    schema: { enum: [TASK_INPUT_SCHEMA, AGENTS_API_TASK_INPUT_SCHEMA], description: "Task input contract schema id. The legacy WP Codebox schema remains accepted alongside the generic Agents API schema." },
    version: { const: TASK_INPUT_VERSION, description: "Task input contract version." },
    goal: { type: "string", description: "User-facing outcome the sandboxed coding agent should accomplish." },
    target: {
      type: "object",
      description: "Bounded target for the task, such as a repo, site, plugin, or theme.",
      properties: {
        kind: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
        url: { type: "string" },
      },
    },
    allowed_tools: {
      type: "array",
      description: "Tool names the product caller expects the sandboxed agent to stay within.",
      items: { type: "string" },
    },
    expected_artifacts: {
      type: "array",
      description: "Artifact kinds the caller wants back, such as patch, review, tests, preview, or package.",
      items: { type: "string" },
    },
    agent_bundles: {
      type: "array",
      description: "Runtime agent bundles to import into the disposable sandbox before invoking the selected runtime agent.",
      items: {
        type: "object",
        anyOf: [{ required: ["source"] }, { required: ["bundle"] }],
        properties: {
          source: { type: "string" },
          bundle: { type: "object" },
          slug: { type: "string" },
          on_conflict: { enum: ["error", "skip", "upgrade"] },
          owner_id: { type: "integer", minimum: 1 },
          token_env: { type: "string" },
        },
      },
    },
    sandbox_tool_policy: {
      type: "object",
      description: "Resolved caller-owned sandbox tool policy snapshot. Codebox validates and enforces it without owning product-specific tool taxonomy.",
    },
    policy: {
      type: "object",
      description: "Caller policy hints for approvals, apply-back, sandboxing, and risk controls.",
    },
    context: {
      type: "object",
      description: "Additional non-secret caller context for the sandboxed task.",
    },
  },
} as const

export function normalizeTaskInput(input: TaskInputRequest): TaskInput {
  const goal = String(input.goal ?? input.task ?? "").trim()
  if (goal === "") throw new Error("goal or task is required.")
  const rawPolicy = (input as Record<string, unknown>).sandbox_tool_policy ?? (input as Record<string, unknown>).sandboxToolPolicy

  return {
    schema: TASK_INPUT_SCHEMA,
    version: TASK_INPUT_VERSION,
    goal,
    target: isPlainObject(input.target) ? input.target : {},
    allowed_tools: stringList(input.allowed_tools),
    expected_artifacts: stringList(input.expected_artifacts),
    agent_bundles: normalizeAgentBundles((input as Record<string, unknown>).agent_bundles ?? (input as Record<string, unknown>).agentBundles),
    sandbox_tool_policy: isPlainObject(rawPolicy) ? rawPolicy as unknown as SandboxToolPolicySnapshot : {},
    policy: isPlainObject(input.policy) ? input.policy : {},
    context: isPlainObject(input.context) ? input.context : {},
  }
}

function normalizeAgentBundles(value: unknown): TaskInputAgentBundle[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry): TaskInputAgentBundle[] => {
    if (!isPlainObject(entry)) return []
    const source = typeof entry.source === "string" ? entry.source.trim() : ""
    const bundle = isPlainObject(entry.bundle) ? entry.bundle : undefined
    if (!source && !bundle) return []

    const normalized: TaskInputAgentBundle = {}
    if (source) normalized.source = source
    if (bundle) normalized.bundle = bundle
    if (typeof entry.slug === "string" && entry.slug.trim()) normalized.slug = entry.slug.trim()
    normalized.on_conflict = ["error", "skip", "upgrade"].includes(String(entry.on_conflict)) ? entry.on_conflict as TaskInputAgentBundle["on_conflict"] : "upgrade"
    if (Number.isSafeInteger(entry.owner_id) && Number(entry.owner_id) > 0) normalized.owner_id = Number(entry.owner_id)
    if (typeof entry.token_env === "string" && entry.token_env.trim()) normalized.token_env = entry.token_env.trim()
    return [normalized]
  })
}
