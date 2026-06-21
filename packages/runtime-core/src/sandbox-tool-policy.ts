import { isPlainObject, stringList } from "./object-utils.js"

export const SANDBOX_TOOL_POLICY_SCHEMA = "wp-codebox/sandbox-tool-policy/v1" as const
export const SANDBOX_TOOL_POLICY_VERSION = 1 as const
export const TOOL_BRIDGE_SCHEMA = "wp-codebox/tool-bridge/v1" as const
export const TOOL_BRIDGE_VERSION = 1 as const
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
  aliases?: string[]
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

export interface RuntimeToolDescriptor {
  id: string
  runtimeToolId: string
  aliases: string[]
  allowed: boolean
  executionLocation: SandboxToolExecutionLocation
  transportVisibility: SandboxToolTransportVisibility
  visible: boolean
  parentOnly: boolean
  hidden: boolean
  runtime: Required<Pick<AgentsApiRuntimeToolMetadata, typeof AGENTS_API_RUNTIME_ENVIRONMENT | typeof AGENTS_API_RUNTIME_CAPABILITY_SCOPE>>
  schema?: string
  policy?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface EffectiveRuntimeToolPolicy {
  schema: typeof SANDBOX_TOOL_POLICY_SCHEMA
  version: typeof SANDBOX_TOOL_POLICY_VERSION
  tools: RuntimeToolDescriptor[]
  allowedRuntimeToolIds: string[]
  visibleRuntimeToolIds: string[]
  parentOnlyRuntimeToolIds: string[]
  hiddenRuntimeToolIds: string[]
  metadata: Record<string, unknown>
}

export interface ToolBridgeContract {
  schema: typeof TOOL_BRIDGE_SCHEMA
  version: typeof TOOL_BRIDGE_VERSION
  allowed_tools: string[]
  sandbox_tool_policy: SandboxToolPolicySnapshot
  dispatcher: {
    owner: "wp-codebox"
    callback: "wp_codebox_browser_runtime_tool_callback"
    location: "sandbox"
  }
  authorization: {
    mode: "allowlist"
    notes: string
  }
  redaction: {
    notes: string
  }
  metadata?: Record<string, unknown>
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
    const runtime = isPlainObject(tool.runtime) ? tool.runtime : {}
    const runtimeEnvironment = typeof runtime[AGENTS_API_RUNTIME_ENVIRONMENT] === "string" ? runtime[AGENTS_API_RUNTIME_ENVIRONMENT].trim() : ""
    const runtimeCapabilityScope = typeof runtime[AGENTS_API_RUNTIME_CAPABILITY_SCOPE] === "string" ? runtime[AGENTS_API_RUNTIME_CAPABILITY_SCOPE].trim() : ""
    if (!id) {
      issues.push({ code: "invalid-tool", field: `${field}.id`, message: `${field}.id must be a non-empty string.` })
    } else if (seen.has(id)) {
      issues.push({ code: "duplicate-tool", field: `${field}.id`, message: `Duplicate sandbox tool policy id: ${id}.` })
    }
    seen.add(id)
    if (!runtimeToolId) {
      issues.push({ code: "invalid-tool", field: `${field}.runtime_tool_id`, message: `${field}.runtime_tool_id must be a non-empty string.` })
    }
    if (!runtimeEnvironment) {
      issues.push({ code: "invalid-tool", field: `${field}.runtime.environment`, message: `${field}.runtime.environment must be a non-empty string.` })
    }
    if (!runtimeCapabilityScope) {
      issues.push({ code: "invalid-tool", field: `${field}.runtime.capability_scope`, message: `${field}.runtime.capability_scope must be a non-empty string.` })
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
  return resolveEffectiveRuntimeToolPolicy(policy).allowedRuntimeToolIds
}

export function toolBridgeFromSandboxToolPolicy(policy: SandboxToolPolicySnapshot, allowedTools: string[] = []): ToolBridgeContract {
  return {
    schema: TOOL_BRIDGE_SCHEMA,
    version: TOOL_BRIDGE_VERSION,
    allowed_tools: stringList(allowedTools.length > 0 ? allowedTools : policy.tools.map((tool) => tool.id)),
    sandbox_tool_policy: policy,
    dispatcher: {
      owner: "wp-codebox",
      callback: "wp_codebox_browser_runtime_tool_callback",
      location: "sandbox",
    },
    authorization: {
      mode: "allowlist",
      notes: "Only sandbox-visible tools in sandbox_tool_policy are exposed to the runtime agent. Parent control-plane actions remain outside the sandbox bridge.",
    },
    redaction: {
      notes: "Secret values are passed through environment allowlists only and must not be embedded in tool bridge payloads, logs, or dispatcher metadata.",
    },
  }
}

export function resolveEffectiveRuntimeToolPolicy(policy: SandboxToolPolicySnapshot): EffectiveRuntimeToolPolicy {
  const tools = policy.tools.map(runtimeToolDescriptor)
  return {
    schema: policy.schema,
    version: policy.version,
    tools,
    allowedRuntimeToolIds: stringList(tools.filter((tool) => tool.allowed && tool.visible).map((tool) => tool.runtimeToolId)),
    visibleRuntimeToolIds: stringList(tools.filter((tool) => tool.visible).map((tool) => tool.runtimeToolId)),
    parentOnlyRuntimeToolIds: stringList(tools.filter((tool) => tool.parentOnly).map((tool) => tool.runtimeToolId)),
    hiddenRuntimeToolIds: stringList(tools.filter((tool) => tool.hidden).map((tool) => tool.runtimeToolId)),
    metadata: policy.metadata,
  }
}

export function resolveRuntimeToolAlias(policy: EffectiveRuntimeToolPolicy | SandboxToolPolicySnapshot, value: string): RuntimeToolDescriptor | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const effective = "allowedRuntimeToolIds" in policy ? policy : resolveEffectiveRuntimeToolPolicy(policy)
  return effective.tools.find((tool) => tool.id === trimmed || tool.runtimeToolId === trimmed || tool.aliases.includes(trimmed))
}

export function sandboxToolRuntimeMetadata(tool: SandboxToolPolicyTool): Required<Pick<AgentsApiRuntimeToolMetadata, typeof AGENTS_API_RUNTIME_ENVIRONMENT | typeof AGENTS_API_RUNTIME_CAPABILITY_SCOPE>> {
  const runtime = isPlainObject(tool.runtime) ? tool.runtime : {}
  const environment = typeof runtime[AGENTS_API_RUNTIME_ENVIRONMENT] === "string"
    ? runtime[AGENTS_API_RUNTIME_ENVIRONMENT]
    : ""
  const capabilityScope = typeof runtime[AGENTS_API_RUNTIME_CAPABILITY_SCOPE] === "string"
    ? runtime[AGENTS_API_RUNTIME_CAPABILITY_SCOPE]
    : ""

  return {
    environment,
    capability_scope: capabilityScope,
  }
}

function runtimeToolDescriptor(tool: SandboxToolPolicyTool): RuntimeToolDescriptor {
  const runtime = sandboxToolRuntimeMetadata(tool)
  const aliases = stringList([
    tool.id,
    tool.runtime_tool_id,
    ...stringList(tool.aliases),
    ...stringList(isPlainObject(tool.metadata) ? tool.metadata.aliases : undefined),
  ])
  const parentOnly = runtime.environment !== AGENTS_API_RUNTIME_LOCAL || runtime.capability_scope !== AGENTS_API_RUNTIME_LOCAL
  const hidden = tool.transport_visibility === "hidden"
  const visible = !parentOnly && !hidden && (tool.transport_visibility === "sandbox" || tool.transport_visibility === "both")
  const schema = typeof tool.metadata?.schema === "string" ? tool.metadata.schema : undefined
  const policy = isPlainObject(tool.metadata?.policy) ? tool.metadata.policy : undefined

  return {
    id: tool.id,
    runtimeToolId: tool.runtime_tool_id,
    aliases,
    allowed: tool.allowed,
    executionLocation: tool.execution_location,
    transportVisibility: tool.transport_visibility,
    visible,
    parentOnly,
    hidden,
    runtime,
    ...(schema ? { schema } : {}),
    ...(policy ? { policy } : {}),
    ...(tool.metadata ? { metadata: tool.metadata } : {}),
  }
}
