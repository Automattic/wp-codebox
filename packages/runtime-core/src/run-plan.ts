export const RUN_PLAN_SCHEMA = "wp-codebox/run-plan/v1" as const
export const RUN_PLAN_EVENT_SCHEMA = "wp-codebox/run-plan-event/v1" as const
export const RUN_PLAN_RESULT_SCHEMA = "wp-codebox/run-plan-result/v1" as const

export interface RunPlanWorkerContract {
  id: string
  goal?: string
  artifactNamespace?: string
  artifact_namespace?: string
  required?: boolean
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

export interface RunPlanWorkerDescriptor<TWorker extends RunPlanWorkerContract = RunPlanWorkerContract> {
  id: string
  index: number
  worker: TWorker
  goal: string
  agent: string
  artifactNamespace: string
  required: boolean
  dependsOn: string[]
  timeoutSeconds?: number
  cancellation: RunPlanCancellationMetadata
}

export interface RunPlanNormalizationOptions {
  defaultAgent?: string
  defaultConcurrency?: number
  maxConcurrency?: number
  requireGoal?: boolean
  concurrencyMode?: "clamp" | "validate"
}

export interface RunPlanCancellationMetadata {
  cancelRequested: boolean
  reason?: string
  timeoutSeconds?: number
  deadline?: string
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

export function normalizeRunPlanConcurrency(value: unknown, options: Pick<RunPlanNormalizationOptions, "defaultConcurrency" | "maxConcurrency" | "concurrencyMode"> = {}): number {
  const defaultConcurrency = Math.max(1, Math.floor(Number(options.defaultConcurrency) || 1))
  const maxConcurrency = Math.max(1, Math.floor(Number(options.maxConcurrency) || Number.MAX_SAFE_INTEGER))
  const requested = Math.floor(Number(value) || defaultConcurrency)

  if (options.concurrencyMode === "validate" && (requested < 1 || requested > maxConcurrency)) {
    throw new Error(`Run plan concurrency must be between 1 and ${maxConcurrency}.`)
  }

  return Math.max(1, Math.min(maxConcurrency, requested))
}

export function normalizeRunPlanWorkerDescriptors<TWorker extends RunPlanWorkerContract>(workers: TWorker[], options: RunPlanNormalizationOptions = {}): Array<RunPlanWorkerDescriptor<TWorker>> {
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new Error("Run plan requires at least one worker.")
  }

  const seen = new Set<string>()
  return workers.map((worker, index) => {
    const id = safeRunPlanPathSegment(worker.id)
    if (seen.has(id)) {
      throw new Error(`Run plan worker ids must be unique: ${id}`)
    }
    seen.add(id)

    const goal = stringValue(worker.goal)
    if (options.requireGoal && !goal) {
      throw new Error(`Run plan worker requires goal: ${id}`)
    }

    return {
      id,
      index,
      worker: { ...worker, id },
      goal,
      agent: stringValue(worker.agent) || stringValue(options.defaultAgent),
      artifactNamespace: safeRunPlanNamespace(stringValue(worker.artifactNamespace ?? worker.artifact_namespace) || id),
      required: worker.required !== false,
      dependsOn: Array.isArray(worker.dependsOn) ? worker.dependsOn.filter((dependency): dependency is string => typeof dependency === "string") : [],
      timeoutSeconds: positiveInteger(worker.timeoutSeconds ?? worker.timeout_seconds ?? worker.task_timeout_seconds),
      cancellation: runPlanCancellationMetadata(worker),
    }
  })
}

export function createRunPlanEvent<TEvent>(schema: string, event: Omit<TEvent, "schema" | "time"> & { time?: string }): TEvent {
  return { schema, time: event.time ?? new Date().toISOString(), ...event } as TEvent
}

export async function runBoundedConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const effectiveConcurrency = normalizeRunPlanConcurrency(concurrency, { maxConcurrency: items.length || 1 })
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(effectiveConcurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export function runPlanCancellationMetadata(source: Record<string, unknown>): RunPlanCancellationMetadata {
  const timeoutSeconds = positiveInteger(source.timeoutSeconds ?? source.timeout_seconds ?? source.task_timeout_seconds)
  return {
    cancelRequested: Boolean(source.cancelRequested ?? source.cancel_requested ?? source.cancelled),
    ...(stringValue(source.cancelReason ?? source.cancel_reason) ? { reason: stringValue(source.cancelReason ?? source.cancel_reason) } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
    ...(stringValue(source.deadline) ? { deadline: stringValue(source.deadline) } : {}),
  }
}

export function safeRunPlanPathSegment(value: unknown): string {
  const segment = stringValue(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) {
    throw new Error(`Run plan path segment must be safe: ${segment || "<empty>"}`)
  }
  return segment
}

export function safeRunPlanNamespace(value: unknown): string {
  const namespace = stringValue(value)
  if (!namespace || namespace.split("/").some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new Error(`Run plan namespace must contain safe path segments: ${namespace || "<empty>"}`)
  }
  return namespace
}

function positiveInteger(value: unknown): number | undefined {
  const number = Math.floor(Number(value) || 0)
  return number > 0 ? number : undefined
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}
