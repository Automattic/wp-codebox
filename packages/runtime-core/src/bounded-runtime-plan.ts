import { normalizeRunPlanConcurrency, safeRunPlanNamespace } from "./run-plan.js"

/** A generic aggregate command plan; PHPUnit is one consumer, not a special case. */
export const BOUNDED_RUNTIME_PLAN_SCHEMA = "wp-codebox/bounded-runtime-plan/v1" as const
export const BOUNDED_RUNTIME_PLAN_RESULT_SCHEMA = "wp-codebox/bounded-runtime-plan-result/v1" as const

export interface BoundedRuntimePlanEntry {
  id: string
  argv: string[]
  environment?: Record<string, string>
  timeoutMs?: number
  processIdentity: string
  artifactNamespace: string
  inputIndex: number
}

export interface BoundedRuntimePlan {
  schema: typeof BOUNDED_RUNTIME_PLAN_SCHEMA
  concurrency: number
  failFast?: boolean
  entries: BoundedRuntimePlanEntry[]
}

export type BoundedRuntimePlanEntryStatus = "succeeded" | "failed" | "timed_out" | "cancelled"

export interface BoundedRuntimePlanEntryResult {
  id: string
  inputIndex: number
  processIdentity: string
  artifactNamespace: string
  status: BoundedRuntimePlanEntryStatus
  success: boolean
  durationMs: number
  exitCode?: number
  stdoutRef?: string
  stderrRef?: string
  resultRef?: string
  artifactRefs?: string[]
  error?: { code: "execution-failed" | "execution-threw" | "timed-out" | "fail-fast"; message: string }
}

export interface BoundedRuntimePlanResult {
  schema: typeof BOUNDED_RUNTIME_PLAN_RESULT_SCHEMA
  success: boolean
  concurrency: number
  counts: { total: number; succeeded: number; failed: number; timedOut: number; cancelled: number }
  entries: BoundedRuntimePlanEntryResult[]
}

export interface BoundedRuntimePlanExecution<TWorkspace = unknown, TRuntime = unknown, TServices = unknown> {
  entry: BoundedRuntimePlanEntry
  workspace: TWorkspace
  runtime: TRuntime
  services: TServices
  signal: AbortSignal
}

/**
 * Lifecycle ownership is deliberately external: callers decide how a workspace,
 * runtime, and disposable services are created, while this primitive guarantees
 * that each lifecycle boundary is reached at most once per aggregate.
 */
export interface BoundedRuntimePlanAdapter<TWorkspace = unknown, TRuntime = unknown, TServices = unknown> {
  materialize(): Promise<{ workspace: TWorkspace; runtime: TRuntime }>
  startServices(context: { workspace: TWorkspace; runtime: TRuntime }): Promise<TServices>
  execute(context: BoundedRuntimePlanExecution<TWorkspace, TRuntime, TServices>): Promise<{ success: boolean; exitCode?: number; message?: string; stdoutRef?: string; stderrRef?: string; resultRef?: string; artifactRefs?: string[] }>
  onEntryResult?(result: BoundedRuntimePlanEntryResult): Promise<void>
  stopServices(context: { workspace: TWorkspace; runtime: TRuntime; services: TServices }): Promise<void>
  dispose(context: { workspace: TWorkspace; runtime: TRuntime }): Promise<void>
}

