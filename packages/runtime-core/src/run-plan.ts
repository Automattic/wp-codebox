export const RUN_PLAN_SCHEMA = "wp-codebox/run-plan/v1" as const
export const RUN_PLAN_EVENT_SCHEMA = "wp-codebox/run-plan-event/v1" as const
export const RUN_PLAN_RESULT_SCHEMA = "wp-codebox/run-plan-result/v1" as const

export interface RunPlanWorkerContract {
  id: string
  goal?: string
  artifactNamespace?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface RunPlanContract {
  schema?: typeof RUN_PLAN_SCHEMA | string
  id?: string
  sessionId?: string
  concurrency: number
  workers: RunPlanWorkerContract[]
  orchestrator?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface RunPlanEventContract {
  schema?: typeof RUN_PLAN_EVENT_SCHEMA | string
  event: string
  time?: string
  workerId?: string
  status?: string
  active?: number
  total?: number
  completed?: number
  failed?: number
  cancelled?: number
  metadata?: Record<string, unknown>
}

export interface RunPlanChildResult {
  success?: boolean
  status?: string
  [key: string]: unknown
}

export interface RunPlanResultCounts {
  total: number
  completed: number
  failed: number
  cancelled: number
}

export function countRunPlanChildResults(results: RunPlanChildResult[]): RunPlanResultCounts {
  const completed = results.filter((result) => result.success === true).length
  const cancelled = results.filter((result) => result.status === "cancelled").length

  return {
    total: results.length,
    completed,
    failed: results.length - completed - cancelled,
    cancelled,
  }
}

export function runPlanSucceeded(counts: Pick<RunPlanResultCounts, "failed" | "cancelled">): boolean {
  return counts.failed === 0 && counts.cancelled === 0
}
