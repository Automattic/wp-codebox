export const FANOUT_REQUEST_SCHEMA = "wp-codebox/agent-fanout-request/v1" as const
export const FANOUT_PLAN_SCHEMA = "wp-codebox/agent-fanout-plan/v1" as const
export const FANOUT_WORKER_SCHEMA = "wp-codebox/agent-fanout-worker/v1" as const
export const FANOUT_RESULT_SCHEMA = "wp-codebox/agent-fanout-result/v1" as const
export const FANOUT_EVENT_SCHEMA = "wp-codebox/agent-fanout-event/v1" as const

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

export type FanoutEventType = (typeof FANOUT_EVENT_TYPES)[number]
export type FanoutExecutionStrategy = "bounded-concurrent-isolated-sandboxes"

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

export function isFanoutEventType(event: string): event is FanoutEventType {
  return FANOUT_EVENT_TYPES.includes(event as FanoutEventType)
}
