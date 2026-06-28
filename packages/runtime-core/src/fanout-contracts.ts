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
export type FanoutResultValidationIssueCode = "schema-invalid" | "result-invalid"
export type HostDelegationStatus = "unavailable" | "accepted" | "completed" | "failed"
export type HostDelegationValidationIssueCode = "schema-invalid" | "request-invalid" | "result-invalid" | "request-id-mismatch" | "scope-mismatch" | "source-digest-mismatch"

export interface FanoutResultValidationIssue {
  code: FanoutResultValidationIssueCode
  path: string
  message: string
  details?: Record<string, unknown>
}

export interface FanoutResultValidationResult {
  valid: boolean
  issues: FanoutResultValidationIssue[]
}

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
  aggregator?: Record<string, unknown>
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

export interface FanoutWorkerResultRefContract {
  workerId: string
  status: string
  required: boolean
  resultRef?: string
  artifactRefs: Array<Record<string, unknown> & { path: string }>
  error?: { code?: string; message: string; details?: Record<string, unknown> }
  metadata?: Record<string, unknown>
}

export interface FanoutResultContract {
  schema: typeof FANOUT_RESULT_SCHEMA
  success: boolean
  status: "completed" | "failed" | (string & {})
  fanout_id: string
  sessionId?: string
  concurrency: number
  plan?: Record<string, unknown>
  workerResultRefs: FanoutWorkerResultRefContract[]
  aggregate?: Record<string, unknown>
  counts?: Record<string, unknown>
  execution?: Record<string, unknown>
  [key: string]: unknown
}

export function validateFanoutResultContract(input: unknown): FanoutResultValidationResult {
  const issues: FanoutResultValidationIssue[] = []
  const result = isRecord(input) ? input : undefined
  if (!result) {
    return { valid: false, issues: [{ code: "result-invalid", path: "", message: "Fanout result must be an object." }] }
  }

  if (result.schema !== FANOUT_RESULT_SCHEMA) {
    issues.push({ code: "schema-invalid", path: "schema", message: `Fanout result schema must be ${FANOUT_RESULT_SCHEMA}.` })
  }
  if (typeof result.success !== "boolean") {
    issues.push({ code: "result-invalid", path: "success", message: "Fanout result success must be a boolean." })
  }
  if (!stringValue(result.status)) {
    issues.push({ code: "result-invalid", path: "status", message: "Fanout result status must be a non-empty string." })
  }
  if (!stringValue(result.fanout_id)) {
    issues.push({ code: "result-invalid", path: "fanout_id", message: "Fanout result fanout_id must be a non-empty string." })
  }
  if (typeof result.concurrency !== "number" || !Number.isFinite(result.concurrency) || result.concurrency < 1) {
    issues.push({ code: "result-invalid", path: "concurrency", message: "Fanout result concurrency must be a positive number." })
  }
  if (!Array.isArray(result.workerResultRefs)) {
    issues.push({ code: "result-invalid", path: "workerResultRefs", message: "Fanout result workerResultRefs must be an array." })
  } else {
    result.workerResultRefs.forEach((worker, index) => validateFanoutWorkerResultRef(worker, `workerResultRefs.${index}`, issues))
  }
  if (result.aggregate !== undefined && !isRecord(result.aggregate)) {
    issues.push({ code: "result-invalid", path: "aggregate", message: "Fanout result aggregate must be an object when present." })
  }
  if (result.counts !== undefined && !isRecord(result.counts)) {
    issues.push({ code: "result-invalid", path: "counts", message: "Fanout result counts must be an object when present." })
  }

  return { valid: issues.length === 0, issues }
}

function validateFanoutWorkerResultRef(input: unknown, path: string, issues: FanoutResultValidationIssue[]): void {
  const worker = isRecord(input) ? input : undefined
  if (!worker) {
    issues.push({ code: "result-invalid", path, message: "Fanout worker result ref must be an object." })
    return
  }
  if (!stringValue(worker.workerId)) {
    issues.push({ code: "result-invalid", path: `${path}.workerId`, message: "Fanout worker result ref workerId must be a non-empty string." })
  }
  if (!stringValue(worker.status)) {
    issues.push({ code: "result-invalid", path: `${path}.status`, message: "Fanout worker result ref status must be a non-empty string." })
  }
  if (typeof worker.required !== "boolean") {
    issues.push({ code: "result-invalid", path: `${path}.required`, message: "Fanout worker result ref required must be a boolean." })
  }
  if (worker.resultRef !== undefined && !stringValue(worker.resultRef)) {
    issues.push({ code: "result-invalid", path: `${path}.resultRef`, message: "Fanout worker result ref resultRef must be a non-empty string when present." })
  }
  if (!Array.isArray(worker.artifactRefs)) {
    issues.push({ code: "result-invalid", path: `${path}.artifactRefs`, message: "Fanout worker result ref artifactRefs must be an array." })
  } else {
    worker.artifactRefs.forEach((artifact, index) => {
      if (!isRecord(artifact) || !stringValue(artifact.path)) {
        issues.push({ code: "result-invalid", path: `${path}.artifactRefs.${index}.path`, message: "Fanout worker artifact ref path must be a non-empty string." })
      }
    })
  }
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
