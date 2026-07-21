import type { ExecutionResult } from "./runtime-contracts.js"
import { normalizeJsonValue } from "./object-utils.js"

export const COMMAND_ARTIFACT_STRING_MAX_BYTES = 1024 * 1024
export const COMMAND_ARTIFACT_TOTAL_STRING_MAX_BYTES = 16 * 1024 * 1024
export const COMMAND_ARTIFACT_MAX_NODES = 25_000
export const COMMAND_ARTIFACT_MAX_RECORDS = 1_000
const COMMAND_ARTIFACT_MAX_TRUNCATIONS = 1_000
const COMMAND_ARTIFACT_KEY_MAX_BYTES = 256
const COMMAND_ARTIFACT_IDENTITY_MAX_BYTES = 1024
const COMMAND_ARTIFACT_PATH_MAX_BYTES = 4096
const EXECUTION_RESULT_KEYS = new Set(["id", "command", "args", "exitCode", "stdout", "stderr", "result", "diagnostics", "artifactRefs", "startedAt", "finishedAt", "artifactCapture"])

export interface CommandArtifactTruncation {
  path: string
  reason: "string-byte-limit" | "total-string-byte-limit" | "node-limit"
  observedBytes?: number
  capturedBytes?: number
  configuredLimitBytes?: number
}

export interface CommandArtifactCapture {
  schema: "wp-codebox/command-artifact-capture/v1"
  truncated: true
  limits: {
    capturedStringBytesPerValue: number
    capturedStringBytesTotal: number
    nodes: number
    records: number
  }
  fields: CommandArtifactTruncation[]
  omittedFieldCount?: number
  omittedCommandCount?: number
}

export type BoundedExecutionResult<T extends ExecutionResult = ExecutionResult> = T & { artifactCapture?: CommandArtifactCapture }

export function boundedExecutionResultsForArtifacts<T extends ExecutionResult>(commands: T[]): Array<BoundedExecutionResult<T>> {
  const budget = {
    remainingBytes: COMMAND_ARTIFACT_TOTAL_STRING_MAX_BYTES,
    remainingNodes: COMMAND_ARTIFACT_MAX_NODES,
    remainingTruncations: COMMAND_ARTIFACT_MAX_TRUNCATIONS,
  }
  const selectedCommands = commands.length <= COMMAND_ARTIFACT_MAX_RECORDS
    ? commands
    : [...commands.slice(0, COMMAND_ARTIFACT_MAX_RECORDS - 1), commands.at(-1)!]

  return selectedCommands.map((command, selectedIndex) => {
    const fields: CommandArtifactTruncation[] = []
    let omittedFieldCount = 0
    const capture = (value: unknown, path: string): unknown => boundedArtifactValue(value, path, budget, (field) => {
      if (fields.length < 100 && budget.remainingTruncations > 0) {
        fields.push(field)
        budget.remainingTruncations -= 1
      } else {
        omittedFieldCount += 1
      }
    })
    const extensions = Object.fromEntries(
      Object.entries(command)
        .filter(([key]) => !EXECUTION_RESULT_KEYS.has(key))
        .map(([key, value]) => [key, capture(normalizeJsonValue(value), key)]),
    )
    const projected = {
      ...extensions,
      id: boundedIdentityString(command.id),
      command: boundedIdentityString(command.command),
      args: capture(normalizeJsonValue(command.args), "args") as string[],
      exitCode: command.exitCode,
      stdout: capture(command.stdout, "stdout") as string,
      stderr: capture(command.stderr, "stderr") as string,
      ...(command.result === undefined ? {} : { result: capture(normalizeJsonValue(command.result), "result") as ExecutionResult["result"] }),
      ...(command.diagnostics === undefined ? {} : { diagnostics: capture(normalizeJsonValue(command.diagnostics), "diagnostics") }),
      ...(command.artifactRefs === undefined ? {} : { artifactRefs: capture(normalizeJsonValue(command.artifactRefs), "artifactRefs") as ExecutionResult["artifactRefs"] }),
      startedAt: boundedIdentityString(command.startedAt),
      finishedAt: boundedIdentityString(command.finishedAt),
    } as BoundedExecutionResult<T>
    const omittedCommandCount = commands.length - selectedCommands.length
    if (fields.length > 0 || omittedFieldCount > 0 || (omittedCommandCount > 0 && selectedIndex === selectedCommands.length - 1)) {
      projected.artifactCapture = {
        schema: "wp-codebox/command-artifact-capture/v1",
        truncated: true,
        limits: {
          capturedStringBytesPerValue: COMMAND_ARTIFACT_STRING_MAX_BYTES,
          capturedStringBytesTotal: COMMAND_ARTIFACT_TOTAL_STRING_MAX_BYTES,
          nodes: COMMAND_ARTIFACT_MAX_NODES,
          records: COMMAND_ARTIFACT_MAX_RECORDS,
        },
        fields,
        ...(omittedFieldCount > 0 ? { omittedFieldCount } : {}),
        ...(omittedCommandCount > 0 && selectedIndex === selectedCommands.length - 1 ? { omittedCommandCount } : {}),
      }
    }
    return projected
  })
}

function boundedArtifactValue(
  value: unknown,
  path: string,
  budget: { remainingBytes: number; remainingNodes: number; remainingTruncations: number },
  recordTruncation: (field: CommandArtifactTruncation) => void,
): unknown {
  if (value === null || value === undefined || (typeof value !== "string" && typeof value !== "object")) {
    return value
  }
  if (budget.remainingNodes <= 0) {
    recordTruncation({ path: truncateUtf8(path, COMMAND_ARTIFACT_PATH_MAX_BYTES), reason: "node-limit" })
    if (typeof value === "string") return ""
    return Array.isArray(value) ? [] : {}
  }
  budget.remainingNodes -= 1
  if (typeof value === "string") {
    const observedBytes = Buffer.byteLength(value, "utf8")
    const totalBudgetLimited = budget.remainingBytes < Math.min(observedBytes, COMMAND_ARTIFACT_STRING_MAX_BYTES)
    const configuredLimitBytes = Math.min(COMMAND_ARTIFACT_STRING_MAX_BYTES, budget.remainingBytes)
    const captured = truncateUtf8(value, configuredLimitBytes)
    const capturedBytes = Buffer.byteLength(captured, "utf8")
    budget.remainingBytes -= capturedBytes
    if (capturedBytes < observedBytes) {
      recordTruncation({
        path: truncateUtf8(path, COMMAND_ARTIFACT_PATH_MAX_BYTES),
        reason: totalBudgetLimited ? "total-string-byte-limit" : "string-byte-limit",
        observedBytes,
        capturedBytes,
        configuredLimitBytes,
      })
    }
    return captured
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => boundedArtifactValue(item, `${path}[${index}]`, budget, recordTruncation))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const capturedKey = truncateUtf8(key, COMMAND_ARTIFACT_KEY_MAX_BYTES)
      return [capturedKey, boundedArtifactValue(item, `${path}.${capturedKey}`, budget, recordTruncation)]
    }))
  }
  return value
}

function boundedIdentityString(value: string): string {
  return truncateUtf8(value, COMMAND_ARTIFACT_IDENTITY_MAX_BYTES)
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value

  let low = 0
  let high = Math.min(value.length, maxBytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle
    else high = middle - 1
  }
  const captured = value.slice(0, low)
  return /[\uD800-\uDBFF]$/.test(captured) ? captured.slice(0, -1) : captured
}
