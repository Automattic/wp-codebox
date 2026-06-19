import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { commandArgValue, createRunPlanEvent, executeRunPlan, FANOUT_EVENT_SCHEMA, FANOUT_PLAN_SCHEMA, FANOUT_REQUEST_SCHEMA, FANOUT_RESULT_SCHEMA, normalizeRunPlanConcurrency, normalizeRunPlanWorkerDescriptors, parseCommandJsonObject, type FanoutLifecycleEvent, type FanoutRequestContract, type RunPlanWorkerAdapter, type RunPlanWorkerDescriptor } from "@automattic/wp-codebox-core"
import { agentTaskStatusSucceeded, aggregateFanoutOutputs, normalizeAgentTaskStatus, stripUndefined, type FanoutAggregationOutput } from "@automattic/wp-codebox-core/internals"
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
  status: string
  required: boolean
  session_id: string
  result_ref: string
  artifact_refs: Array<Record<string, unknown>>
  error?: { code: string; message: string }
  output?: Record<string, unknown>
}

type AgentFanoutWorkerOutput = Record<string, unknown> & { success?: boolean; evidence_refs?: unknown[]; error?: unknown }
type AgentFanoutWorkerDescriptor = RunPlanWorkerDescriptor<FanoutRequestContract["workers"][number]>
type AgentFanoutWorkerExecutionResult = AgentFanoutWorkerResult & { workerId: string; success: boolean }
type AgentFanoutWorkerAdapter = RunPlanWorkerAdapter<FanoutRequestContract["workers"][number], AgentFanoutWorkerExecutionResult>

