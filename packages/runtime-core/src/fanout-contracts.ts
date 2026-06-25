export const FANOUT_REQUEST_SCHEMA = "wp-codebox/agent-fanout-request/v1" as const
export const FANOUT_PLAN_SCHEMA = "wp-codebox/agent-fanout-plan/v1" as const
export const FANOUT_WORKER_SCHEMA = "wp-codebox/agent-fanout-worker/v1" as const
export const FANOUT_RESULT_SCHEMA = "wp-codebox/agent-fanout-result/v1" as const
export const FANOUT_EVENT_SCHEMA = "wp-codebox/agent-fanout-event/v1" as const
export const HOST_DELEGATION_REQUEST_SCHEMA = "wp-codebox/host-delegation-request/v1" as const
export const HOST_DELEGATION_RESULT_SCHEMA = "wp-codebox/host-delegation-result/v1" as const
export const HOST_DELEGATION_EVENT_SCHEMA = "wp-codebox/host-delegation-event/v1" as const

export const FANOUT_EVENT_TYPES = [
  "fanout.started",
  "worker.started",
  "worker.completed",
  "worker.failed",
  "worker.skipped",
  "aggregation.started",
  "aggregation.completed",
  "fanout.completed",
  "fanout.failed",
] as const

export const HOST_DELEGATION_EVENT_TYPES = [
  "host-delegation.requested",
  "host-delegation.unavailable",
  "host-delegation.accepted",
  "host-delegation.completed",
  "host-delegation.failed",
] as const

export type FanoutEventType = (typeof FANOUT_EVENT_TYPES)[number]
export type HostDelegationEventType = (typeof HOST_DELEGATION_EVENT_TYPES)[number]
export type FanoutExecutionStrategy = "bounded-concurrent-isolated-sandboxes"
export type HostDelegationStatus = "unavailable" | "accepted" | "completed" | "failed"
export type HostDelegationValidationIssueCode = "schema-invalid" | "request-invalid" | "result-invalid" | "request-id-mismatch" | "scope-mismatch" | "source-digest-mismatch"

export interface HostDelegationValidationIssue {
  code: HostDelegationValidationIssueCode
  path: string
  message: string
  details?: Record<string, unknown>
}

export interface HostDelegationValidationResult {
  valid: boolean
  issues: HostDelegationValidationIssue[]
}

