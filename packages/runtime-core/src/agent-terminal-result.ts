import { isPlainObject, stripUndefined } from "./object-utils.js"

export const AGENT_TERMINAL_RESULT_SCHEMA = "wp-codebox/agent-terminal-result/v1" as const

export type AgentTerminalStatus = "succeeded" | "failed" | "incomplete" | "timeout" | "provider_error" | "max_turns" | "unknown" | (string & {})
export type AgentTerminalFailureClassification = "provider" | "timeout" | "runtime" | "task" | "incomplete" | "max_turns" | (string & {})

export interface AgentTerminalResult {
  schema: typeof AGENT_TERMINAL_RESULT_SCHEMA
  terminal: boolean
  status: AgentTerminalStatus
  success: boolean
  source: "canonical" | "legacy-fallback" | (string & {})
  failure_classification?: AgentTerminalFailureClassification
  pending_tools?: {
    detected: boolean
    count?: number
    names?: string[]
  }
  max_turns?: {
    reached: boolean
    current?: number
    max?: number
  }
  evidence_refs: Array<Record<string, unknown>>
  diagnostics?: Array<Record<string, unknown>>
  raw?: Record<string, unknown>
}

export interface AgentTerminalResultOptions {
  compatMode?: boolean
}

export function normalizeAgentTerminalResult(raw: unknown, options: AgentTerminalResultOptions = {}): AgentTerminalResult | undefined {
  const record = objectValue(raw)
  if (Object.keys(record).length === 0) return undefined

  const canonical = canonicalTerminalResultRecord(record)
  if (canonical) {
    return buildTerminalResult(canonical, "canonical")
  }

  const nestedCanonical = legacyTerminalResultRecord(record)
  if (nestedCanonical && canonicalTerminalResultRecord(nestedCanonical)) {
    return buildTerminalResult(nestedCanonical, "canonical")
  }

  if (!options.compatMode) return undefined

  const legacy = legacyTerminalResult(record)
  return legacy ? withCompatibilityDiagnostic(legacy, "agent-terminal-result-legacy-shape") : undefined
}

function canonicalTerminalResultRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (record.schema === AGENT_TERMINAL_RESULT_SCHEMA || (typeof record.terminal === "boolean" && typeof record.status === "string" && typeof record.success === "boolean")) {
    return record
  }

  return undefined
}

function legacyTerminalResultRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const candidate of [record.terminal_result, record.terminalResult]) {
    const value = objectValue(candidate)
    if (Object.keys(value).length > 0) return value
  }

  const directResult = objectValue(record.result)
  for (const candidate of [directResult.terminal_result, directResult.terminalResult]) {
    const value = objectValue(candidate)
    if (Object.keys(value).length > 0) return value
  }

  const runtime = objectValue(record.agent_runtime)
  for (const candidate of [runtime.terminal_result, runtime.terminalResult]) {
    const value = objectValue(candidate)
    if (Object.keys(value).length > 0) return value
  }

  const runtimeResult = objectValue(runtime.result)
  for (const candidate of [runtimeResult.terminal_result, runtimeResult.terminalResult]) {
    const value = objectValue(candidate)
    if (Object.keys(value).length > 0) return value
  }

  return undefined
}

function buildTerminalResult(record: Record<string, unknown>, source: AgentTerminalResult["source"]): AgentTerminalResult {
  const pendingTools = normalizePendingTools(record.pending_tools ?? record.pendingTools ?? record.has_pending_tools ?? record.hasPendingTools)
  const maxTurns = normalizeMaxTurns(record.max_turns ?? record.maxTurns, record)
  const status = normalizeStatus(stringValue(record.status) || stringValue(record.terminal_status) || stringValue(record.terminalStatus), record, pendingTools, maxTurns)
  const success = typeof record.success === "boolean" ? record.success : status === "succeeded"

  return stripUndefined({
    schema: AGENT_TERMINAL_RESULT_SCHEMA,
    terminal: typeof record.terminal === "boolean" ? record.terminal : isTerminalStatus(status),
    status,
    success,
    source,
    failure_classification: stringValue(record.failure_classification) || stringValue(record.failureClassification) || failureClassificationForStatus(status) || undefined,
    pending_tools: pendingTools,
    max_turns: maxTurns,
    evidence_refs: evidenceRefs(record),
    raw: source === "canonical" ? undefined : record,
  }) as AgentTerminalResult
}

