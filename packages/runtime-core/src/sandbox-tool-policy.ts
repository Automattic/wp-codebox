import { isPlainObject, stringList } from "./object-utils.js"

export const SANDBOX_TOOL_POLICY_SCHEMA = "wp-codebox/sandbox-tool-policy/v1" as const
export const SANDBOX_TOOL_POLICY_VERSION = 1 as const
export const AGENTS_API_RUNTIME_ENVIRONMENT = "environment" as const
export const AGENTS_API_RUNTIME_CAPABILITY_SCOPE = "capability_scope" as const
export const AGENTS_API_RUNTIME_LOCAL = "runtime_local" as const
export const AGENTS_API_CONTROL_PLANE = "control_plane" as const

export type SandboxToolExecutionLocation = "sandbox" | "parent" | "external" | (string & {})
export type SandboxToolTransportVisibility = "sandbox" | "parent" | "both" | "hidden" | (string & {})
export type AgentsApiRuntimeEnvironment = typeof AGENTS_API_RUNTIME_LOCAL | typeof AGENTS_API_CONTROL_PLANE | (string & {})

export interface AgentsApiRuntimeToolMetadata {
  [AGENTS_API_RUNTIME_ENVIRONMENT]?: AgentsApiRuntimeEnvironment
  [AGENTS_API_RUNTIME_CAPABILITY_SCOPE]?: AgentsApiRuntimeEnvironment
  [key: string]: unknown
}

export interface SandboxToolPolicyTool {
  id: string
  runtime_tool_id: string
  execution_location: SandboxToolExecutionLocation
  transport_visibility: SandboxToolTransportVisibility
  allowed: boolean
  runtime?: AgentsApiRuntimeToolMetadata
  risk?: string
  action?: string
  metadata?: Record<string, unknown>
}

export interface SandboxToolPolicySnapshot {
  schema: typeof SANDBOX_TOOL_POLICY_SCHEMA
  version: typeof SANDBOX_TOOL_POLICY_VERSION
  tools: SandboxToolPolicyTool[]
  metadata: Record<string, unknown>
}

export interface SandboxToolPolicyIssue {
  code: "invalid-policy" | "invalid-tool" | "duplicate-tool"
  field: string
  message: string
}

export interface SandboxToolPolicyValidationResult {
  valid: boolean
  issues: SandboxToolPolicyIssue[]
}

export class SandboxToolPolicyValidationError extends Error {
  readonly code = "sandbox-tool-policy-invalid" as const

  constructor(readonly issues: SandboxToolPolicyIssue[]) {
    super(`Sandbox tool policy is invalid: ${issues.map((issue) => issue.message).join("; ")}`)
    this.name = "SandboxToolPolicyValidationError"
  }

  toJSON(): { code: "sandbox-tool-policy-invalid"; issues: SandboxToolPolicyIssue[]; message: string; name: string } {
    return {
      code: this.code,
      issues: this.issues,
      message: this.message,
      name: this.name,
    }
  }
}

export function normalizeSandboxToolPolicySnapshot(input: unknown): SandboxToolPolicySnapshot {
  assertSandboxToolPolicySnapshot(input)
  return input
}

