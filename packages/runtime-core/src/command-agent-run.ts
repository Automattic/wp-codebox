import { commandArgValue, parseCommandJsonArray, parseCommandJsonObject, strictBooleanCommandArg } from "./command-codecs.js"
import type { ExecutionResult, RuntimeInfo } from "./runtime-contracts.js"
import { isValidRuntimeEnvName } from "./runtime-env.js"
import { normalizeCommandEnvelopeStatus, type CommandEnvelopeStatus } from "./status-taxonomy.js"

export const COMMAND_AGENT_RUN_SCHEMA = "wp-codebox/command-agent-run/v1" as const

export interface CommandAgentRunRequest {
  command: string
  args: string[]
  parseJson: boolean
  session?: CommandAgentRunSession
  auth?: CommandAgentRunAuthContext
}

export interface CommandAgentRunSession {
  sessionId?: string
  correlationId?: string
  metadata?: Record<string, unknown>
}

export interface CommandAgentRunAuthContext {
  required: boolean
  context?: Record<string, unknown>
}

export interface CommandAgentRunEnvironmentSummary {
  runtimeEnvNames: string[]
  secretEnvNames: string[]
}

export interface CommandAgentRunArtifactRef {
  kind: string
  id?: string
  path?: string
  digest?: unknown
  metadata?: Record<string, unknown>
}

export interface CommandAgentRunDiagnostics {
  command: string
  argsCount: number
  runtime: RuntimeInfo
  environment: CommandAgentRunEnvironmentSummary
  durationMs: number
  output: {
    stdoutBytes: number
    stderrBytes: number
    parsedJson: boolean
  }
  error?: {
    code: string
    message: string
    failureClassification: "timeout" | "non_zero_exit" | "invalid_json" | "runtime" | (string & {})
  }
}

export interface CommandAgentRunResult {
  schema: typeof COMMAND_AGENT_RUN_SCHEMA
  command: "command-agent-run"
  status: CommandEnvelopeStatus
  target: {
    command: string
    args: string[]
  }
  exitCode: number
  stdout: string
  stderr: string
  json?: unknown
  session?: CommandAgentRunSession
  auth?: {
    required: boolean
    contextKeys: string[]
  }
  diagnostics: CommandAgentRunDiagnostics
  artifactRefs: CommandAgentRunArtifactRef[]
}

export interface CreateCommandAgentRunResultInput {
  request: CommandAgentRunRequest
  execution: ExecutionResult
  runtime: RuntimeInfo
  environment?: Partial<CommandAgentRunEnvironmentSummary>
}

export function parseCommandAgentRunRequest(args: readonly string[]): CommandAgentRunRequest {
  const command = commandArgValue(args, "command")?.trim() ?? ""
  if (!command) {
    throw new Error("command-agent-run requires command")
  }
  if (command === "command-agent-run") {
    throw new Error("command-agent-run cannot target itself")
  }

  const targetArgs = parseStringArray(commandArgValue(args, "args-json"), "args-json")
  const parseJson = strictBooleanCommandArg(args, "parse-json", false)
  const authRequired = strictBooleanCommandArg(args, "auth-required", false)
  const authContext = parseCommandJsonObject(commandArgValue(args, "auth-context-json"), "auth-context-json", {})
  if (authRequired && Object.keys(authContext).length === 0) {
    throw new Error("command-agent-run auth-required=true requires auth-context-json")
  }

  const session = normalizeCommandAgentRunSession({
    sessionId: commandArgValue(args, "session-id"),
    correlationId: commandArgValue(args, "correlation-id"),
    metadata: parseCommandJsonObject(commandArgValue(args, "session-metadata-json"), "session-metadata-json", {}),
  })

  return {
    command,
    args: targetArgs,
    parseJson,
    ...(session ? { session } : {}),
    auth: { required: authRequired, ...(Object.keys(authContext).length > 0 ? { context: authContext } : {}) },
  }
}

