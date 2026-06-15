import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FANOUT_EVENT_SCHEMA, FANOUT_PLAN_SCHEMA, FANOUT_REQUEST_SCHEMA, FANOUT_RESULT_SCHEMA, type FanoutLifecycleEvent, type FanoutRequestContract } from "@automattic/wp-codebox-core"
import { aggregateFanoutOutputs, stripUndefined, type FanoutAggregationOutput } from "@automattic/wp-codebox-core/internals"
import { runAgentTask, type AgentTaskRunInput, type AgentTaskRunOptions } from "./commands/agent-task-run.js"

const MAX_FANOUT_CONCURRENCY = 8

export interface AgentFanoutExecutionOptions {
  artifactRoot: string
  recipeDirectory: string
  previewHoldSeconds?: string
  previewPublicUrl?: string
  runWorker?: (input: AgentTaskRunInput, options: AgentTaskRunOptions) => Promise<AgentFanoutWorkerOutput>
}

export interface AgentFanoutExecutionResult {
  schema: typeof FANOUT_RESULT_SCHEMA
  status: "completed" | "failed"
  success: boolean
  session: {
    id: string
    children: Array<{ id: string; worker_id: string; status: string; artifacts: string }>
  }
  concurrency: number
  plan: Record<string, unknown>
  artifacts: Record<string, unknown>
  workers: AgentFanoutWorkerResult[]
  aggregate: FanoutAggregationOutput
  counts: { total: number; completed: number; failed: number; cancelled: number }
  events_path: string
  result_path: string
}

interface AgentFanoutWorkerResult {
  worker_id: string
  status: "succeeded" | "failed"
  required: boolean
  session_id: string
  result_ref: string
  artifact_refs: Array<Record<string, unknown>>
  error?: { code: string; message: string }
  output?: Record<string, unknown>
}

type AgentFanoutWorkerOutput = Record<string, unknown> & { success?: boolean; evidence_refs?: unknown[]; error?: unknown }