export function validateBoundedRuntimePlan(plan: BoundedRuntimePlan): void {
  if (plan.schema !== BOUNDED_RUNTIME_PLAN_SCHEMA) throw new Error(`Bounded runtime plan schema must be ${BOUNDED_RUNTIME_PLAN_SCHEMA}.`)
  if (!Array.isArray(plan.entries) || plan.entries.length === 0) throw new Error("Bounded runtime plan requires at least one entry.")
  normalizeRunPlanConcurrency(plan.concurrency, { concurrencyMode: "validate", maxConcurrency: plan.entries.length })
  const ids = new Set<string>()
  const inputIndexes = new Set<number>()
  for (const entry of plan.entries) {
    if (!safeIdentifier(entry.id) || ids.has(entry.id)) throw new Error(`Bounded runtime plan entry ids must be unique safe identifiers: ${entry.id || "<empty>"}`)
    ids.add(entry.id)
    if (!safeIdentifier(entry.processIdentity)) throw new Error(`Bounded runtime plan process identity must be a safe identifier: ${entry.processIdentity || "<empty>"}`)
    safeRunPlanNamespace(entry.artifactNamespace)
    if (!Array.isArray(entry.argv) || entry.argv.some((argument) => typeof argument !== "string")) throw new Error(`Bounded runtime plan entry argv must be a string array: ${entry.id}`)
    if (!Number.isInteger(entry.inputIndex) || entry.inputIndex < 0 || inputIndexes.has(entry.inputIndex)) throw new Error(`Bounded runtime plan input indexes must be unique non-negative integers: ${entry.id}`)
    inputIndexes.add(entry.inputIndex)
    if (entry.timeoutMs !== undefined && (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0)) throw new Error(`Bounded runtime plan timeout must be positive: ${entry.id}`)
    if (entry.environment && Object.entries(entry.environment).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string")) throw new Error(`Bounded runtime plan environment must contain string environment overrides: ${entry.id}`)
  }
}

export async function executeBoundedRuntimePlan<TWorkspace, TRuntime, TServices>(plan: BoundedRuntimePlan, adapter: BoundedRuntimePlanAdapter<TWorkspace, TRuntime, TServices>): Promise<BoundedRuntimePlanResult> {
  validateBoundedRuntimePlan(plan)
  const concurrency = normalizeRunPlanConcurrency(plan.concurrency, { concurrencyMode: "validate", maxConcurrency: plan.entries.length })
  let materialized: { workspace: TWorkspace; runtime: TRuntime } | undefined
  let services: TServices | undefined
  let servicesStarted = false
  try {
    materialized = await adapter.materialize()
    services = await adapter.startServices(materialized)
    servicesStarted = true
    const entries = await executeEntries(plan, concurrency, materialized, services, adapter)
    return {
      schema: BOUNDED_RUNTIME_PLAN_RESULT_SCHEMA,
      success: entries.every((entry) => entry.success),
      concurrency,
      counts: boundedRuntimePlanCounts(entries),
      entries,
    }
  } finally {
    try {
      if (materialized && servicesStarted) await adapter.stopServices({ ...materialized, services: services as TServices })
    } finally {
      if (materialized) await adapter.dispose(materialized)
    }
  }
}

/** Returns only unsuccessful entries, preserving the original deterministic order. */
export function retryBoundedRuntimePlan(plan: BoundedRuntimePlan, previous: Pick<BoundedRuntimePlanResult, "entries">): BoundedRuntimePlan {
  validateBoundedRuntimePlan(plan)
  const unsuccessful = new Set(previous.entries.filter((entry) => !entry.success).map((entry) => entry.id))
  const entries = plan.entries.filter((entry) => unsuccessful.has(entry.id))
  if (entries.length === 0) throw new Error("Bounded runtime plan retry requires at least one unsuccessful prior entry.")
  return { ...plan, concurrency: Math.min(plan.concurrency, entries.length), entries }
}

async function executeEntries<TWorkspace, TRuntime, TServices>(plan: BoundedRuntimePlan, concurrency: number, materialized: { workspace: TWorkspace; runtime: TRuntime }, services: TServices, adapter: BoundedRuntimePlanAdapter<TWorkspace, TRuntime, TServices>): Promise<BoundedRuntimePlanEntryResult[]> {
  const results = new Array<BoundedRuntimePlanEntryResult>(plan.entries.length)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= plan.entries.length) return
      const entry = plan.entries[index]!
      if (failed && plan.failFast) {
        results[index] = cancelledResult(entry)
        await adapter.onEntryResult?.(results[index])
        continue
      }
      const result = await executeEntry(entry, materialized, services, adapter)
      results[index] = result
      await adapter.onEntryResult?.(result)
      if (!result.success) failed = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.entries.length) }, worker))
  return results
}

