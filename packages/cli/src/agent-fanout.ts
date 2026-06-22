import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import { commandArgValue, createRunPlanEvent, executeFanoutRequest, FANOUT_EVENT_SCHEMA, FANOUT_REQUEST_SCHEMA, FANOUT_RESULT_SCHEMA, parseCommandJsonObject, type FanoutLifecycleEvent, type FanoutRequestContract, type RunPlanClock, type RunPlanWorkerAdapter, type RunPlanWorkerDescriptor } from "@automattic/wp-codebox-core"
import { agentTaskStatusSucceeded, normalizeAgentTaskStatus, stripUndefined, type FanoutAggregationOutput } from "@automattic/wp-codebox-core/internals"
import { runAgentTask, type AgentTaskRunInput, type AgentTaskRunOptions } from "./commands/agent-task-run.js"

const MAX_FANOUT_CONCURRENCY = 8

export interface AgentFanoutExecutionOptions {
  artifactRoot: string
  recipeDirectory: string
  previewHoldSeconds?: string
  previewPublicUrl?: string
  previewPort?: string
  previewBind?: string
  previewHoldBlocking?: boolean
  sessionId?: string
  clock?: RunPlanClock
  runWorker?: (input: AgentTaskRunInput, options: AgentTaskRunOptions) => Promise<AgentFanoutWorkerOutput>
}

export interface AgentFanoutExecutionResult {
  schema: typeof FANOUT_RESULT_SCHEMA
  status: "completed" | "failed"
  success: boolean
  session: {
    id: string
    children: Array<{ id: string; worker_id: string; status: string; artifacts: string; artifact_refs: Array<Record<string, unknown>> }>
  }
  concurrency: number
  plan: Record<string, unknown>
  artifacts: Record<string, unknown>
  workers: AgentFanoutWorkerResult[]
  aggregate: FanoutAggregationOutput
  counts: { total: number; completed: number; failed: number; skipped: number; cancelled: number; timed_out: number }
  events_path: string
  result_path: string
  diagnostics?: Record<string, unknown>
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

  const clock = fanoutClock(request, options.clock)
  const sessionId = options.sessionId || stringValue(request.session_id) || stringValue(request.orchestrator?.session_id) || stringValue(request.orchestrator?.request_id) || `fanout-${Date.now()}`
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

  const fanout = await executeFanoutRequest(request, {
    adapter: agentTaskFanoutWorkerAdapter(request, { ...options, workersRoot, sessionId }),
    defaultAgent: stringValue(request.agent),
    requireGoal: true,
    maxConcurrency: MAX_FANOUT_CONCURRENCY,
    concurrencyMode: "clamp",
    clock,
    finalArtifactRefs: [{ path: "aggregate/final/result.json", kind: "fanout-aggregate-output", namespace: "aggregate/final", contentType: "application/json" }],
    onFanoutStarted: async ({ workers, plan }) => {
      await writeJson(planPath, plan)
      await emitEvent(eventsPath, { event: "fanout.started", total: workers.length, active: 0, completed: 0, failed: 0, cancelled: 0 }, clock)
    },
    onWorkerStarted: (worker) => emitEvent(eventsPath, { event: "worker.started", worker_id: worker.id }, clock),
    onWorkerCompleted: (worker, result) => emitEvent(eventsPath, { event: "worker.completed", worker_id: worker.id, status: result.status }, clock),
    onWorkerFailed: (worker, result) => emitEvent(eventsPath, { event: "worker.failed", worker_id: worker.id, status: result.status }, clock),
    onWorkerSkipped: async (worker, result) => {
      await writeJson(join(workersRoot, worker.id, "result.json"), result)
      await emitEvent(eventsPath, { event: "worker.skipped", worker_id: worker.id, status: result.status }, clock)
    },
    createSkippedResult: (worker, dependencies) => agentTaskSkippedFanoutWorkerResult(worker, sessionId, dependencies),
    onAggregationStarted: ({ workers, workerResultRefs }) => emitEvent(eventsPath, { event: "aggregation.started", total: workers.length, completed: workerResultRefs.filter((worker) => agentTaskStatusSucceeded(worker.status)).length, failed: workerResultRefs.filter((worker) => !agentTaskStatusSucceeded(worker.status) && worker.status !== "skipped").length, skipped: workerResultRefs.filter((worker) => worker.status === "skipped").length }, clock),
    onAggregationCompleted: async (aggregate) => {
      await writeJson(join(aggregateRoot, "result.json"), aggregate)
      await writeJson(join(aggregateFinalRoot, "result.json"), aggregate)
      await emitEvent(eventsPath, { event: "aggregation.completed", status: aggregate.status }, clock)
    },
  })
  const workerResults: AgentFanoutWorkerResult[] = fanout.workers.map(({ success: _success, workerId: _workerId, ...result }) => result as unknown as AgentFanoutWorkerResult)

