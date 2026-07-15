import { isPlainObject, objectValue, stripUndefined } from "./object-utils.js"

export const TOOL_OBSERVABILITY_VERSION = 1 as const
const MAX_TOOL_CALLS = 64
const MAX_IDENTIFIER_LENGTH = 256
const MAX_ARGUMENT_KEYS = 32
const RESULT_TYPES = ["array", "object", "string", "integer", "double", "boolean", "null"] as const
type ResultType = typeof RESULT_TYPES[number]

export interface ToolObservabilityCall {
  sequence: number
  turn: number
  tool_call_id: string
  tool_name: string
  status: "succeeded" | "failed" | "rejected" | "pending"
  arguments: { keys: string[], count: number, redacted: true }
  result?: { type: ResultType, count?: number, size?: number }
  error?: { code: string, message: string }
}

export interface ToolObservability {
  version: typeof TOOL_OBSERVABILITY_VERSION
  calls: ToolObservabilityCall[]
}

/** Projects the public Agents API lifecycle without retaining tool payloads. */
export function normalizeToolObservability(metadata: unknown): ToolObservability | undefined {
  const observability = objectValue(objectValue(metadata).agents_api).tool_observability
  const source = objectValue(observability)
  if (source.version !== TOOL_OBSERVABILITY_VERSION || !Array.isArray(source.calls) || source.calls.length > MAX_TOOL_CALLS) return undefined

  const calls = source.calls.map(projectCall).filter((call): call is ToolObservabilityCall => call !== undefined)
  return calls.length > 0 ? { version: TOOL_OBSERVABILITY_VERSION, calls } : undefined
}

function projectCall(value: unknown): ToolObservabilityCall | undefined {
  if (!isPlainObject(value)) return undefined
  const call = objectValue(value)
  const status = call.status
  const argumentsSummary = objectValue(call.arguments)
  const keys = Array.isArray(argumentsSummary.keys) ? argumentsSummary.keys : []
  const count = argumentsSummary.count
  if (!isPositiveInteger(call.sequence) || !isPositiveInteger(call.turn)
    || !safeIdentifier(call.tool_call_id) || !safeIdentifier(call.tool_name)
    || !["succeeded", "failed", "rejected", "pending"].includes(String(status))
    || argumentsSummary.redacted !== true || !isNonNegativeInteger(count) || count !== keys.length || keys.length > MAX_ARGUMENT_KEYS
    || !keys.every(safeIdentifier)) return undefined

  const result = projectResult(call.result)
  if (call.result !== undefined && !result) return undefined
  return stripUndefined({
    sequence: call.sequence,
    turn: call.turn,
    tool_call_id: call.tool_call_id,
    tool_name: call.tool_name,
    status: status as ToolObservabilityCall["status"],
    arguments: { keys, count, redacted: true },
    result,
    error: status === "failed" ? { code: "tool_call_failed", message: "Tool call failed." }
      : status === "rejected" ? { code: "tool_call_rejected", message: "Tool call was rejected." }
        : undefined,
  }) as ToolObservabilityCall
}

function projectResult(value: unknown): ToolObservabilityCall["result"] | undefined {
  const result = objectValue(value)
  if (Object.keys(result).length === 0) return undefined
  if (!isResultType(result.type)) return undefined
  if (result.type === "array" || result.type === "object") {
    return isNonNegativeInteger(result.count) ? { type: result.type, count: result.count } : undefined
  }
  if (result.type === "string") {
    return isNonNegativeInteger(result.size) ? { type: result.type, size: result.size } : undefined
  }
  return { type: result.type }
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IDENTIFIER_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

function isResultType(value: unknown): value is ResultType {
  return typeof value === "string" && RESULT_TYPES.includes(value as ResultType)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
