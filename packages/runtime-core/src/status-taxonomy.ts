export type CommandEnvelopeStatus = "completed" | "failed" | "timed_out" | "cancelled" | "running" | "queued" | (string & {})
export type PhaseRecipeStatus = "succeeded" | "failed" | "partial" | "blocked" | "skipped" | "running" | (string & {})
export type AgentTaskStatus = "succeeded" | "failed" | "no_op" | "timeout" | "provider_error" | "unable_to_remediate" | (string & {})
export type CheckStatus = "passed" | "failed" | "warning" | "skipped" | "unknown" | (string & {})

export interface StatusConversionInput {
  status?: unknown
  success?: unknown
  exitStatus?: unknown
  timeout?: unknown
  providerError?: unknown
  unableToRemediate?: unknown
  noOp?: unknown
}

const AGENT_TASK_SUCCESS_STATUSES = new Set(["succeeded", "no_op"])
const AGENT_TASK_FAILURE_STATUSES = new Set(["failed", "timeout", "provider_error", "unable_to_remediate"])

export function normalizeCommandEnvelopeStatus(input: StatusConversionInput = {}): CommandEnvelopeStatus {
  const status = stringValue(input.status)
  if (["completed", "failed", "timed_out", "cancelled", "running", "queued"].includes(status)) return status
  if (["succeeded", "no_op", "passed"].includes(status)) return "completed"
  if (status === "timeout") return "timed_out"
  if (["provider_error", "unable_to_remediate", "blocked"].includes(status)) return "failed"
  if (status) return status
  if (input.timeout === true) return "timed_out"
  return input.success === true && numericExitStatus(input.exitStatus) === 0 ? "completed" : "failed"
}

export function normalizePhaseRecipeStatus(input: StatusConversionInput = {}): PhaseRecipeStatus {
  const status = stringValue(input.status)
  if (["succeeded", "failed", "partial", "blocked", "skipped", "running"].includes(status)) return status
  if (["completed", "passed", "no_op"].includes(status)) return "succeeded"
  if (["timeout", "provider_error", "unable_to_remediate", "timed_out"].includes(status)) return "failed"
  if (status) return status
  return input.success === true && numericExitStatus(input.exitStatus) === 0 ? "succeeded" : "failed"
}

export function normalizeAgentTaskStatus(input: StatusConversionInput = {}): AgentTaskStatus {
  const status = stringValue(input.status)
  if (["succeeded", "failed", "no_op", "timeout", "provider_error", "unable_to_remediate"].includes(status)) return status
  if (["completed", "passed"].includes(status)) return input.success === false || numericExitStatus(input.exitStatus) !== 0 ? "failed" : "succeeded"
  if (status === "timed_out") return "timeout"
  if (status === "blocked") return "unable_to_remediate"
  if (input.noOp === true) return "no_op"
  if (input.unableToRemediate === true) return "unable_to_remediate"
  if (input.timeout === true) return "timeout"
  if (input.providerError) return "provider_error"
  return input.success === true && numericExitStatus(input.exitStatus) === 0 ? "succeeded" : "failed"
}

export function normalizeCheckStatus(input: StatusConversionInput = {}): CheckStatus {
  const status = stringValue(input.status)
  if (["passed", "failed", "warning", "skipped", "unknown"].includes(status)) return status
  if (["succeeded", "completed", "no_op"].includes(status)) return "passed"
  if (["partial", "blocked"].includes(status)) return "warning"
  if (["timeout", "provider_error", "unable_to_remediate", "timed_out"].includes(status)) return "failed"
  if (status) return status
  return input.success === true && numericExitStatus(input.exitStatus) === 0 ? "passed" : "failed"
}

export function agentTaskStatusSucceeded(status: unknown): boolean {
  return AGENT_TASK_SUCCESS_STATUSES.has(stringValue(status))
}

export function agentTaskStatusFailed(status: unknown): boolean {
  return AGENT_TASK_FAILURE_STATUSES.has(stringValue(status))
}

function numericExitStatus(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