export async function executeAgentFanoutRequest(request: FanoutRequestContract, options: AgentFanoutExecutionOptions): Promise<AgentFanoutExecutionResult> {
  if (request.schema && request.schema !== FANOUT_REQUEST_SCHEMA) {
    throw new Error(`wp-codebox.agent-fanout requires ${FANOUT_REQUEST_SCHEMA}`)
  }
  if (!Array.isArray(request.workers) || request.workers.length === 0) {
    throw new Error("wp-codebox.agent-fanout requires at least one worker")
  }

  const sessionId = stringValue(request.orchestrator?.session_id) || stringValue(request.orchestrator?.request_id) || `fanout-${Date.now()}`
  const concurrency = Math.max(1, Math.min(MAX_FANOUT_CONCURRENCY, Math.floor(Number(request.concurrency) || 1)))
  const fanoutRoot = join(options.artifactRoot, "fanout")
  const workersRoot = join(fanoutRoot, "workers")
  const aggregateRoot = join(fanoutRoot, "aggregate")
  const aggregateFinalRoot = join(options.artifactRoot, "aggregate", "final")
  const eventsPath = join(fanoutRoot, "events.jsonl")
  const planPath = join(fanoutRoot, "plan.json")
  const resultPath = join(fanoutRoot, "result.json")
  await mkdir(workersRoot, { recursive: true })
  await mkdir(aggregateFinalRoot, { recursive: true })

  const workers = request.workers.map((worker) => {
    const id = safeWorkerId(worker.id)
    return {
      ...worker,
      id,
      agent: stringValue(worker.agent) || stringValue(request.agent),
      artifact_namespace: safeArtifactNamespace(worker.artifactNamespace, id),
      required: worker.required !== false,
    }
  })

  if (new Set(workers.map((worker) => worker.id)).size !== workers.length) {
    throw new Error("wp-codebox.agent-fanout worker ids must be unique")
  }

  const plan = {
    schema: FANOUT_PLAN_SCHEMA,
    session_id: sessionId,
    concurrency,
    orchestrator: request.orchestrator ?? {},
    workers: workers.map((worker) => ({
      id: worker.id,
      agent: worker.agent,
      goal: worker.goal,
      artifact_namespace: worker.artifact_namespace,
    })),
  }
  await writeJson(planPath, plan)
  await emitEvent(eventsPath, { event: "fanout.started", total: workers.length, active: 0, completed: 0, failed: 0, cancelled: 0 })

  const runWorker = options.runWorker ?? (async (input: AgentTaskRunInput, workerOptions: AgentTaskRunOptions): Promise<AgentFanoutWorkerOutput> => runAgentTask(input, workerOptions) as unknown as AgentFanoutWorkerOutput)
  const workerResults = await runBounded(workers, concurrency, async (worker): Promise<AgentFanoutWorkerResult> => {
    const workerArtifacts = join(workersRoot, worker.id, "artifacts")
    const childSessionId = `${sessionId}:${worker.id}`
    await mkdir(workerArtifacts, { recursive: true })
    await emitEvent(eventsPath, { event: "worker.started", worker_id: worker.id })
    try {
      const output = await runWorker(workerInput(request, worker, childSessionId, workerArtifacts), {
        inputPath: "",
        json: true,
        previewHoldSeconds: options.previewHoldSeconds ?? "",
        previewPublicUrl: options.previewPublicUrl ?? "",
      })
      const success = output.success === true
      const resultRef = `fanout/workers/${worker.id}/result.json`
      const workerResult = stripUndefined({
        worker_id: worker.id,
        status: success ? "succeeded" : "failed",
        required: worker.required,
        session_id: childSessionId,
        result_ref: resultRef,
        artifact_refs: workerArtifactRefs(worker.id, output),
        output,
        ...(!success ? { error: { code: "worker-failed", message: stringValue(objectValue(output.error)?.message) || `Fanout worker ${worker.id} failed.` } } : {}),
      }) as AgentFanoutWorkerResult
      await writeJson(join(workersRoot, worker.id, "result.json"), workerResult)
      await emitEvent(eventsPath, { event: success ? "worker.completed" : "worker.failed", worker_id: worker.id, status: workerResult.status })
      return workerResult
    } catch (error) {
      const resultRef = `fanout/workers/${worker.id}/result.json`
      const workerResult = {
        worker_id: worker.id,
        status: "failed" as const,
        required: worker.required,
        session_id: childSessionId,
        result_ref: resultRef,
        artifact_refs: [],
        error: { code: "worker-exception", message: error instanceof Error ? error.message : String(error) },
      }
      await writeJson(join(workersRoot, worker.id, "result.json"), workerResult)
      await emitEvent(eventsPath, { event: "worker.failed", worker_id: worker.id, status: "failed" })
      return workerResult
    }
  })

  await emitEvent(eventsPath, { event: "aggregation.started", total: workers.length, completed: workerResults.filter((worker) => worker.status === "succeeded").length, failed: workerResults.filter((worker) => worker.status === "failed").length })
  const aggregate = aggregateFanoutOutputs({
    plan: { id: sessionId, workers: workers.map((worker) => ({ id: worker.id, dependsOn: Array.isArray(worker.dependsOn) ? worker.dependsOn.filter((dependency): dependency is string => typeof dependency === "string") : [], required: worker.required, artifactNamespace: worker.artifact_namespace })) },
    policy: stringValue(request.aggregation?.policy) || "fail",
    aggregation: request.aggregation,
    worker_results: workerResults.map((worker) => ({
      worker_id: worker.worker_id,
      status: worker.status,
      required: worker.required,
      result_ref: worker.result_ref,
      artifact_refs: worker.artifact_refs,
      error: worker.error,
    })),
  }, {
    finalArtifactRefs: [{ path: "aggregate/final/result.json", kind: "fanout-aggregate-output", namespace: "aggregate/final", contentType: "application/json" }],
  })
  await writeJson(join(aggregateRoot, "result.json"), aggregate)
  await writeJson(join(aggregateFinalRoot, "result.json"), aggregate)
  await emitEvent(eventsPath, { event: "aggregation.completed", status: aggregate.status })

  const counts = {
    total: workerResults.length,
    completed: workerResults.filter((worker) => worker.status === "succeeded").length,
    failed: workerResults.filter((worker) => worker.status === "failed").length,
    cancelled: 0,
  }
  const success = aggregate.status === "succeeded"
  const result: AgentFanoutExecutionResult = {
    schema: FANOUT_RESULT_SCHEMA,
    status: success ? "completed" : "failed",
    success,
    session: {
      id: sessionId,
      children: workerResults.map((worker) => ({ id: worker.session_id, worker_id: worker.worker_id, status: worker.status, artifacts: join(workersRoot, worker.worker_id, "artifacts") })),
    },
    concurrency,
    plan,
    artifacts: {
      root: fanoutRoot,
      plan: "fanout/plan.json",
      events: "fanout/events.jsonl",
      result: "fanout/result.json",
      workers: "fanout/workers",
      aggregate: "fanout/aggregate/result.json",
      final: "aggregate/final/result.json",
    },
    workers: workerResults,
    aggregate,
    counts,
    events_path: eventsPath,
    result_path: resultPath,
  }
  await writeJson(resultPath, result)
  await emitEvent(eventsPath, { event: success ? "fanout.completed" : "fanout.failed", total: counts.total, completed: counts.completed, failed: counts.failed, cancelled: counts.cancelled })
  return result
}