export function createCommandAgentRunResult(input: CreateCommandAgentRunResultInput): CommandAgentRunResult {
  if (!input.runtime?.id || !input.runtime.backend || !input.runtime.status) {
    throw new Error("command-agent-run requires runtime metadata")
  }

  const stdout = input.execution.stdout ?? ""
  const stderr = input.execution.stderr ?? ""
  const exitCode = input.execution.exitCode
  const jsonResult = input.request.parseJson ? parseCommandAgentRunJson(stdout) : undefined
  const json = jsonResult?.json
  const executionRecord = input.execution.result && typeof input.execution.result === "object" && !Array.isArray(input.execution.result) ? input.execution.result as unknown as Record<string, unknown> : {}
  const timedOut = executionRecord.timedOut === true || executionRecord.timed_out === true
  const failure = commandAgentRunFailure(exitCode, timedOut, jsonResult?.error)
  const authContext = input.request.auth?.context ?? {}
  const diagnostics: CommandAgentRunDiagnostics = {
    command: input.request.command,
    argsCount: input.request.args.length,
    runtime: input.runtime,
    environment: {
      runtimeEnvNames: normalizeEnvNames(input.environment?.runtimeEnvNames ?? []),
      secretEnvNames: normalizeEnvNames(input.environment?.secretEnvNames ?? []),
    },
    durationMs: commandAgentRunDurationMs(input.execution),
    output: {
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      parsedJson: json !== undefined,
    },
    ...(failure ? { error: failure } : {}),
  }

  return {
    schema: COMMAND_AGENT_RUN_SCHEMA,
    command: "command-agent-run",
    status: normalizeCommandEnvelopeStatus({ success: !failure, exitStatus: exitCode, timeout: timedOut }),
    target: {
      command: input.request.command,
      args: input.request.args,
    },
    exitCode,
    stdout,
    stderr,
    ...(json !== undefined ? { json } : {}),
    ...(input.request.session ? { session: input.request.session } : {}),
    auth: {
      required: input.request.auth?.required === true,
      contextKeys: Object.keys(authContext).sort(),
    },
    diagnostics,
    artifactRefs: commandAgentRunArtifactRefs(input.execution),
  }
}

export function commandAgentRunResultJson(result: CommandAgentRunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`
}

function parseStringArray(raw: string | undefined, label: string): string[] {
  return parseCommandJsonArray(raw, label, []).map((item) => {
    if (typeof item !== "string") {
      throw new Error(`${label} must be a JSON array of strings`)
    }
    return item
  })
}

function normalizeCommandAgentRunSession(session: CommandAgentRunSession): CommandAgentRunSession | undefined {
  const metadata = session.metadata && Object.keys(session.metadata).length > 0 ? session.metadata : undefined
  if (!session.sessionId && !session.correlationId && !metadata) {
    return undefined
  }
  return {
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.correlationId ? { correlationId: session.correlationId } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function parseCommandAgentRunJson(stdout: string): { json?: unknown; error?: string } {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { error: "command-agent-run parse-json=true requires JSON stdout" }
  }
  try {
    return { json: JSON.parse(trimmed) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: `command-agent-run stdout must be valid JSON: ${message}` }
  }
}

function commandAgentRunFailure(exitCode: number, timedOut: boolean, invalidJsonMessage?: string): CommandAgentRunDiagnostics["error"] | undefined {
  if (timedOut) {
    return { code: "command-agent-run-timeout", message: "Target command timed out.", failureClassification: "timeout" }
  }
  if (exitCode !== 0) {
    return { code: "command-agent-run-non-zero-exit", message: `Target command exited with status ${exitCode}.`, failureClassification: "non_zero_exit" }
  }
  if (invalidJsonMessage) {
    return { code: "command-agent-run-invalid-json", message: invalidJsonMessage, failureClassification: "invalid_json" }
  }
  return undefined
}

function normalizeEnvNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter((name) => name && isValidRuntimeEnvName(name)))].sort()
}

function commandAgentRunDurationMs(execution: ExecutionResult): number {
  const started = Date.parse(execution.startedAt)
  const finished = Date.parse(execution.finishedAt)
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? finished - started : 0
}

function commandAgentRunArtifactRefs(execution: ExecutionResult): CommandAgentRunArtifactRef[] {
  const refs = Array.isArray(execution.result?.artifactRefs) ? execution.result.artifactRefs : []
  return refs
    .map((ref) => ({
      kind: typeof ref.kind === "string" ? ref.kind : "artifact",
      ...(typeof ref.id === "string" ? { id: ref.id } : {}),
      ...(typeof ref.path === "string" ? { path: ref.path } : {}),
      ...(ref.digest !== undefined ? { digest: ref.digest } : {}),
    }))
    .filter((ref) => ref.kind && (ref.id || ref.path))
}