async function executeEntry<TWorkspace, TRuntime, TServices>(entry: BoundedRuntimePlanEntry, materialized: { workspace: TWorkspace; runtime: TRuntime }, services: TServices, adapter: BoundedRuntimePlanAdapter<TWorkspace, TRuntime, TServices>): Promise<BoundedRuntimePlanEntryResult> {
  const controller = new AbortController()
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let operation: Promise<{ success: boolean; exitCode?: number; message?: string; stdoutRef?: string; stderrRef?: string; resultRef?: string; artifactRefs?: string[] }> | undefined
  try {
    operation = adapter.execute({ entry, ...materialized, services, signal: controller.signal })
    const completed = entry.timeoutMs === undefined ? await operation : await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BoundedRuntimePlanTimeoutError(entry.id)) }, entry.timeoutMs) }),
    ])
    const references = executionReferences(completed)
    return completed.success
      ? { ...baseResult(entry, "succeeded", true, Date.now() - startedAt, completed.exitCode), ...references }
      : { ...baseResult(entry, "failed", false, Date.now() - startedAt, completed.exitCode), ...references, error: { code: "execution-failed", message: redactEntryMessage(completed.message || `Execution failed: ${entry.id}`, entry) } }
  } catch (error) {
    if (error instanceof BoundedRuntimePlanTimeoutError) {
      // Keep the worker slot and shared services alive until the adapter confirms
      // that the aborted process has actually terminated.
      await operation?.catch(() => undefined)
      return { ...baseResult(entry, "timed_out", false, Date.now() - startedAt), error: { code: "timed-out", message: `Execution timed out: ${entry.id}` } }
    }
    return { ...baseResult(entry, "failed", false, Date.now() - startedAt), error: { code: "execution-threw", message: redactEntryMessage(error instanceof Error ? error.message : `Execution threw: ${entry.id}`, entry) } }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class BoundedRuntimePlanTimeoutError extends Error {}

function baseResult(entry: BoundedRuntimePlanEntry, status: BoundedRuntimePlanEntryStatus, success: boolean, durationMs: number, exitCode?: number): BoundedRuntimePlanEntryResult {
  return { id: entry.id, inputIndex: entry.inputIndex, processIdentity: entry.processIdentity, artifactNamespace: entry.artifactNamespace, status, success, durationMs, ...(exitCode === undefined ? {} : { exitCode }) }
}

function cancelledResult(entry: BoundedRuntimePlanEntry): BoundedRuntimePlanEntryResult {
  return { ...baseResult(entry, "cancelled", false, 0), error: { code: "fail-fast", message: `Execution was not started after an earlier failure: ${entry.id}` } }
}

function executionReferences(completed: { stdoutRef?: string; stderrRef?: string; resultRef?: string; artifactRefs?: string[] }): Pick<BoundedRuntimePlanEntryResult, "stdoutRef" | "stderrRef" | "resultRef" | "artifactRefs"> {
  return {
    ...(completed.stdoutRef ? { stdoutRef: completed.stdoutRef } : {}),
    ...(completed.stderrRef ? { stderrRef: completed.stderrRef } : {}),
    ...(completed.resultRef ? { resultRef: completed.resultRef } : {}),
    ...(completed.artifactRefs?.length ? { artifactRefs: completed.artifactRefs } : {}),
  }
}

function boundedRuntimePlanCounts(entries: BoundedRuntimePlanEntryResult[]): BoundedRuntimePlanResult["counts"] {
  return {
    total: entries.length,
    succeeded: entries.filter((entry) => entry.status === "succeeded").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    timedOut: entries.filter((entry) => entry.status === "timed_out").length,
    cancelled: entries.filter((entry) => entry.status === "cancelled").length,
  }
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

function redactEntryMessage(message: string, entry: BoundedRuntimePlanEntry): string {
  return Object.values(entry.environment ?? {}).reduce((redacted, value) => value ? redacted.split(value).join("[redacted]") : redacted, message)
}