function legacyTerminalResult(record: Record<string, unknown>): AgentTerminalResult | undefined {
  const nested = legacyTerminalResultRecord(record)
  if (nested) return buildTerminalResult(nested, "legacy-fallback")

  const runtime = objectValue(record.agent_runtime)
  const runtimeResult = runtime.success === true ? objectValue(runtime.result) : {}
  const candidates = [runtimeResult, record].filter((candidate) => Object.keys(candidate).length > 0)

  for (const candidate of candidates) {
    const pendingTools = normalizePendingTools(candidate.pending_tools ?? candidate.pendingTools ?? candidate.has_pending_tools ?? candidate.hasPendingTools)
    const maxTurns = normalizeMaxTurns(candidate.max_turns ?? candidate.maxTurns, candidate)
    const status = normalizeStatus(stringValue(candidate.status) || stringValue(candidate.state), candidate, pendingTools, maxTurns)
    const completed = typeof candidate.completed === "boolean" ? candidate.completed : undefined
    const incomplete = pendingTools?.detected || maxTurns?.reached || status === "processing" || status === "incomplete" || completed === false
    if (!incomplete) continue

    return buildTerminalResult({
      status: maxTurns?.reached ? "max_turns" : "incomplete",
      success: false,
      terminal: true,
      failure_classification: maxTurns?.reached ? "max_turns" : "incomplete",
      pending_tools: pendingTools,
      max_turns: maxTurns,
      evidence_refs: evidenceRefs(candidate),
      legacy_status: status,
      completed,
    }, "legacy-fallback")
  }

  return undefined
}

function withCompatibilityDiagnostic(result: AgentTerminalResult, adapter: string): AgentTerminalResult {
  return {
    ...result,
    diagnostics: [
      ...(result.diagnostics ?? []),
      {
        class: "wp-codebox.normalizer.compat_mode_used",
        message: "Agent terminal result was parsed using explicit normalizer compatibility mode.",
        data: { adapter },
      },
    ],
  }
}

function normalizeStatus(status: string, record: Record<string, unknown>, pendingTools?: AgentTerminalResult["pending_tools"], maxTurns?: AgentTerminalResult["max_turns"]): AgentTerminalStatus {
  if (status) return status as AgentTerminalStatus
  if (maxTurns?.reached) return "max_turns"
  if (pendingTools?.detected) return "incomplete"
  if (record.timeout === true) return "timeout"
  if (record.provider_error) return "provider_error"
  if (record.success === true) return "succeeded"
  if (record.success === false) return "failed"
  return "unknown"
}

function normalizePendingTools(value: unknown): AgentTerminalResult["pending_tools"] | undefined {
  if (value === true) return { detected: true }
  if (Array.isArray(value)) return { detected: value.length > 0, count: value.length, names: value.map(String).filter(Boolean) }
  const record = objectValue(value)
  if (Object.keys(record).length === 0) return undefined
  const names = Array.isArray(record.names) ? record.names.map(String).filter(Boolean) : undefined
  const count = numberValue(record.count) ?? names?.length
  const detected = typeof record.detected === "boolean" ? record.detected : Boolean(count && count > 0)
  return stripUndefined({ detected, count, names })
}

function normalizeMaxTurns(value: unknown, record: Record<string, unknown>): AgentTerminalResult["max_turns"] | undefined {
  const maxTurnsRecord = objectValue(value)
  const current = numberValue(maxTurnsRecord.current) ?? numberValue(record.current_turn) ?? numberValue(record.currentTurn)
  const max = numberValue(maxTurnsRecord.max) ?? numberValue(record.max_turns) ?? numberValue(record.maxTurns)
  const reached = typeof maxTurnsRecord.reached === "boolean"
    ? maxTurnsRecord.reached
    : record.max_turns_reached === true || record.maxTurnsReached === true || (current !== undefined && max !== undefined && max > 0 && current >= max)
  if (!reached && current === undefined && max === undefined) return undefined
  return stripUndefined({ reached, current, max })
}

function evidenceRefs(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = record.evidence_refs ?? record.evidenceRefs
  return Array.isArray(value) ? value.filter(isPlainObject) : []
}

function failureClassificationForStatus(status: AgentTerminalStatus): AgentTerminalFailureClassification | "" {
  if (status === "provider_error") return "provider"
  if (status === "timeout") return "timeout"
  if (status === "incomplete") return "incomplete"
  if (status === "max_turns") return "max_turns"
  if (status === "failed") return "runtime"
  return ""
}

function isTerminalStatus(status: AgentTerminalStatus): boolean {
  return !["processing", "active", "pending", "unknown"].includes(status)
}

function objectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}
