export const RUN_PLAN_SCHEMA = "wp-codebox/run-plan/v1" as const
export const RUN_PLAN_EVENT_SCHEMA = "wp-codebox/run-plan-event/v1" as const
export const RUN_PLAN_PROGRESS_SCHEMA = "wp-codebox/run-plan-progress/v1" as const
export const RUN_PLAN_RESULT_SCHEMA = "wp-codebox/run-plan-result/v1" as const

export interface RunPlanWorkerContract {
  id: string
  goal?: string
  artifactNamespace?: string
  artifact_namespace?: string
  dependsOn?: string[]
  depends_on?: string[]
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
  skipped: number
  cancelled: number
  timed_out: number
}

export type RunPlanProgressStatus = "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "timed_out"

export interface RunPlanProgressWorkerSnapshot {
  id: string
  status: RunPlanProgressStatus
  required?: boolean
  artifactNamespace?: string
  lastEvent?: string
  startedAt?: string
  completedAt?: string
}

export interface RunPlanProgressSnapshot {
  schema: typeof RUN_PLAN_PROGRESS_SCHEMA
  time: string
  status: RunPlanProgressStatus
  active: number
  counts: RunPlanResultCounts
  workers: RunPlanProgressWorkerSnapshot[]
  sessionId?: string
  runId?: string
  eventsRef?: string
  resultRef?: string
  metadata?: Record<string, unknown>
}

export interface RunPlanWorkerExecution<TWorker extends RunPlanWorkerContract = RunPlanWorkerContract> {
  descriptor: RunPlanWorkerDescriptor<TWorker>
  index: number
}

export interface RunPlanWorkerResult<TOutput = unknown> extends RunPlanChildResult {
  workerId: string
  output?: TOutput
  error?: { code: string; message: string }
  [key: string]: unknown
}

export type RunPlanWorkerResultLike = { workerId: string; success?: boolean; status?: string }

export interface RunPlanWorkerAdapter<TWorker extends RunPlanWorkerContract = RunPlanWorkerContract, TResult extends RunPlanWorkerResultLike = RunPlanWorkerResult> {
  run(execution: RunPlanWorkerExecution<TWorker>): Promise<TResult>
}

export interface RunPlanExecutorOptions<TWorker extends RunPlanWorkerContract = RunPlanWorkerContract, TResult extends RunPlanWorkerResultLike = RunPlanWorkerResult> extends RunPlanNormalizationOptions {
  adapter: RunPlanWorkerAdapter<TWorker, TResult>
  clock?: RunPlanClock
  onWorkerStarted?: (descriptor: RunPlanWorkerDescriptor<TWorker>, index: number) => Promise<void> | void
  onWorkerCompleted?: (descriptor: RunPlanWorkerDescriptor<TWorker>, result: TResult, index: number) => Promise<void> | void
  onWorkerFailed?: (descriptor: RunPlanWorkerDescriptor<TWorker>, result: TResult, index: number) => Promise<void> | void
  onWorkerSkipped?: (descriptor: RunPlanWorkerDescriptor<TWorker>, result: TResult, index: number) => Promise<void> | void
  createSkippedResult?: (descriptor: RunPlanWorkerDescriptor<TWorker>, dependencies: TResult[]) => TResult
  createCancelledResult?: (descriptor: RunPlanWorkerDescriptor<TWorker>) => TResult
  createTimedOutResult?: (descriptor: RunPlanWorkerDescriptor<TWorker>, reason: string) => TResult
}

export type RunPlanClock = () => Date | string

export interface RunPlanExecutorResult<TResult extends RunPlanWorkerResultLike = RunPlanWorkerResult> {
  success: boolean
  concurrency: number
  counts: RunPlanResultCounts
  workers: TResult[]
}

export function countRunPlanChildResults(results: RunPlanChildResult[]): RunPlanResultCounts {
  const completed = results.filter((result) => result.success === true).length
  const skipped = results.filter((result) => result.status === "skipped").length
  const cancelled = results.filter((result) => result.status === "cancelled").length
  const timedOut = results.filter((result) => result.status === "timed_out" || result.status === "timeout").length

  return {
    total: results.length,
    completed,
    failed: results.length - completed - skipped - cancelled - timedOut,
    skipped,
    cancelled,
    timed_out: timedOut,
  }
}

export function runPlanSucceeded(counts: Pick<RunPlanResultCounts, "failed" | "skipped" | "cancelled" | "timed_out">): boolean {
  return counts.failed === 0 && counts.skipped === 0 && counts.cancelled === 0 && counts.timed_out === 0
}

