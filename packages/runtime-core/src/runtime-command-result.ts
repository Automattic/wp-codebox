import { RUNTIME_COMMAND_RESULT_SCHEMA, type RuntimeCommandResultEnvelope, type RuntimeCommandResultError, type RuntimeCommandResultStatus, type RuntimeEpisodeTraceRef } from "./runtime-contracts.js"

export function createRuntimeCommandResultEnvelope(result: Omit<RuntimeCommandResultEnvelope, "schema">): RuntimeCommandResultEnvelope {
  return {
    schema: RUNTIME_COMMAND_RESULT_SCHEMA,
    ...result,
  }
}

export interface RuntimeCommandResultEnvelopeFromOutputInput {
  status?: RuntimeCommandResultStatus
  stdout?: string
  stderr?: string
  diagnostics?: unknown
  artifactRefs?: RuntimeEpisodeTraceRef[]
  error?: RuntimeCommandResultError
}

export function runtimeCommandResultEnvelopeFromOutput(input: RuntimeCommandResultEnvelopeFromOutputInput): RuntimeCommandResultEnvelope {
  const stdout = input.stdout ?? ""
  const json = parseRuntimeCommandJsonStdout(stdout)
  return createRuntimeCommandResultEnvelope({
    status: input.status ?? "ok",
    stdout,
    stderr: input.stderr ?? "",
    ...(json === undefined ? {} : { json }),
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    ...(input.artifactRefs?.length ? { artifactRefs: input.artifactRefs } : {}),
    ...(input.error ? { error: input.error } : {}),
  })
}

function parseRuntimeCommandJsonStdout(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return undefined
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}
