import { isPlainObject, stringList } from "./object-utils.js"
import type { ParentToolBridgeContract } from "./parent-tool-bridge.js"
import type { SandboxToolPolicySnapshot, ToolBridgeContract } from "./sandbox-tool-policy.js"
import { normalizeStructuredArtifacts, type StructuredArtifactPayload } from "./structured-artifacts.js"

export type TaskTargetKind = "repo" | "site" | "plugin" | "theme" | (string & {})

export const TASK_INPUT_SCHEMA = "wp-codebox/task-input/v1" as const
export const TASK_INPUT_VERSION = 1 as const
export const TASK_INPUT_ABILITY_ALIAS_FIELDS = [
  "goal",
  "target",
  "allowed_tools",
  "tool_bridge",
  "parent_tool_bridge",
  "sandbox_tool_policy",
  "expected_artifacts",
  "structured_artifacts",
  "policy",
  "context",
] as const

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
  import_principal?: TaskInputAgentBundleImportPrincipal
}

export interface TaskInputAgentBundleImportPrincipal {
  agent_id?: number
  owner_id?: number
  token_id?: number
  capabilities?: string[]
  scope?: Record<string, unknown>
}

export interface TaskInput {
  schema: typeof TASK_INPUT_SCHEMA
  version: typeof TASK_INPUT_VERSION
  goal: string
  target: Partial<TaskTarget>
  allowed_tools: string[]
  expected_artifacts: string[]
  structured_artifacts: StructuredArtifactPayload[]
  agent_bundles: TaskInputAgentBundle[]
  tool_bridge: ToolBridgeContract | Record<string, never>
  parent_tool_bridge: ParentToolBridgeContract | Record<string, never>
  sandbox_tool_policy: SandboxToolPolicySnapshot | Record<string, never>
  policy: TaskInputPolicy
  context: Record<string, unknown>
}

export type TaskInputRequest = Partial<Omit<TaskInput, "schema" | "version" | "goal">> & {
  goal?: string
}

export const TASK_INPUT_JSON_SCHEMA = {
  $id: TASK_INPUT_SCHEMA,
  type: "object",
  required: ["schema", "version", "goal", "target", "allowed_tools", "expected_artifacts", "structured_artifacts", "tool_bridge", "parent_tool_bridge", "sandbox_tool_policy", "policy", "context"],
  properties: {
    schema: { type: "string", const: TASK_INPUT_SCHEMA, description: "Task input contract schema id." },
    version: { type: "integer", const: TASK_INPUT_VERSION, description: "Task input contract version." },
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
    structured_artifacts: {
      type: "array",
      description: "Named JSON artifacts supplied by the caller as typed task inputs.",
      items: {
        type: "object",
        required: ["schema", "name", "type", "payload", "metadata", "provenance"],
        properties: {
          schema: { const: "wp-codebox/structured-artifact/v1" },
          name: { type: "string" },
          type: { type: "string" },
          payload_schema: { anyOf: [{ type: "string" }, { type: "object" }] },
          payload: {},
          metadata: { type: "object" },
          provenance: { type: "object" },
        },
      },
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
          import_principal: {
            type: "object",
            properties: {
              agent_id: { type: "integer", minimum: 1 },
              owner_id: { type: "integer", minimum: 1 },
              token_id: { type: "integer", minimum: 1 },
              capabilities: { type: "array", items: { type: "string" } },
              scope: { type: "object" },
            },
          },
        },
      },
    },
    sandbox_tool_policy: {
      type: "object",
      description: "Resolved sandbox tool policy snapshot carried by the WP Codebox tool bridge.",
    },
    tool_bridge: {
      type: "object",
      description: "WP Codebox-owned tool bridge envelope with allowlisted tools, dispatcher metadata, authorization notes, redaction notes, and sandbox_tool_policy.",
    },
    parent_tool_bridge: {
      type: "object",
      description: "WP Codebox-owned parent tool bridge envelope for host-dispatched tools, stable request/result schemas, sandbox env injection metadata, transcript artifact refs, and failure behavior.",
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
  const goal = String(input.goal ?? "").trim()
  if (goal === "") throw new Error("goal is required.")

  return {
    schema: TASK_INPUT_SCHEMA,
    version: TASK_INPUT_VERSION,
    goal,
    target: isPlainObject(input.target) ? input.target : {},
    allowed_tools: stringList(input.allowed_tools),
    expected_artifacts: stringList(input.expected_artifacts),
    structured_artifacts: normalizeStructuredArtifacts(input.structured_artifacts, "input"),
    agent_bundles: normalizeAgentBundles(input.agent_bundles),
    tool_bridge: isPlainObject(input.tool_bridge) ? input.tool_bridge as unknown as ToolBridgeContract : {},
    parent_tool_bridge: isPlainObject(input.parent_tool_bridge) ? input.parent_tool_bridge as unknown as ParentToolBridgeContract : {},
    sandbox_tool_policy: isPlainObject(input.sandbox_tool_policy) ? input.sandbox_tool_policy as unknown as SandboxToolPolicySnapshot : {},
    policy: isPlainObject(input.policy) ? input.policy : {},
    context: isPlainObject(input.context) ? input.context : {},
  }
}

export function normalizeAgentBundles(value: unknown): TaskInputAgentBundle[] {
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
    const importPrincipal = normalizeAgentBundleImportPrincipal(entry.import_principal)
    if (importPrincipal) normalized.import_principal = importPrincipal
    return [normalized]
  })
}

function normalizeAgentBundleImportPrincipal(value: unknown): TaskInputAgentBundleImportPrincipal | undefined {
  if (!isPlainObject(value)) return undefined

  const normalized: TaskInputAgentBundleImportPrincipal = {}
  for (const field of ["agent_id", "owner_id", "token_id"] as const) {
    const numericValue = Number(value[field])
    if (Number.isSafeInteger(numericValue) && numericValue > 0) normalized[field] = numericValue
  }

  const capabilities = stringList(value.capabilities)
  if (capabilities.length) normalized.capabilities = capabilities
  if (isPlainObject(value.scope)) normalized.scope = value.scope

  return Object.keys(normalized).length ? normalized : undefined
}