export async function executeAgentFanoutFromArgs(args: string[], options: AgentFanoutExecutionOptions): Promise<AgentFanoutExecutionResult> {
  const request = await fanoutRequestFromArgs(args, options.recipeDirectory)
  return executeAgentFanoutRequest(request, options)
}

async function fanoutRequestFromArgs(args: string[], recipeDirectory: string): Promise<FanoutRequestContract> {
  const raw = argValue(args, "fanout-json") || argValue(args, "request-json")
  if (!raw) {
    throw new Error("wp-codebox.agent-fanout requires fanout-json=<json-or-@file>")
  }
  const text = raw.startsWith("@") ? await readFile(join(recipeDirectory, raw.slice(1)), "utf8") : raw
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("wp-codebox.agent-fanout fanout-json must be a JSON object")
  }
  return parsed as FanoutRequestContract
}

function workerInput(request: FanoutRequestContract, worker: Record<string, unknown>, childSessionId: string, artifactsPath: string): AgentTaskRunInput {
  const parentInput = objectValue(request.task_input) || objectValue(request.taskInput) || {}
  const workerTaskInput = objectValue(worker.task_input) || objectValue(worker.taskInput) || {}
  const inherited = inheritedAgentTaskInput(request)
  const workerInherited = inheritedAgentTaskInput(worker)
  return stripUndefined({
    ...inherited,
    ...parentInput,
    ...workerInherited,
    ...workerTaskInput,
    goal: stringValue(worker.task) || stringValue(worker.goal),
    agent: stringValue(worker.agent) || stringValue(parentInput.agent) || stringValue(request.agent),
    artifacts_path: artifactsPath,
    session_id: childSessionId,
    sandbox_session_id: childSessionId,
    parent_request: request as unknown as Record<string, unknown>,
    orchestrator: stripUndefined({ ...(request.orchestrator ?? {}), fanout_worker_id: worker.id }),
  }) as AgentTaskRunInput
}

function inheritedAgentTaskInput(source: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "mode",
    "provider",
    "model",
    "provider_plugin_paths",
    "secret_env",
    "mounts",
    "workspaces",
    "dependency_overlays",
    "runtime_stack_mounts",
    "runtime_overlays",
    "agent_bundles",
    "runtime_task",
    "sandbox_tool_policy",
    "max_turns",
		"task_timeout_seconds",
		"wp",
		"component_contracts",
	]
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  return result
}

async function runBounded<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

async function emitEvent(path: string, event: Omit<FanoutLifecycleEvent, "schema" | "time" | "worker_id"> & { worker_id?: string }): Promise<void> {
  await appendFile(path, `${JSON.stringify({ schema: FANOUT_EVENT_SCHEMA, time: new Date().toISOString(), ...event })}\n`)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function workerArtifactRefs(workerId: string, output: Record<string, unknown>): Array<Record<string, unknown>> {
  const refs = Array.isArray(output.evidence_refs) ? output.evidence_refs.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  return refs.map((ref, index) => stripUndefined({
    id: `${workerId}:${index}`,
    worker_id: workerId,
    namespace: `workers/${workerId}`,
    path: stringValue(ref.uri) || stringValue(ref.path),
    kind: stringValue(ref.kind) || "codebox-evidence",
    metadata: ref,
  }))
}

function safeWorkerId(value: unknown): string {
  const id = stringValue(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`wp-codebox.agent-fanout worker id must be a safe path segment: ${id || "<empty>"}`)
  }
  return id
}

function safeArtifactNamespace(value: unknown, fallback: string): string {
  const namespace = stringValue(value) || fallback
  if (namespace.split("/").some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new Error(`wp-codebox.agent-fanout artifact namespace must contain safe path segments: ${namespace}`)
  }
  return namespace
}

function argValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}