export function normalizeRunPlanProgressSnapshot(input: {
  plan?: Partial<RunPlanContract>
  workers?: Array<Partial<RunPlanWorkerDescriptor> | RunPlanWorkerContract>
  results?: RunPlanWorkerResultLike[]
  events?: RunPlanEventContract[]
  sessionId?: string
  runId?: string
  eventsRef?: string
  resultRef?: string
  time?: string
  clock?: RunPlanClock
  metadata?: Record<string, unknown>
} = {}): RunPlanProgressSnapshot {
  const workerSources = input.workers ?? input.plan?.workers ?? []
  const resultByWorker = new Map((input.results ?? []).map((result) => [result.workerId, result]))
  const workerById = new Map<string, RunPlanProgressWorkerSnapshot>()

  for (const source of workerSources) {
    const worker = source as Partial<RunPlanWorkerDescriptor> & RunPlanWorkerContract
    const id = stringValue(worker.id)
    if (!id || workerById.has(id)) continue
    workerById.set(id, {
      id,
      status: "queued",
      ...(typeof worker.required === "boolean" ? { required: worker.required } : {}),
      ...(stringValue(worker.artifactNamespace ?? worker.artifact_namespace) ? { artifactNamespace: stringValue(worker.artifactNamespace ?? worker.artifact_namespace) } : {}),
    })
  }

  for (const event of input.events ?? []) {
    const workerId = stringValue(event.workerId)
    if (!workerId) continue
    const current = workerById.get(workerId) ?? { id: workerId, status: "queued" as const }
    const eventStatus = runPlanProgressStatusFromEvent(event)
    workerById.set(workerId, {
      ...current,
      status: eventStatus ?? current.status,
      lastEvent: stringValue(event.event) || current.lastEvent,
      ...(eventStatus === "running" && event.time ? { startedAt: event.time } : {}),
      ...((eventStatus && eventStatus !== "running" && event.time) ? { completedAt: event.time } : {}),
    })
  }

  for (const [workerId, result] of resultByWorker) {
    const current = workerById.get(workerId) ?? { id: workerId, status: "queued" as const }
    workerById.set(workerId, { ...current, status: runPlanProgressStatusFromResult(result) })
  }

  const workers = Array.from(workerById.values())
  const counts = countRunPlanProgressWorkers(workers)
  return {
    schema: RUN_PLAN_PROGRESS_SCHEMA,
    time: input.time ?? runPlanClockIso(input.clock),
    status: runPlanProgressStatusFromCounts(counts),
    active: workers.filter((worker) => worker.status === "running").length,
    counts,
    workers,
    ...(stringValue(input.sessionId ?? input.plan?.sessionId) ? { sessionId: stringValue(input.sessionId ?? input.plan?.sessionId) } : {}),
    ...(stringValue(input.runId ?? input.plan?.id) ? { runId: stringValue(input.runId ?? input.plan?.id) } : {}),
    ...(stringValue(input.eventsRef) ? { eventsRef: stringValue(input.eventsRef) } : {}),
    ...(stringValue(input.resultRef) ? { resultRef: stringValue(input.resultRef) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

export async function executeRunPlan<TWorker extends RunPlanWorkerContract, TResult extends RunPlanWorkerResultLike>(plan: Pick<RunPlanContract, "workers" | "concurrency">, options: RunPlanExecutorOptions<TWorker, TResult>): Promise<RunPlanExecutorResult<TResult>> {
  const workers = normalizeRunPlanWorkerDescriptors(plan.workers as TWorker[], options)
  validateRunPlanDependencies(workers)
  const concurrency = normalizeRunPlanConcurrency(plan.concurrency, options)
  const results = await runDependencyAwareConcurrent(workers, concurrency, async (descriptor, index) => {
    if (descriptor.cancellation.cancelRequested) {
      const result = options.createCancelledResult?.(descriptor) ?? defaultCancelledRunPlanResult(descriptor) as TResult
      await options.onWorkerFailed?.(descriptor, result, index)
      return result
    }

    const executionTimeoutMs = runPlanWorkerExecutionTimeoutMs(descriptor, options.clock)
    if (executionTimeoutMs === 0) {
      const result = options.createTimedOutResult?.(descriptor, "deadline") ?? defaultTimedOutRunPlanResult(descriptor, "deadline") as TResult
      await options.onWorkerFailed?.(descriptor, result, index)
      return result
    }

    await options.onWorkerStarted?.(descriptor, index)
    const result = await runPlanWorkerWithTimeout(options.adapter.run({ descriptor, index }), descriptor, executionTimeoutMs, options)
    if (result.success === true) {
      await options.onWorkerCompleted?.(descriptor, result, index)
    } else {
      await options.onWorkerFailed?.(descriptor, result, index)
    }
    return result
  }, async (descriptor, dependencies) => {
    const result = options.createSkippedResult?.(descriptor, dependencies) ?? defaultSkippedRunPlanResult(descriptor, dependencies) as TResult
    await options.onWorkerSkipped?.(descriptor, result, descriptor.index)
    return result
  })
  const counts = countRunPlanChildResults(results)

  return {
    success: runPlanSucceeded(counts),
    concurrency,
    counts,
    workers: results,
  }
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
      dependsOn: stringList(worker.dependsOn ?? worker.depends_on),
      timeoutSeconds: positiveInteger(worker.timeoutSeconds ?? worker.timeout_seconds ?? worker.task_timeout_seconds),
      cancellation: runPlanCancellationMetadata(worker),
    }
  })
}

export function validateRunPlanDependencies<TWorker extends RunPlanWorkerContract>(workers: Array<RunPlanWorkerDescriptor<TWorker>>): void {
  const byId = new Map(workers.map((worker) => [worker.id, worker]))
  for (const worker of workers) {
    for (const dependency of worker.dependsOn) {
      if (dependency === worker.id) {
        throw new Error(`Run plan worker cannot depend on itself: ${worker.id}`)
      }
      if (!byId.has(dependency)) {
        throw new Error(`Run plan worker ${worker.id} depends on unknown worker: ${dependency}`)
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (worker: RunPlanWorkerDescriptor<TWorker>): void => {
    if (visited.has(worker.id)) return
    if (visiting.has(worker.id)) {
      throw new Error(`Run plan dependencies contain a cycle at worker: ${worker.id}`)
    }
    visiting.add(worker.id)
    for (const dependency of worker.dependsOn) {
      visit(byId.get(dependency) as RunPlanWorkerDescriptor<TWorker>)
    }
    visiting.delete(worker.id)
    visited.add(worker.id)
  }

  for (const worker of workers) visit(worker)
}

export function createRunPlanEvent<TEvent>(schema: string, event: Omit<TEvent, "schema" | "time"> & { time?: string }, options: { clock?: RunPlanClock } = {}): TEvent {
  return { schema, time: event.time ?? runPlanClockIso(options.clock), ...event } as TEvent
}

export function runPlanClockIso(clock?: RunPlanClock): string {
  const value = clock ? clock() : new Date()
  return typeof value === "string" ? value : value.toISOString()
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

export async function runDependencyAwareConcurrent<T extends { id: string; index: number; dependsOn: string[] }, R extends { success?: boolean; status?: string }>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>, skipped: (item: T, dependencies: R[]) => Promise<R> | R): Promise<R[]> {
  const effectiveConcurrency = normalizeRunPlanConcurrency(concurrency, { maxConcurrency: items.length || 1 })
  const byId = new Map(items.map((item) => [item.id, item]))
  const results = new Array<R>(items.length)
  const completed = new Set<string>()
  const running = new Set<string>()
  let active = 0

  return new Promise((resolve, reject) => {
    const pump = (): void => {
      try {
        let progressed = false
        for (const item of items) {
          if (completed.has(item.id) || running.has(item.id)) continue
          const dependencyResults = item.dependsOn.map((dependency) => results[(byId.get(dependency) as T).index])
          if (dependencyResults.length !== item.dependsOn.length || dependencyResults.some((result) => !result)) continue
          if (dependencyResults.some((result) => result && result.success !== true)) {
            running.add(item.id)
            active++
            progressed = true
            Promise.resolve(skipped(item, dependencyResults.filter((result): result is R => Boolean(result))))
              .then((result) => {
                results[item.index] = result
                running.delete(item.id)
                completed.add(item.id)
                active--
                pump()
              })
              .catch(reject)
            continue
          }
          if (active >= effectiveConcurrency) continue
          running.add(item.id)
          active++
          progressed = true
          Promise.resolve(worker(item, item.index))
            .then((result) => {
              results[item.index] = result
              running.delete(item.id)
              completed.add(item.id)
              active--
              pump()
            })
            .catch(reject)
        }
        if (completed.size === items.length && active === 0) {
          resolve(results)
        } else if (!progressed && active === 0) {
          reject(new Error("Run plan dependencies could not be scheduled."))
        }
      } catch (error) {
        reject(error)
      }
    }
    pump()
  })
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

export function runPlanWorkerExecutionTimeoutMs(descriptor: RunPlanWorkerDescriptor, clock?: RunPlanClock): number | undefined {
  const limits: number[] = []
  if (descriptor.timeoutSeconds) {
    limits.push(descriptor.timeoutSeconds * 1000)
  }
  if (descriptor.cancellation.deadline) {
    const deadlineMs = Date.parse(descriptor.cancellation.deadline)
    const nowMs = Date.parse(runPlanClockIso(clock))
    if (Number.isFinite(deadlineMs) && Number.isFinite(nowMs)) {
      limits.push(Math.max(0, deadlineMs - nowMs))
    }
  }

  return limits.length > 0 ? Math.min(...limits) : undefined
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : []
}

function defaultSkippedRunPlanResult<TWorker extends RunPlanWorkerContract, TResult extends RunPlanWorkerResultLike>(descriptor: RunPlanWorkerDescriptor<TWorker>, dependencies: TResult[]): TResult {
  return {
    workerId: descriptor.id,
    success: false,
    status: "skipped",
    error: { code: "dependency-skipped", message: `Run plan worker ${descriptor.id} skipped because a dependency did not complete successfully.` },
    dependencies: dependencies.map((dependency) => ({ workerId: dependency.workerId, status: dependency.status, success: dependency.success })),
  } as unknown as TResult
}

function runPlanWorkerWithTimeout<TWorker extends RunPlanWorkerContract, TResult extends RunPlanWorkerResultLike>(operation: Promise<TResult>, descriptor: RunPlanWorkerDescriptor<TWorker>, timeoutMs: number | undefined, options: RunPlanExecutorOptions<TWorker, TResult>): Promise<TResult> {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return operation
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(options.createTimedOutResult?.(descriptor, "timeout") ?? defaultTimedOutRunPlanResult(descriptor, "timeout") as TResult)
    }, Math.max(0, Math.round(timeoutMs)))
    operation.then((result) => {
      clearTimeout(timeout)
      resolve(result)
    }).catch((error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function defaultCancelledRunPlanResult<TWorker extends RunPlanWorkerContract, TResult extends RunPlanWorkerResultLike>(descriptor: RunPlanWorkerDescriptor<TWorker>): TResult {
  return {
    workerId: descriptor.id,
    success: false,
    status: "cancelled",
    error: { code: "worker-cancelled", message: descriptor.cancellation.reason || `Run plan worker ${descriptor.id} was cancelled before execution.` },
  } as unknown as TResult
}

function defaultTimedOutRunPlanResult<TWorker extends RunPlanWorkerContract, TResult extends RunPlanWorkerResultLike>(descriptor: RunPlanWorkerDescriptor<TWorker>, reason: string): TResult {
  return {
    workerId: descriptor.id,
    success: false,
    status: "timed_out",
    error: { code: "worker-timed-out", message: `Run plan worker ${descriptor.id} exceeded its ${reason}.` },
  } as unknown as TResult
}

function countRunPlanProgressWorkers(workers: RunPlanProgressWorkerSnapshot[]): RunPlanResultCounts {
  return {
    total: workers.length,
    completed: workers.filter((worker) => worker.status === "succeeded").length,
    failed: workers.filter((worker) => worker.status === "failed").length,
    skipped: workers.filter((worker) => worker.status === "skipped").length,
    cancelled: workers.filter((worker) => worker.status === "cancelled").length,
    timed_out: workers.filter((worker) => worker.status === "timed_out").length,
  }
}

function runPlanProgressStatusFromResult(result: RunPlanWorkerResultLike): RunPlanProgressStatus {
  if (result.success === true) return "succeeded"
  const status = stringValue(result.status)
  if (status === "cancelled" || status === "skipped" || status === "timed_out" || status === "timeout") return status === "timeout" ? "timed_out" : status
  return "failed"
}

function runPlanProgressStatusFromEvent(event: RunPlanEventContract): RunPlanProgressStatus | undefined {
  const label = `${stringValue(event.event)} ${stringValue(event.status)}`
  if (/started|running/.test(label)) return "running"
  if (/completed|succeeded|success/.test(label)) return "succeeded"
  if (/cancelled|canceled/.test(label)) return "cancelled"
  if (/timed[_ -]?out|timeout/.test(label)) return "timed_out"
  if (/skipped/.test(label)) return "skipped"
  if (/failed|error/.test(label)) return "failed"
  return undefined
}

function runPlanProgressStatusFromCounts(counts: RunPlanResultCounts): RunPlanProgressStatus {
  const settled = counts.completed + counts.failed + counts.skipped + counts.cancelled + counts.timed_out
  if (settled < counts.total) return "running"
  if (counts.timed_out > 0) return "timed_out"
  if (counts.cancelled > 0) return "cancelled"
  if (counts.failed > 0) return "failed"
  if (counts.skipped > 0) return "skipped"
  return "succeeded"
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}
