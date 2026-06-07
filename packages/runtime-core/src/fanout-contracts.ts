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
  session_id: string
  concurrency: number
  orchestrator: Record<string, unknown>
  workers: Array<{
    id: string
    agent: string
    goal: string
    artifact_namespace: string
  }>
}

export interface FanoutLifecycleEvent {
  schema: typeof FANOUT_EVENT_SCHEMA
  event: FanoutEventType
  time: string
  worker_id?: string
  status?: string
  active?: number
  total?: number
  completed?: number
  failed?: number
  cancelled?: number
}

export interface HostDelegationRequestContract {
  schema?: typeof HOST_DELEGATION_REQUEST_SCHEMA
  request_id?: string
  goal?: string
  task?: string
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
