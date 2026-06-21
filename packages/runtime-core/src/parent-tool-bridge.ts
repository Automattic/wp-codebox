import { isPlainObject, stringList } from "./object-utils.js"

export const PARENT_TOOL_BRIDGE_SCHEMA = "wp-codebox/parent-tool-bridge/v1" as const
export const PARENT_TOOL_BRIDGE_VERSION = 1 as const
export const PARENT_TOOL_REQUEST_SCHEMA = "wp-codebox/parent-tool-request/v1" as const
export const PARENT_TOOL_REQUEST_VERSION = 1 as const
export const PARENT_TOOL_RESULT_SCHEMA = "wp-codebox/parent-tool-result/v1" as const
export const PARENT_TOOL_RESULT_VERSION = 1 as const

export type ParentToolDispatchMode = "host_endpoint" | "host_command"
export type ParentToolResultStatus = "succeeded" | "failed" | "denied" | "unavailable" | "timeout"

export interface ParentToolBridgeArtifactRef {
  kind: "tool-call-transcript" | "evidence" | "diagnostic" | (string & {})
  path?: string
  id?: string
  uri?: string
  sha256?: string
  metadata?: Record<string, unknown>
}

export interface ParentToolBridgeDispatcher {
  owner: "wp-codebox"
  mode: ParentToolDispatchMode
  endpoint?: {
    url_env: string
    method: "POST"
    token_env?: string
  }
  command?: {
    argv: string[]
    cwd_env?: string
    env?: Record<string, string>
  }
  request_schema: typeof PARENT_TOOL_REQUEST_SCHEMA
  result_schema: typeof PARENT_TOOL_RESULT_SCHEMA
  timeout_ms?: number
}

export interface ParentToolSandboxEnvInjection {
  mode: "metadata-only"
  variables: {
    bridge_ref?: string
    bridge_schema: string
    dispatch_mode: string
    request_schema: string
    result_schema: string
  }
  secret_env: string[]
  notes: string
}

export interface ParentToolBridgeContract {
  schema: typeof PARENT_TOOL_BRIDGE_SCHEMA
  version: typeof PARENT_TOOL_BRIDGE_VERSION
  allowed_tools: string[]
  dispatcher: ParentToolBridgeDispatcher
  sandbox_env: ParentToolSandboxEnvInjection
  authorization: {
    mode: "allowlist"
    failure_status: Extract<ParentToolResultStatus, "denied" | "unavailable">
    notes: string
  }
  redaction: {
    transcript_artifact_refs: ParentToolBridgeArtifactRef[]
    notes: string
  }
  metadata: Record<string, unknown>
}

export interface ParentToolRequestEnvelope {
  schema: typeof PARENT_TOOL_REQUEST_SCHEMA
  version: typeof PARENT_TOOL_REQUEST_VERSION
  request_id: string
  tool: string
  operation: string
  input: unknown
  sandbox_session: {
    sandbox_session_id: string
    caller_session_id?: string
    task_id?: string
  }
  authorization: {
    allowed_tools: string[]
    principal?: Record<string, unknown>
    capability?: string
  }
  metadata: Record<string, unknown>
}

export interface ParentToolResultEnvelope {
  schema: typeof PARENT_TOOL_RESULT_SCHEMA
  version: typeof PARENT_TOOL_RESULT_VERSION
  request_id: string
  tool: string
  operation: string
  status: ParentToolResultStatus
  output?: unknown
  error?: {
    code: string
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  }
  artifacts: {
    transcripts: ParentToolBridgeArtifactRef[]
    evidence: ParentToolBridgeArtifactRef[]
  }
  diagnostics: Record<string, unknown>
  metadata: Record<string, unknown>
}

export interface ParentToolBridgeOptions {
  allowedTools: string[]
  dispatcher: Pick<ParentToolBridgeDispatcher, "mode"> & Partial<Omit<ParentToolBridgeDispatcher, "owner" | "mode" | "request_schema" | "result_schema">>
  bridgeRefEnv?: string
  transcriptArtifactRefs?: ParentToolBridgeArtifactRef[]
  metadata?: Record<string, unknown>
}

export const PARENT_TOOL_BRIDGE_JSON_SCHEMA = {
  $id: PARENT_TOOL_BRIDGE_SCHEMA,
  type: "object",
  required: ["schema", "version", "allowed_tools", "dispatcher", "sandbox_env", "authorization", "redaction", "metadata"],
  properties: {
    schema: { type: "string", const: PARENT_TOOL_BRIDGE_SCHEMA },
    version: { type: "integer", const: PARENT_TOOL_BRIDGE_VERSION },
    allowed_tools: { type: "array", items: { type: "string" } },
    dispatcher: {
      type: "object",
      required: ["owner", "mode", "request_schema", "result_schema"],
      properties: {
        owner: { type: "string", const: "wp-codebox" },
        mode: { type: "string", enum: ["host_endpoint", "host_command"] },
        endpoint: { type: "object" },
        command: { type: "object" },
        request_schema: { type: "string", const: PARENT_TOOL_REQUEST_SCHEMA },
        result_schema: { type: "string", const: PARENT_TOOL_RESULT_SCHEMA },
        timeout_ms: { type: "integer", minimum: 1 },
      },
    },
    sandbox_env: { type: "object" },
    authorization: { type: "object" },
    redaction: { type: "object" },
    metadata: { type: "object" },
  },
} as const