export async function executeAgentFanoutRequest(request: FanoutRequestContract, options: AgentFanoutExecutionOptions): Promise<AgentFanoutExecutionResult> {
  if (request.schema && request.schema !== FANOUT_REQUEST_SCHEMA) {
    throw new Error(`wp-codebox.agent-fanout requires ${FANOUT_REQUEST_SCHEMA}`)
  }
  if (!Array.isArray(request.workers) || request.workers.length === 0) {
    throw new Error("wp-codebox.agent-fanout requires at least one worker")
  }

  const sessionId = stringValue(request.orchestrator?.session_id) || stringValue(request.orchestrator?.request_id) || `fanout-${Date.now()}`
  const concurrency = normalizeRunPlanConcurrency(request.concurrency, { maxConcurrency: MAX_FANOUT_CONCURRENCY, concurrencyMode: "clamp" })
  const fanoutRoot = join(options.artifactRoot, "fanout")
  const workersRoot = join(fanoutRoot, "workers")
  const aggregateRoot = join(fanoutRoot, "aggregate")
  const aggregateFinalRoot = join(options.artifactRoot, "aggregate", "final")
  const eventsPath = join(fanoutRoot, "events.jsonl")
  const planPath = join(fanoutRoot, "plan.json")
  const resultPath = join(fanoutRoot, "result.json")
  await mkdir(workersRoot, { recursive: true })
  await mkdir(aggregateFinalRoot, { recursive: true })

  const workers = normalizeRunPlanWorkerDescriptors(request.workers, { defaultAgent: stringValue(request.agent), requireGoal: true })

  const plan = {
    schema: FANOUT_PLAN_SCHEMA,
    session_id: sessionId,
    concurrency,
    orchestrator: request.orchestrator ?? {},
    workers: workers.map((descriptor) => ({
      id: descriptor.id,
      agent: descriptor.agent,
      goal: descriptor.goal,
      artifact_namespace: descriptor.artifactNamespace,
    })),
  }
  await writeJson(planPath, plan)
  await emitEvent(eventsPath, { event: "fanout.started", total: workers.length, active: 0, completed: 0, failed: 0, cancelled: 0 })

  const execution = await executeRunPlan({ workers: request.workers, concurrency }, {
    adapter: agentTaskFanoutWorkerAdapter(request, { ...options, workersRoot, sessionId }),
    defaultAgent: stringValue(request.agent),
    requireGoal: true,
    onWorkerStarted: (worker) => emitEvent(eventsPath, { event: "worker.started", worker_id: worker.id }),
    onWorkerCompleted: (worker, result) => emitEvent(eventsPath, { event: "worker.completed", worker_id: worker.id, status: result.status }),
    onWorkerFailed: (worker, result) => emitEvent(eventsPath, { event: "worker.failed", worker_id: worker.id, status: result.status }),
  })
  const workerResults: AgentFanoutWorkerResult[] = execution.workers.map(({ success: _success, workerId: _workerId, ...result }) => result as unknown as AgentFanoutWorkerResult)

  await emitEvent(eventsPath, { event: "aggregation.started", total: workers.length, completed: workerResults.filter((worker) => agentTaskStatusSucceeded(worker.status)).length, failed: workerResults.filter((worker) => !agentTaskStatusSucceeded(worker.status)).length })
  const aggregate = aggregateFanoutOutputs({
    plan: { id: sessionId, workers: workers.map((worker) => ({ id: worker.id, dependsOn: worker.dependsOn, required: worker.required, artifactNamespace: worker.artifactNamespace })) },
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

  const counts = execution.counts
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
  const raw = commandArgValue(args, "fanout-json") || commandArgValue(args, "request-json")
  if (!raw) {
    throw new Error("wp-codebox.agent-fanout requires fanout-json=<json-or-@file>")
  }
  const text = raw.startsWith("@") ? await readFile(join(recipeDirectory, raw.slice(1)), "utf8") : raw
  return parseCommandJsonObject(text, "wp-codebox.agent-fanout fanout-json") as FanoutRequestContract
}

function agentTaskFanoutWorkerAdapter(request: FanoutRequestContract, options: AgentFanoutExecutionOptions & { workersRoot: string; sessionId: string }): AgentFanoutWorkerAdapter {
  const runWorker = options.runWorker ?? (async (input: AgentTaskRunInput, workerOptions: AgentTaskRunOptions): Promise<AgentFanoutWorkerOutput> => runAgentTask(input, workerOptions) as unknown as AgentFanoutWorkerOutput)

  return {
    async run({ descriptor }) {
      const workerArtifacts = join(options.workersRoot, descriptor.id, "artifacts")
      const childSessionId = `${options.sessionId}:${descriptor.id}`
      await mkdir(workerArtifacts, { recursive: true })
      try {
        const output = await runWorker(agentTaskWorkerInput(request, descriptor, childSessionId, workerArtifacts), {
          inputPath: "",
          json: true,
          previewHoldSeconds: options.previewHoldSeconds ?? "",
          previewPublicUrl: options.previewPublicUrl ?? "",
        })
        const status = normalizeAgentTaskStatus({ status: output.status, success: output.success })
        const success = agentTaskStatusSucceeded(status)
        const resultRef = `fanout/workers/${descriptor.id}/result.json`
        const workerResult = stripUndefined({
          workerId: descriptor.id,
          success,
          worker_id: descriptor.id,
          status,
          required: descriptor.required,
          session_id: childSessionId,
          result_ref: resultRef,
          artifact_refs: workerArtifactRefs(descriptor.id, output),
          output,
          ...(!success ? { error: { code: "worker-failed", message: stringValue(objectValue(output.error)?.message) || `Fanout worker ${descriptor.id} failed.` } } : {}),
        }) as AgentFanoutWorkerExecutionResult
        await writeJson(join(options.workersRoot, descriptor.id, "result.json"), workerResult)
        return workerResult
      } catch (error) {
        const resultRef = `fanout/workers/${descriptor.id}/result.json`
        const workerResult = {
          workerId: descriptor.id,
          success: false,
          worker_id: descriptor.id,
          status: "failed" as const,
          required: descriptor.required,
          session_id: childSessionId,
          result_ref: resultRef,
          artifact_refs: [],
          error: { code: "worker-exception", message: error instanceof Error ? error.message : String(error) },
        }
        await writeJson(join(options.workersRoot, descriptor.id, "result.json"), workerResult)
        return workerResult
      }
    },
  }
}

function agentTaskWorkerInput(request: FanoutRequestContract, descriptor: AgentFanoutWorkerDescriptor, childSessionId: string, artifactsPath: string): AgentTaskRunInput {
  const worker = descriptor.worker
  const parentInput = objectValue(request.task_input) || objectValue(request.taskInput) || {}
  const workerTaskInput = objectValue(worker.task_input) || objectValue(worker.taskInput) || {}
  const inherited = inheritedAgentTaskInput(request)
  const workerInherited = inheritedAgentTaskInput(worker)
  return stripUndefined({
    ...inherited,
    ...parentInput,
    ...workerInherited,
    ...workerTaskInput,
    goal: stringValue(worker.task) || descriptor.goal,
    agent: descriptor.agent || stringValue(parentInput.agent) || stringValue(request.agent),
    artifacts_path: artifactsPath,
    session_id: childSessionId,
    sandbox_session_id: childSessionId,
    parent_request: request as unknown as Record<string, unknown>,
    orchestrator: stripUndefined({ ...(request.orchestrator ?? {}), fanout_worker_id: descriptor.id }),
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

async function emitEvent(path: string, event: Omit<FanoutLifecycleEvent, "schema" | "time" | "worker_id"> & { worker_id?: string }): Promise<void> {
  await appendFile(path, `${JSON.stringify(createRunPlanEvent<FanoutLifecycleEvent>(FANOUT_EVENT_SCHEMA, event))}\n`)
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}
