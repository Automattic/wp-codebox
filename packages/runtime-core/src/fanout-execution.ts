import { FANOUT_PLAN_SCHEMA, FANOUT_REQUEST_SCHEMA, FANOUT_RESULT_SCHEMA, type FanoutRequestContract } from "./fanout-contracts.js"
import { aggregateFanoutOutputs, fanoutAggregationInputFromWorkerArtifacts, type FanoutAggregationOutput, type FanoutAggregationPolicy, type FanoutArtifactRef, type FanoutWorkerResultRef } from "./fanout-aggregation.js"
import { normalizeRunPlanConcurrency, normalizeRunPlanWorkerDescriptors, executeRunPlan, type RunPlanClock, type RunPlanExecutorResult, type RunPlanNormalizationOptions, type RunPlanResultCounts, type RunPlanWorkerAdapter, type RunPlanWorkerContract, type RunPlanWorkerDescriptor, type RunPlanWorkerResultLike } from "./run-plan.js"
import { objectValue, optionalObjectValue, stringValue } from "./object-utils.js"

export interface FanoutExecutionOptions<TWorker extends RunPlanWorkerContract = FanoutRequestContract["workers"][number], TResult extends FanoutExecutionWorkerResultLike = FanoutExecutionWorkerResultLike> extends RunPlanNormalizationOptions {
  adapter: RunPlanWorkerAdapter<TWorker, TResult>
  sessionId?: string
  clock?: RunPlanClock
  aggregationPolicy?: FanoutAggregationPolicy
  aggregation?: Record<string, unknown>
  finalArtifactRefs?: FanoutArtifactRef[]
  outputNamespace?: string
  onFanoutStarted?: (event: FanoutExecutionLifecycleSnapshot<TWorker>) => Promise<void> | void
  onWorkerStarted?: (descriptor: RunPlanWorkerDescriptor<TWorker>, index: number) => Promise<void> | void
  onWorkerCompleted?: (descriptor: RunPlanWorkerDescriptor<TWorker>, result: TResult, index: number) => Promise<void> | void
  onWorkerFailed?: (descriptor: RunPlanWorkerDescriptor<TWorker>, result: TResult, index: number) => Promise<void> | void
  onWorkerSkipped?: (descriptor: RunPlanWorkerDescriptor<TWorker>, result: TResult, index: number) => Promise<void> | void
  onAggregationStarted?: (event: FanoutExecutionAggregationSnapshot<TWorker, TResult>) => Promise<void> | void
  onAggregationCompleted?: (aggregate: FanoutAggregationOutput) => Promise<void> | void
  onFanoutCompleted?: (result: FanoutExecutionResult<TWorker, TResult>) => Promise<void> | void
  createSkippedResult?: (descriptor: RunPlanWorkerDescriptor<TWorker>, dependencies: TResult[]) => TResult
}

export interface FanoutExecutionWorkerResultLike extends RunPlanWorkerResultLike {
  workerId: string
  required?: boolean
  resultRef?: string
  result_ref?: string
  artifactRefs?: unknown[]
  artifact_refs?: unknown[]
  evidenceRefs?: unknown[]
  evidence_refs?: unknown[]
  error?: unknown
  metadata?: Record<string, unknown>
}

export interface FanoutExecutionPlan<TWorker extends RunPlanWorkerContract = FanoutRequestContract["workers"][number]> {
  schema: typeof FANOUT_PLAN_SCHEMA
  session_id: string
  concurrency: number
  orchestrator: Record<string, unknown>
  workers: Array<{
    id: string
    agent: string
    goal: string
    artifact_namespace: string
    depends_on: string[]
    required: boolean
    worker: TWorker
  }>
}

export interface FanoutExecutionLifecycleSnapshot<TWorker extends RunPlanWorkerContract = FanoutRequestContract["workers"][number]> {
  sessionId: string
  concurrency: number
  workers: Array<RunPlanWorkerDescriptor<TWorker>>
  plan: FanoutExecutionPlan<TWorker>
}

export interface FanoutExecutionAggregationSnapshot<TWorker extends RunPlanWorkerContract = FanoutRequestContract["workers"][number], TResult extends FanoutExecutionWorkerResultLike = FanoutExecutionWorkerResultLike> extends FanoutExecutionLifecycleSnapshot<TWorker> {
  execution: RunPlanExecutorResult<TResult>
  workerResultRefs: FanoutWorkerResultRef[]
}

export interface FanoutExecutionResult<TWorker extends RunPlanWorkerContract = FanoutRequestContract["workers"][number], TResult extends FanoutExecutionWorkerResultLike = FanoutExecutionWorkerResultLike> {
  schema: typeof FANOUT_RESULT_SCHEMA
  success: boolean
  status: "completed" | "failed"
  sessionId: string
  concurrency: number
  plan: FanoutExecutionPlan<TWorker>
  workers: TResult[]
  workerResultRefs: FanoutWorkerResultRef[]
  aggregate: FanoutAggregationOutput
  counts: RunPlanResultCounts
  execution: RunPlanExecutorResult<TResult>
}

