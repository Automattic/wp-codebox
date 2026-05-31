import { isPlainObject, stringList } from "./object-utils.js"

export type TaskTargetKind = "repo" | "site" | "plugin" | "theme" | (string & {})

export const TASK_INPUT_SCHEMA = "wp-codebox/task-input/v1" as const
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

export interface TaskInput {
  schema: typeof TASK_INPUT_SCHEMA
  version: typeof TASK_INPUT_VERSION
  goal: string
  target: Partial<TaskTarget>
  allowed_tools: string[]
  expected_artifacts: string[]
  policy: TaskInputPolicy
  context: Record<string, unknown>
}

export type TaskInputRequest = Partial<Omit<TaskInput, "schema" | "version" | "goal">> & {
  goal?: string
  task?: string
}

export const TASK_INPUT_JSON_SCHEMA = {
  $id: TASK_INPUT_SCHEMA,
  type: "object",
  required: ["schema", "version", "goal", "target", "allowed_tools", "expected_artifacts", "policy", "context"],
  properties: {
    schema: { const: TASK_INPUT_SCHEMA, description: "Task input contract schema id." },
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

  return {
    schema: TASK_INPUT_SCHEMA,
    version: TASK_INPUT_VERSION,
    goal,
    target: isPlainObject(input.target) ? input.target : {},
    allowed_tools: stringList(input.allowed_tools),
    expected_artifacts: stringList(input.expected_artifacts),
    policy: isPlainObject(input.policy) ? input.policy : {},
    context: isPlainObject(input.context) ? input.context : {},
  }
}