export function validateSandboxToolPolicySnapshot(input: unknown): SandboxToolPolicyValidationResult {
  const issues: SandboxToolPolicyIssue[] = []
  if (!isPlainObject(input)) {
    return {
      valid: false,
      issues: [{ code: "invalid-policy", field: "sandbox_tool_policy", message: "sandbox_tool_policy must be an object." }],
    }
  }

  if (input.schema !== SANDBOX_TOOL_POLICY_SCHEMA) {
    issues.push({ code: "invalid-policy", field: "schema", message: `sandbox_tool_policy.schema must be ${SANDBOX_TOOL_POLICY_SCHEMA}.` })
  }
  if (input.version !== SANDBOX_TOOL_POLICY_VERSION) {
    issues.push({ code: "invalid-policy", field: "version", message: `sandbox_tool_policy.version must be ${SANDBOX_TOOL_POLICY_VERSION}.` })
  }
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    issues.push({ code: "invalid-policy", field: "tools", message: "sandbox_tool_policy.tools must be a non-empty array." })
  }

  const seen = new Set<string>()
  for (const [index, tool] of (Array.isArray(input.tools) ? input.tools : []).entries()) {
    const field = `tools[${index}]`
    if (!isPlainObject(tool)) {
      issues.push({ code: "invalid-tool", field, message: `${field} must be an object.` })
      continue
    }
    const id = typeof tool.id === "string" ? tool.id.trim() : ""
    const runtimeToolId = typeof tool.runtime_tool_id === "string" ? tool.runtime_tool_id.trim() : ""
    const location = typeof tool.execution_location === "string" ? tool.execution_location.trim() : ""
    const visibility = typeof tool.transport_visibility === "string" ? tool.transport_visibility.trim() : ""
    if (!id) {
      issues.push({ code: "invalid-tool", field: `${field}.id`, message: `${field}.id must be a non-empty string.` })
    } else if (seen.has(id)) {
      issues.push({ code: "duplicate-tool", field: `${field}.id`, message: `Duplicate sandbox tool policy id: ${id}.` })
    }
    seen.add(id)
    if (!runtimeToolId) {
      issues.push({ code: "invalid-tool", field: `${field}.runtime_tool_id`, message: `${field}.runtime_tool_id must be a non-empty string.` })
    }
    if (!location) {
      issues.push({ code: "invalid-tool", field: `${field}.execution_location`, message: `${field}.execution_location must be a non-empty string.` })
    }
    if (!visibility) {
      issues.push({ code: "invalid-tool", field: `${field}.transport_visibility`, message: `${field}.transport_visibility must be a non-empty string.` })
    }
    if (typeof tool.allowed !== "boolean") {
      issues.push({ code: "invalid-tool", field: `${field}.allowed`, message: `${field}.allowed must be boolean.` })
    }
  }

  return { valid: issues.length === 0, issues }
}

export function assertSandboxToolPolicySnapshot(input: unknown): asserts input is SandboxToolPolicySnapshot {
  const result = validateSandboxToolPolicySnapshot(input)
  if (!result.valid) {
    throw new SandboxToolPolicyValidationError(result.issues)
  }
}

export function sandboxAllowedRuntimeToolIds(policy: SandboxToolPolicySnapshot): string[] {
  return stringList(policy.tools
    .filter((tool) => tool.allowed && sandboxToolRuntimeMetadata(tool).environment === AGENTS_API_RUNTIME_LOCAL && sandboxToolRuntimeMetadata(tool).capability_scope === AGENTS_API_RUNTIME_LOCAL)
    .map((tool) => tool.runtime_tool_id))
}

export function sandboxToolRuntimeMetadata(tool: SandboxToolPolicyTool): Required<Pick<AgentsApiRuntimeToolMetadata, typeof AGENTS_API_RUNTIME_ENVIRONMENT | typeof AGENTS_API_RUNTIME_CAPABILITY_SCOPE>> {
  const runtime = isPlainObject(tool.runtime) ? tool.runtime : {}
  const environment = typeof runtime[AGENTS_API_RUNTIME_ENVIRONMENT] === "string"
    ? runtime[AGENTS_API_RUNTIME_ENVIRONMENT]
    : legacyExecutionEnvironment(tool.execution_location)
  const capabilityScope = typeof runtime[AGENTS_API_RUNTIME_CAPABILITY_SCOPE] === "string"
    ? runtime[AGENTS_API_RUNTIME_CAPABILITY_SCOPE]
    : legacyCapabilityScope(tool.transport_visibility)

  return {
    environment,
    capability_scope: capabilityScope,
  }
}

function legacyExecutionEnvironment(location: string): AgentsApiRuntimeEnvironment {
  return location === "sandbox" ? AGENTS_API_RUNTIME_LOCAL : AGENTS_API_CONTROL_PLANE
}

function legacyCapabilityScope(visibility: string): AgentsApiRuntimeEnvironment {
  return ["sandbox", "both"].includes(visibility) ? AGENTS_API_RUNTIME_LOCAL : AGENTS_API_CONTROL_PLANE
}