  const counts = fanout.counts
  const success = fanout.success
  const result: AgentFanoutExecutionResult = {
    schema: FANOUT_RESULT_SCHEMA,
    status: success ? "completed" : "failed",
    success,
    session: {
      id: sessionId,
      children: workerResults.map((worker) => ({
        id: worker.session_id,
        worker_id: worker.worker_id,
        status: worker.status,
        artifacts: `fanout/workers/${worker.worker_id}/artifacts`,
        artifact_refs: worker.artifact_refs,
      })),
    },
    concurrency: fanout.concurrency,
    plan: fanout.plan as unknown as Record<string, unknown>,
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
    aggregate: fanout.aggregate,
    counts,
    events_path: eventsPath,
    result_path: resultPath,
    diagnostics: {
      private: {
        local_paths: {
          root: fanoutRoot,
          events: eventsPath,
          result: resultPath,
          workers: workersRoot,
          children: workerResults.map((worker) => ({ worker_id: worker.worker_id, artifacts: join(workersRoot, worker.worker_id, "artifacts") })),
        },
      },
    },
  }
  await writeJson(resultPath, result)
  await emitEvent(eventsPath, { event: success ? "fanout.completed" : "fanout.failed", total: counts.total, completed: counts.completed, failed: counts.failed, skipped: counts.skipped, cancelled: counts.cancelled, timed_out: counts.timed_out }, clock)
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
          previewPort: options.previewPort ?? "",
          previewBind: options.previewBind ?? "",
          previewHoldBlocking: options.previewHoldBlocking ?? false,
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
          artifact_refs: workerArtifactRefs(descriptor.id, output, options.artifactRoot),
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

function agentTaskSkippedFanoutWorkerResult(descriptor: AgentFanoutWorkerDescriptor, sessionId: string, dependencies: AgentFanoutWorkerExecutionResult[]): AgentFanoutWorkerExecutionResult {
  const childSessionId = `${sessionId}:${descriptor.id}`
  return {
    workerId: descriptor.id,
    success: false,
    worker_id: descriptor.id,
    status: "skipped",
    required: descriptor.required,
    session_id: childSessionId,
    result_ref: `fanout/workers/${descriptor.id}/result.json`,
    artifact_refs: [],
    error: {
      code: "dependency-skipped",
      message: `Fanout worker ${descriptor.id} skipped because a dependency did not complete successfully.`,
    },
    output: {
      dependencies: dependencies.map((dependency) => ({ worker_id: dependency.worker_id, status: dependency.status, success: dependency.success })),
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

async function emitEvent(path: string, event: Omit<FanoutLifecycleEvent, "schema" | "time" | "worker_id"> & { worker_id?: string }, clock?: RunPlanClock): Promise<void> {
  await appendFile(path, `${JSON.stringify(createRunPlanEvent<FanoutLifecycleEvent>(FANOUT_EVENT_SCHEMA, event, { clock }))}\n`)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function workerArtifactRefs(workerId: string, output: Record<string, unknown>, artifactRoot: string): Array<Record<string, unknown>> {
  const refs = Array.isArray(output.evidence_refs) ? output.evidence_refs.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  return refs.map((ref, index) => stripUndefined({
    id: `${workerId}:${index}`,
    worker_id: workerId,
    namespace: `workers/${workerId}`,
    path: bundleRelativeArtifactRef(stringValue(ref.uri) || stringValue(ref.path), artifactRoot),
    kind: stringValue(ref.kind) || "codebox-evidence",
    metadata: stripUndefined({ ...ref, private: stripUndefined({ local_path: isAbsolute(stringValue(ref.path)) ? stringValue(ref.path) : undefined }) }),
  }))
}

function bundleRelativeArtifactRef(path: string, artifactRoot: string): string | undefined {
  if (!path || !isAbsolute(path)) return path
  const relativePath = relative(artifactRoot, path).split(sep).join("/")
  return relativePath.startsWith("../") || relativePath === ".." ? undefined : relativePath
}

function fanoutClock(request: FanoutRequestContract, fallback?: RunPlanClock): RunPlanClock | undefined {
  const deterministic = objectValue(request.deterministic) ?? objectValue(request.replay)
  const fixedTime = stringValue(deterministic?.event_time ?? deterministic?.eventTime ?? request.event_time)
  return fixedTime ? () => fixedTime : fallback
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}