export interface FanoutWorkerContract {
  schema?: typeof FANOUT_WORKER_SCHEMA
  id: string
  goal: string
  task?: string
  agent?: string
  dependsOn?: string[]
  artifactNamespace?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface FanoutRequestContract {
  schema?: typeof FANOUT_REQUEST_SCHEMA
  workers: FanoutWorkerContract[]
  concurrency?: number
  agent?: string
  orchestrator?: Record<string, unknown>
  aggregation?: Record<string, unknown>
  [key: string]: unknown
}

export interface FanoutPlanContract {
  schema: typeof FANOUT_PLAN_SCHEMA
  fanout_id: string
  session_id: string
  concurrency: number
  orchestrator: Record<string, unknown>
  workers: Array<{
    id: string
    agent: string
    goal: string
    artifact_namespace: string
    depends_on?: string[]
  }>
}

export interface FanoutLifecycleEvent {
  schema: typeof FANOUT_EVENT_SCHEMA
  event: FanoutEventType
  time: string
  timestamp?: string
  phase?: string
  fanout_id?: string
  session_id?: string
  run_id?: string
  worker_id?: string
  status?: string
  label?: string
  detail?: Record<string, unknown>
  progress?: Record<string, unknown>
  artifacts?: Record<string, unknown> | unknown[]
  diagnostics?: Record<string, unknown>
  normalized_progress?: unknown
  active?: number
  total?: number
  completed?: number
  failed?: number
  skipped?: number
  cancelled?: number
  timed_out?: number
}

export interface HostDelegationRequestContract {
  schema?: typeof HOST_DELEGATION_REQUEST_SCHEMA
  request_id?: string
  sandbox_session_id?: string
  session_id?: string
  goal?: string
  task?: string
  source_digest?: string | { algorithm?: string; value?: string }
  target?: Record<string, unknown>
  context?: Record<string, unknown>
  expected_artifacts?: unknown[]
  execution?: Record<string, unknown>
  orchestrator?: Record<string, unknown>
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface HostDelegationLifecycleEvent {
  schema: typeof HOST_DELEGATION_EVENT_SCHEMA
  event: HostDelegationEventType
  time: string
  request_id: string
  status?: HostDelegationStatus
  provider?: string
}

export interface HostDelegationResultContract {
  success: boolean
  schema: typeof HOST_DELEGATION_RESULT_SCHEMA
  execution: "host-delegation"
  status: HostDelegationStatus
  request_id: string
  session_id?: string
  sandbox_session_id?: string
  source_digest?: string | { algorithm?: string; value?: string }
  request: HostDelegationRequestContract
  provider?: string
  result?: Record<string, unknown> | null
  error?: { code: string; message: string; data?: unknown } | null
  events: HostDelegationLifecycleEvent[]
  artifacts?: Record<string, unknown>
  timings?: Record<string, unknown>
  orchestrator?: Record<string, unknown>
}

export function isFanoutEventType(event: string): event is FanoutEventType {
  return FANOUT_EVENT_TYPES.includes(event as FanoutEventType)
}

export function isHostDelegationEventType(event: string): event is HostDelegationEventType {
  return HOST_DELEGATION_EVENT_TYPES.includes(event as HostDelegationEventType)
}

export function validateHostDelegationRequestContract(input: unknown): HostDelegationValidationResult {
  const issues: HostDelegationValidationIssue[] = []
  const request = isRecord(input) ? input : undefined
  if (!request) {
    return { valid: false, issues: [{ code: "request-invalid", path: "", message: "Host delegation request must be an object." }] }
  }

  if (request.schema !== undefined && request.schema !== HOST_DELEGATION_REQUEST_SCHEMA) {
    issues.push({ code: "schema-invalid", path: "schema", message: `Host delegation request schema must be ${HOST_DELEGATION_REQUEST_SCHEMA}.` })
  }
  if (!stringValue(request.goal) && !stringValue(request.task)) {
    issues.push({ code: "request-invalid", path: "goal", message: "Host delegation requests require a non-empty goal or task." })
  }
  for (const field of ["target", "context", "execution", "orchestrator", "metadata"] as const) {
    if (request[field] !== undefined && !isRecord(request[field])) {
      issues.push({ code: "request-invalid", path: field, message: `Host delegation request ${field} must be an object.` })
    }
  }
  if (request.expected_artifacts !== undefined && !Array.isArray(request.expected_artifacts)) {
    issues.push({ code: "request-invalid", path: "expected_artifacts", message: "Host delegation expected_artifacts must be an array." })
  }
  if (request.source_digest !== undefined && !digestValue(request.source_digest)) {
    issues.push({ code: "request-invalid", path: "source_digest", message: "Host delegation source_digest must be a 64-character sha256 digest." })
  }

  return { valid: issues.length === 0, issues }
}

export function validateHostDelegationResultContract(requestInput: unknown, resultInput: unknown): HostDelegationValidationResult {
  const issues: HostDelegationValidationIssue[] = []
  const request = isRecord(requestInput) ? requestInput : undefined
  const result = isRecord(resultInput) ? resultInput : undefined
  if (!request) {
    issues.push({ code: "request-invalid", path: "request", message: "Host delegation request must be an object." })
  }
  if (!result) {
    issues.push({ code: "result-invalid", path: "", message: "Host delegation result must be an object." })
    return { valid: false, issues }
  }

  if (result.schema !== undefined && result.schema !== HOST_DELEGATION_RESULT_SCHEMA) {
    issues.push({ code: "schema-invalid", path: "schema", message: `Host delegation result schema must be ${HOST_DELEGATION_RESULT_SCHEMA}.` })
  }
  const status = stringValue(result.status) || (result.success === false ? "failed" : "completed")
  if (!isHostDelegationStatus(status)) {
    issues.push({ code: "result-invalid", path: "status", message: "Host delegation result status must be accepted, completed, failed, or unavailable." })
  }
  if (result.result !== undefined && result.result !== null && !isRecord(result.result)) {
    issues.push({ code: "result-invalid", path: "result", message: "Host delegation result.result must be an object when present." })
  }

  if (request) {
    const expectedRequestId = stringValue(request.request_id)
    const actualRequestId = stringValue(result.request_id)
    if (expectedRequestId && actualRequestId && expectedRequestId !== actualRequestId) {
      issues.push({ code: "request-id-mismatch", path: "request_id", message: "Host delegation result request_id does not match the request.", details: { expected: expectedRequestId, actual: actualRequestId } })
    }
    const output = isRecord(result.result) ? result.result : {}
    const expectedSession = stringValue(request.sandbox_session_id) || stringValue(request.session_id)
    const actualSession = stringValue(result.sandbox_session_id) || stringValue(result.session_id) || stringValue(output.sandbox_session_id) || stringValue(output.session_id)
    if (expectedSession && actualSession && expectedSession !== actualSession) {
      issues.push({ code: "scope-mismatch", path: "session_id", message: "Host delegation result session scope does not match the request.", details: { expected: expectedSession, actual: actualSession } })
    }
    const expectedDigest = digestValue(request.source_digest)
    const actualDigest = digestValue(result.source_digest) || digestValue(output.source_digest)
    if (expectedDigest && actualDigest && expectedDigest !== actualDigest) {
      issues.push({ code: "source-digest-mismatch", path: "source_digest", message: "Host delegation result source digest does not match the request.", details: { expected: expectedDigest, actual: actualDigest } })
    }
  }

  return { valid: issues.length === 0, issues }
}

function isHostDelegationStatus(status: string): status is HostDelegationStatus {
  return ["accepted", "completed", "failed", "unavailable"].includes(status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function digestValue(value: unknown): string {
  const digest = typeof value === "string" ? value.trim().toLowerCase() : isRecord(value) ? stringValue(value.value).toLowerCase() : ""
  return /^[a-f0-9]{64}$/.test(digest) ? digest : ""
}