export async function executeFanoutRequest<TWorker extends RunPlanWorkerContract = FanoutRequestContract["workers"][number], TResult extends FanoutExecutionWorkerResultLike = FanoutExecutionWorkerResultLike>(request: FanoutRequestContract & { workers: TWorker[] }, options: FanoutExecutionOptions<TWorker, TResult>): Promise<FanoutExecutionResult<TWorker, TResult>> {
  if (request.schema && request.schema !== FANOUT_REQUEST_SCHEMA) {
    throw new Error(`Fanout execution requires ${FANOUT_REQUEST_SCHEMA}.`)
  }

  const sessionId = options.sessionId || stringValue(request.session_id) || stringValue(objectValue(request.orchestrator)?.session_id) || stringValue(objectValue(request.orchestrator)?.request_id) || `fanout-${Date.now()}`
  const maxConcurrency = options.maxConcurrency ?? Number.MAX_SAFE_INTEGER
  const concurrency = normalizeRunPlanConcurrency(request.concurrency, { ...options, maxConcurrency })
  const workers = normalizeRunPlanWorkerDescriptors(request.workers, { ...options, defaultAgent: options.defaultAgent ?? stringValue(request.agent) })
  const plan = fanoutExecutionPlan(sessionId, concurrency, objectValue(request.orchestrator) ?? {}, workers)

  await options.onFanoutStarted?.({ sessionId, concurrency, workers, plan })

  const execution = await executeRunPlan({ workers: request.workers, concurrency }, {
    ...options,
    concurrencyMode: "validate",
    adapter: options.adapter,
    defaultAgent: options.defaultAgent ?? stringValue(request.agent),
    onWorkerStarted: options.onWorkerStarted,
    onWorkerCompleted: options.onWorkerCompleted,
    onWorkerFailed: options.onWorkerFailed,
    onWorkerSkipped: options.onWorkerSkipped,
    createSkippedResult: options.createSkippedResult,
  })

  const workerResultRefs = execution.workers.map((result, index) => fanoutWorkerResultRef(result, workers[index]))
  await options.onAggregationStarted?.({ sessionId, concurrency, workers, plan, execution, workerResultRefs })

  const aggregation = optionalObjectValue(request.aggregation) ?? options.aggregation
  const aggregationInput = fanoutAggregationInputFromWorkerArtifacts({
    plan: { id: sessionId, workers: workers.map((worker) => ({ id: worker.id, dependsOn: worker.dependsOn, required: worker.required, artifactNamespace: worker.artifactNamespace })) },
    policy: options.aggregationPolicy ?? (stringValue(aggregation?.policy) || "fail"),
    aggregator: aggregation,
    workerResultRefs,
  })
  const aggregate = aggregateFanoutOutputs(aggregationInput, {
    finalArtifactRefs: options.finalArtifactRefs,
    outputNamespace: options.outputNamespace,
  })
  await options.onAggregationCompleted?.(aggregate)

  const success = aggregate.status === "succeeded"
  const result: FanoutExecutionResult<TWorker, TResult> = {
    schema: FANOUT_RESULT_SCHEMA,
    success,
    status: success ? "completed" : "failed",
    sessionId,
    concurrency,
    plan,
    workers: execution.workers,
    workerResultRefs,
    aggregate,
    counts: execution.counts,
    execution,
  }
  await options.onFanoutCompleted?.(result)
  return result
}

export function fanoutExecutionPlan<TWorker extends RunPlanWorkerContract>(sessionId: string, concurrency: number, orchestrator: Record<string, unknown>, workers: Array<RunPlanWorkerDescriptor<TWorker>>): FanoutExecutionPlan<TWorker> {
  return {
    schema: FANOUT_PLAN_SCHEMA,
    session_id: sessionId,
    concurrency,
    orchestrator,
    workers: workers.map((descriptor) => ({
      id: descriptor.id,
      agent: descriptor.agent,
      goal: descriptor.goal,
      artifact_namespace: descriptor.artifactNamespace,
      depends_on: descriptor.dependsOn,
      required: descriptor.required,
      worker: descriptor.worker,
    })),
  }
}

export function fanoutWorkerResultRef<TResult extends FanoutExecutionWorkerResultLike, TWorker extends RunPlanWorkerContract>(result: TResult, descriptor?: RunPlanWorkerDescriptor<TWorker>): FanoutWorkerResultRef {
  const artifactRefs = result.artifactRefs ?? result.artifact_refs ?? result.evidenceRefs ?? result.evidence_refs ?? []
  return {
    workerId: stringValue(result.workerId) || descriptor?.id || "",
    status: stringValue(result.status) || (result.success === true ? "succeeded" : "failed"),
    required: typeof result.required === "boolean" ? result.required : descriptor?.required !== false,
    resultRef: stringValue(result.resultRef) || stringValue(result.result_ref) || undefined,
    artifactRefs: Array.isArray(artifactRefs) ? artifactRefs as FanoutArtifactRef[] : [],
    error: fanoutWorkerError(result.error),
    metadata: result.metadata,
  }
}

function fanoutWorkerError(error: unknown): FanoutWorkerResultRef["error"] {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined
  const record = error as Record<string, unknown>
  return {
    code: stringValue(record.code) || undefined,
    message: stringValue(record.message) || "Fanout worker failed.",
    details: objectValue(record.details),
  }
}