export const PARENT_TOOL_REQUEST_JSON_SCHEMA = {
  $id: PARENT_TOOL_REQUEST_SCHEMA,
  type: "object",
  required: ["schema", "version", "request_id", "tool", "operation", "input", "sandbox_session", "authorization", "metadata"],
  properties: {
    schema: { type: "string", const: PARENT_TOOL_REQUEST_SCHEMA },
    version: { type: "integer", const: PARENT_TOOL_REQUEST_VERSION },
    request_id: { type: "string" },
    tool: { type: "string" },
    operation: { type: "string" },
    input: {},
    sandbox_session: { type: "object" },
    authorization: { type: "object" },
    metadata: { type: "object" },
  },
} as const

export const PARENT_TOOL_RESULT_JSON_SCHEMA = {
  $id: PARENT_TOOL_RESULT_SCHEMA,
  type: "object",
  required: ["schema", "version", "request_id", "tool", "operation", "status", "artifacts", "diagnostics", "metadata"],
  properties: {
    schema: { type: "string", const: PARENT_TOOL_RESULT_SCHEMA },
    version: { type: "integer", const: PARENT_TOOL_RESULT_VERSION },
    request_id: { type: "string" },
    tool: { type: "string" },
    operation: { type: "string" },
    status: { type: "string", enum: ["succeeded", "failed", "denied", "unavailable", "timeout"] },
    output: {},
    error: { type: "object" },
    artifacts: { type: "object" },
    diagnostics: { type: "object" },
    metadata: { type: "object" },
  },
} as const

export function parentToolBridgeContract(options: ParentToolBridgeOptions): ParentToolBridgeContract {
  const mode = options.dispatcher.mode
  return {
    schema: PARENT_TOOL_BRIDGE_SCHEMA,
    version: PARENT_TOOL_BRIDGE_VERSION,
    allowed_tools: stringList(options.allowedTools),
    dispatcher: {
      owner: "wp-codebox",
      mode,
      endpoint: mode === "host_endpoint" && isPlainObject(options.dispatcher.endpoint) ? options.dispatcher.endpoint as ParentToolBridgeDispatcher["endpoint"] : undefined,
      command: mode === "host_command" && isPlainObject(options.dispatcher.command) ? normalizeCommandDispatcher(options.dispatcher.command) : undefined,
      request_schema: PARENT_TOOL_REQUEST_SCHEMA,
      result_schema: PARENT_TOOL_RESULT_SCHEMA,
      timeout_ms: typeof options.dispatcher.timeout_ms === "number" && options.dispatcher.timeout_ms > 0 ? Math.floor(options.dispatcher.timeout_ms) : undefined,
    },
    sandbox_env: {
      mode: "metadata-only",
      variables: {
        bridge_ref: options.bridgeRefEnv,
        bridge_schema: "WP_CODEBOX_PARENT_TOOL_BRIDGE_SCHEMA",
        dispatch_mode: "WP_CODEBOX_PARENT_TOOL_DISPATCH_MODE",
        request_schema: "WP_CODEBOX_PARENT_TOOL_REQUEST_SCHEMA",
        result_schema: "WP_CODEBOX_PARENT_TOOL_RESULT_SCHEMA",
      },
      secret_env: [],
      notes: "Sandbox env injection carries only contract ids, dispatch mode, and optional artifact/env references. It must not include parent credentials or tool result payloads.",
    },
    authorization: {
      mode: "allowlist",
      failure_status: "denied",
      notes: "The parent dispatcher executes only tools listed in allowed_tools and returns denied for authorization failures without attempting fallback execution inside the sandbox.",
    },
    redaction: {
      transcript_artifact_refs: options.transcriptArtifactRefs ?? [],
      notes: "Dispatchers persist redacted request/result transcripts as artifacts and return refs. Secret values, bearer tokens, cookies, and host-local paths stay out of envelopes and transcripts.",
    },
    metadata: isPlainObject(options.metadata) ? options.metadata : {},
  }
}

function normalizeCommandDispatcher(input: unknown): ParentToolBridgeDispatcher["command"] {
  const command = isPlainObject(input) ? input : {}
  return {
    argv: stringList(command.argv),
    cwd_env: typeof command.cwd_env === "string" && command.cwd_env.trim() ? command.cwd_env.trim() : undefined,
    env: isPlainObject(command.env) ? Object.fromEntries(Object.entries(command.env).filter(([, value]) => typeof value === "string")) as Record<string, string> : undefined,
  }
}
