import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { AGENT_TASK_RUN_REQUEST_SCHEMA, HEADLESS_AGENT_TASK_REQUEST_SCHEMA, artifactResultEnvelope, buildAgentTaskRecipe, DEFAULT_WORDPRESS_VERSION, headlessAgentTaskRequestToRunInput, normalizeAgentRuntimeWorkload, normalizeAgentTaskRunResult, normalizeAgentTerminalResult, normalizeArtifactResultTypedArtifacts, normalizeHeadlessAgentTaskRequest, normalizeHeadlessAgentTaskResult, normalizeTaskInput, parseCommandJson, parseCommandOptions, resolveEffectiveRuntimeToolPolicy, type AgentTaskRunInput, type AgentTaskRunResultSummary, type AgentTerminalResult, type ArtifactResultEnvelope, type HeadlessAgentTaskResult, type SandboxToolPolicySnapshot, type TypedArtifactDTO } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { runRecipeRunCommand } from "./recipe-run.js"

export type { AgentTaskRunInput } from "@automattic/wp-codebox-core"

export interface AgentTaskRunOptions {
  inputPath: string
  json: boolean
  resultFile?: string
  previewHoldSeconds?: string
  previewPublicUrl?: string
  previewPort?: string
  previewBind?: string
  previewHoldBlocking?: boolean
  previewLeaseJson?: string
}

export interface AgentTaskRunOutput {
  success: boolean
  schema: "wp-codebox/agent-task-run/v1"
  status: AgentTaskRunResultSummary["status"]
  session: Record<string, unknown>
  task: string
  task_input: ReturnType<typeof normalizeTaskInput>
  wp: string
  artifacts: string
  agent_result: Record<string, unknown>
  agent_task_result: Record<string, unknown>
  agent_task_run_result: AgentTaskRunResultSummary
  headless_agent_task_result?: HeadlessAgentTaskResult
  terminal_result?: AgentTerminalResult
  completion_outcome: Record<string, unknown>
  component_contracts: Array<Record<string, unknown>>
  structured_artifacts: Array<Record<string, unknown>>
  typed_artifacts: TypedArtifactDTO[]
  outputs: Record<string, unknown>
  artifact_result: ArtifactResultEnvelope
  run: Record<string, unknown>
  diagnostics: Array<Record<string, unknown>>
  agent_runtime_diagnostics: Record<string, unknown>
  evidence_refs: Array<Record<string, unknown>>
  failure_evidence?: Record<string, unknown>
  run_metadata: Record<string, unknown>
  metadata: Record<string, unknown>
}

interface CapturedOutput<T> {
  result: T
  stdout: string
  stderr: string
  exitCode: number
}

export interface FailureEvidenceInput {
  input: AgentTaskRunInput
  task: string
  wpVersion: string
  artifacts: string
  recipePath: string
  generatedRecipeArtifact?: GeneratedRecipeArtifactRef
  run: Record<string, unknown>
  capture?: CapturedOutput<unknown>
  error?: unknown
}

export interface GeneratedRecipeArtifactRef {
  path: string
  absolutePath: string
  kind: "generated-recipe"
  contentType: "application/json"
}

const FAILURE_SNIPPET_CHARS = 4000

export async function runAgentTaskRunCommand(args: string[]): Promise<number> {
  const options = parseAgentTaskRunOptions(args)
  const input = normalizeAgentTaskRunCliInput(JSON.parse(await readFile(options.inputPath, "utf8")))
  const output = await runAgentTask(input, options)
  const jsonOutput = agentTaskRunJsonOutput(output)

  if (options.resultFile) {
    await writeAgentTaskRunResultFile(options.resultFile, jsonOutput)
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(jsonOutput, null, 2)}\n`)
    return agentTaskRunExitCode(output)
  }

  process.stdout.write(`${output.status}: ${output.task}\n`)
  return agentTaskRunExitCode(output)
}

export function normalizeAgentTaskRunCliInput(input: unknown): AgentTaskRunInput {
  const record = objectRecord(input)
  if (record?.schema === HEADLESS_AGENT_TASK_REQUEST_SCHEMA) {
    return headlessAgentTaskRequestToRunInput(normalizeHeadlessAgentTaskRequest(record)) as AgentTaskRunInput
  }

  if (record?.schema !== AGENT_TASK_RUN_REQUEST_SCHEMA) {
    return input as AgentTaskRunInput
  }

  const taskInput = objectRecord(record.task_input)
  if (!taskInput) {
    return input as AgentTaskRunInput
  }

  return stripUndefined({
    ...taskInput,
    artifacts_path: record.artifacts_path ?? taskInput.artifacts_path,
    callback_data: record.callback_data ?? taskInput.callback_data,
  }) as AgentTaskRunInput
}

export function agentTaskRunExitCode(output: Pick<AgentTaskRunOutput, "agent_task_run_result" | "success">): number {
  return output.agent_task_run_result.success ? 0 : 1
}

export function agentTaskRunJsonOutput(output: AgentTaskRunOutput): AgentTaskRunOutput | HeadlessAgentTaskResult {
  return output.headless_agent_task_result ?? output
}

export async function runAgentTask(input: AgentTaskRunInput, options: AgentTaskRunOptions): Promise<AgentTaskRunOutput> {
  const taskInput = normalizeTaskInput(input)
  const task = taskInput.goal
  const wpVersion = stringValue(input.wp) || DEFAULT_WORDPRESS_VERSION
  const artifacts = stringValue(input.artifacts_path) || await mkdtemp(join(tmpdir(), "wp-codebox-agent-task-artifacts-"))
  const recipeDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-agent-task-recipe-"))
  const recipePath = join(recipeDirectory, "recipe.json")
  let capture: CapturedOutput<number> | undefined
  let recipeJson = ""
  let generatedRecipeArtifact: GeneratedRecipeArtifactRef | undefined

  try {
    const recipe = buildAgentTaskRecipe({ ...input, artifacts_path: artifacts }, taskInput, wpVersion)
    recipeJson = `${JSON.stringify(recipe, null, 2)}\n`
    await writeFile(recipePath, recipeJson)
    const recipeRunArgs = ["--recipe", recipePath, "--artifacts", artifacts, "--json"]
    if (options.previewHoldSeconds) {
      recipeRunArgs.push("--preview-hold-seconds", options.previewHoldSeconds)
    }
    if (options.previewPort) {
      recipeRunArgs.push("--preview-port", options.previewPort)
    }
    if (options.previewBind) {
      recipeRunArgs.push("--preview-bind", options.previewBind)
    }
    if (options.previewHoldBlocking) {
      recipeRunArgs.push("--preview-hold-blocking")
    }
    if (options.previewPublicUrl) {
      recipeRunArgs.push("--preview-public-url", options.previewPublicUrl)
    }
    if (options.previewLeaseJson) {
      recipeRunArgs.push("--preview-lease-json", options.previewLeaseJson)
    }
    capture = await captureOutput(() => runRecipeRunCommand(recipeRunArgs))
    generatedRecipeArtifact = await persistGeneratedRecipeArtifact(artifacts, recipeJson)
    const run = parseRecipeRunOutput(capture.stdout)
    const runRecord = objectValue(run.run) || {}
    const artifactsRecord = objectValue(run.artifacts) || {}
    const runtimeRecord = objectValue(run.runtime) || {}
    const agentBundle = objectValue(input.agent_bundle) || {}
    const metadataRuntime = objectValue(objectValue(run.metadata)?.agent_runtime)
    const workload = normalizeAgentRuntimeWorkload(metadataRuntime?.workload ?? run, {
      requiredOutputs: stringRecord(agentBundle.engine_data_outputs),
      toolRecorders: agentBundle.tool_recorders,
      workloadId: stringValue(agentBundle.workload_id) || stringValue(agentBundle.agent_slug) || stringValue(agentBundle.flow_slug) || undefined,
    })
    const hasAgentBundle = Object.keys(agentBundle).length > 0
    const recipeSuccess = Boolean(run.success) && (!hasAgentBundle || workload.success)
    const agentTaskResult = agentTaskResultFromRun(run, runRecord, artifactsRecord)
    const terminalResult = terminalResultFromRun(run, agentTaskResult)
    const completionOutcome = objectValue(run.completionOutcome) || objectValue(run.completion_outcome) || objectValue(artifactsRecord.completionOutcome) || objectValue(artifactsRecord.completion_outcome) || {}
    const agentResult = objectValue(run.agentResult) || objectValue(runRecord.agentResult) || objectValue(artifactsRecord.agentResult) || {}
    const normalizedRunResult = normalizeAgentTaskRunResult({
      ...run,
      success: recipeSuccess,
      agentResult,
      terminal_result: terminalResult,
      completionOutcome,
      workspace_artifact_policy: objectValue((input as Record<string, unknown>).workspace_artifact_policy),
      run_metadata: stripUndefined({
        run_id: stringValue(runRecord.runId),
        run_status: stringValue(runRecord.status),
        runtime_id: stringValue(runtimeRecord.id),
        runtime_status: stringValue(runtimeRecord.status),
        sandbox_session_id: stringValue(input.sandbox_session_id),
        orchestrator: input.orchestrator,
        parent_request_schema: stringValue(input.parent_request?.schema),
      }),
    }, { exitStatus: capture.exitCode })
    const success = normalizedRunResult.success
    const failureEvidence = success ? undefined : buildFailureEvidence({ input, task, wpVersion, artifacts, recipePath, generatedRecipeArtifact, run, capture })
    const outputDiagnostics = [...diagnostics(run, success ? 0 : capture.exitCode, success, failureEvidence), ...(hasAgentBundle ? workload.diagnostics.map((diagnostic) => ({ ...diagnostic })) : [])]
    const agentTaskRunResult = success ? normalizedRunResult : withFailureEvidence(normalizedRunResult, failureEvidence, outputDiagnostics)
    const headlessAgentTaskResult = maybeHeadlessAgentTaskResult(input, agentTaskRunResult)
    const session = sandboxSession(input, run, artifacts, success ? "completed" : "failed")
    const structuredArtifacts = structuredArtifactRefs(agentTaskResult, workload.outputs)
    const outputs = stripUndefined({ ...workload.outputs })
    const typedArtifacts = normalizeArtifactResultTypedArtifacts({ typed_artifacts: [...arrayRecords(agentTaskResult.typed_artifacts), ...arrayRecords(outputs.typed_artifacts)] })
    const evidence = evidenceRefs(run, artifacts, failureEvidence)
    const artifactResult = artifactResultEnvelope({
      operation: "agent-task-run",
      status: success ? "created" : "failed",
      artifactBundle: agentTaskRunResult.refs.artifact_bundles[0],
      artifactRefs: [...agentTaskRunResult.refs.artifact_bundles, ...agentTaskRunResult.artifacts],
      typedArtifacts,
      result: {
        structured_artifacts: structuredArtifacts,
        agent_reply: agentReply(agentResult, terminalResult, agentTaskRunResult),
        transcript_refs: agentTaskRunResult.refs.transcripts,
        evidence_refs: evidence,
        preview: previewMetadata(session, run),
        session,
        outputs,
      },
      diagnostics: artifactResultDiagnostics(outputDiagnostics),
      metadata: artifactResultMetadata(run, input, agentTaskRunResult),
    })
    const output: AgentTaskRunOutput = {
      success,
      schema: "wp-codebox/agent-task-run/v1",
      status: agentTaskRunResult.status,
      session,
      task,
      task_input: taskInput,
      wp: wpVersion,
      artifacts,
      agent_result: agentResult,
      agent_task_result: agentTaskResult,
      agent_task_run_result: agentTaskRunResult,
      headless_agent_task_result: headlessAgentTaskResult,
      terminal_result: terminalResult,
      completion_outcome: completionOutcome,
      component_contracts: componentContractReport(run),
      structured_artifacts: structuredArtifacts,
      typed_artifacts: typedArtifacts,
      outputs: { ...outputs, artifact_result: artifactResult },
      artifact_result: artifactResult,
      run,
      diagnostics: outputDiagnostics,
      agent_runtime_diagnostics: await buildAgentRuntimeDiagnostics(run, input),
      evidence_refs: evidence,
      failure_evidence: failureEvidence,
      run_metadata: stripUndefined({
        run_id: stringValue(runRecord.runId),
        run_status: stringValue(runRecord.status),
        runtime_id: stringValue(runtimeRecord.id),
        runtime_status: stringValue(runtimeRecord.status),
        sandbox_session_id: stringValue(input.sandbox_session_id),
        orchestrator: input.orchestrator,
        parent_request_schema: stringValue(input.parent_request?.schema),
      }),
      metadata: {
        agent_runtime: {
          workload,
        },
        artifact_result: artifactResult,
      },
    }
    return output
  } catch (error) {
    const run = { success: false, error: serializeUnknownError(error) }
    generatedRecipeArtifact = recipeJson ? await persistGeneratedRecipeArtifact(artifacts, recipeJson) : undefined
    const normalizedRunResult = normalizeAgentTaskRunResult(run, { exitStatus: capture?.exitCode ?? 1 })
    const failureEvidence = buildFailureEvidence({ input, task, wpVersion, artifacts, recipePath, generatedRecipeArtifact, run, capture, error })
    const failureDiagnostics = diagnostics(run, capture?.exitCode ?? 1, false, failureEvidence)
    const agentTaskRunResult = withFailureEvidence(normalizedRunResult, failureEvidence, failureDiagnostics)
    const headlessAgentTaskResult = maybeHeadlessAgentTaskResult(input, agentTaskRunResult)
    const session = sandboxSession(input, run, artifacts, "failed")
    const evidence = evidenceRefs(run, artifacts, failureEvidence)
    const artifactResult = artifactResultEnvelope({
      operation: "agent-task-run",
      status: "failed",
      artifactBundle: agentTaskRunResult.refs.artifact_bundles[0],
      artifactRefs: [...agentTaskRunResult.refs.artifact_bundles, ...agentTaskRunResult.artifacts],
      result: {
        agent_reply: agentReply({}, normalizeAgentTerminalResult(run), agentTaskRunResult),
        transcript_refs: agentTaskRunResult.refs.transcripts,
        evidence_refs: evidence,
        preview: previewMetadata(session, run),
        session,
        outputs: {},
      },
      diagnostics: artifactResultDiagnostics(failureDiagnostics),
      metadata: artifactResultMetadata(run, input, agentTaskRunResult),
    })
    return {
      success: false,
      schema: "wp-codebox/agent-task-run/v1",
      status: agentTaskRunResult.status,
      session,
      task,
      task_input: taskInput,
      wp: wpVersion,
      artifacts,
      agent_result: {},
      agent_task_result: {},
      agent_task_run_result: agentTaskRunResult,
      headless_agent_task_result: headlessAgentTaskResult,
      terminal_result: normalizeAgentTerminalResult(run),
      completion_outcome: {},
      component_contracts: componentContractReport(run),
      structured_artifacts: [],
      typed_artifacts: [],
      outputs: { artifact_result: artifactResult },
      artifact_result: artifactResult,
      run,
      diagnostics: failureDiagnostics,
      agent_runtime_diagnostics: await buildAgentRuntimeDiagnostics(run, input),
      evidence_refs: evidence,
      failure_evidence: failureEvidence,
      run_metadata: stripUndefined({
        sandbox_session_id: stringValue(input.sandbox_session_id),
        orchestrator: input.orchestrator,
        parent_request_schema: stringValue(input.parent_request?.schema),
      }),
      metadata: {
        agent_runtime: {
          workload: {
            success: false,
            diagnostics: failureDiagnostics,
          },
        },
        artifact_result: artifactResult,
      },
    }
  } finally {
    await rm(recipeDirectory, { recursive: true, force: true })
  }
}

function maybeHeadlessAgentTaskResult(input: AgentTaskRunInput, agentTaskRunResult: AgentTaskRunResultSummary): HeadlessAgentTaskResult | undefined {
  if (stringValue(input.parent_request?.schema) !== HEADLESS_AGENT_TASK_REQUEST_SCHEMA) {
    return undefined
  }

  return normalizeHeadlessAgentTaskResult(agentTaskRunResult, objectValue(input.parent_request?.metadata))
}

function withFailureEvidence(result: AgentTaskRunResultSummary, failureEvidence: Record<string, unknown> | undefined, diagnostics: Array<Record<string, unknown>>): AgentTaskRunResultSummary {
  if (!failureEvidence) return result

  return {
    ...result,
    diagnostics,
    metadata: stripUndefined({
      ...result.metadata,
      failure_evidence: failureEvidence,
    }),
  }
}

export async function buildAgentRuntimeDiagnostics(run: Record<string, unknown>, input: AgentTaskRunInput = {}): Promise<Record<string, unknown>> {
  const artifactsRecord = objectValue(run.artifacts) || {}
  const metadata = await readJsonRecord(stringValue(artifactsRecord.metadataPath))
  const context = objectValue(metadata?.context) || {}
  const recipe = objectValue(context.recipe) || {}
  const task = objectValue(context.task) || {}
  const recipeInputs = objectValue(recipe.inputs) || {}
  const taskInputs = objectValue(task.inputs) || {}
  const componentContracts = componentContractReport(run)
  const executions = arrayRecords(run.executions)
  const phaseEvidence = arrayRecords(run.phaseEvidence)
  const sandboxRuntime = agentSandboxRuntime(run)
  const sandboxInput = objectValue(sandboxRuntime?.input) || {}
  const sandboxStack = objectValue(sandboxRuntime?.stack) || {}
  const stackSignals = objectValue(sandboxStack.signals) || {}
  const toolPolicy = objectValue(input.sandbox_tool_policy)
  const requestedTools = sandboxToolIdsBeforeFiltering(toolPolicy)
  const runtimeTools = stringArray(sandboxInput.allow_only).length > 0 ? stringArray(sandboxInput.allow_only) : stringArray(objectValue(sandboxInput.tool_policy)?.tools)

  return stripUndefined({
    schema: "wp-codebox/agent-runtime-diagnostics/v1",
    component_contracts: componentContracts.map((contract) => compactRecord(contract, ["slug", "requestedPath", "preparedPath", "pluginFile", "loadAs", "activate", "status", "activationStatus", "failures"])),
    prepared_paths: compactPreparedPaths(context, recipeInputs, taskInputs),
    loader_entries: compactLoaderEntries(run, context, stackSignals),
    loaded_entrypoints: compactLoadedEntrypoints(executions, sandboxStack, stackSignals),
    lifecycle_actions: compactLifecycleActions(phaseEvidence, executions),
    registered_abilities: compactRegisteredAbilities(sandboxRuntime, sandboxStack),
    resolved_tool_ids: stripUndefined({
      before_filtering: requestedTools.length > 0 ? requestedTools : undefined,
      after_filtering: runtimeTools.length > 0 ? runtimeTools : undefined,
    }),
  })
}

function parseAgentTaskRunOptions(args: string[]): AgentTaskRunOptions {
  const { options, positionals } = parseCommandOptions(args, new Set(["--json", "--preview-hold-blocking"]))
  if (positionals.length > 0) {
    throw new Error(`Unknown agent-task-run option: ${positionals[0]}`)
  }
  for (const name of options.keys()) {
    if (!["--input-file", "--json", "--format", "--result-file", "--preview-hold-seconds", "--preview-public-url", "--preview-port", "--preview-bind", "--preview-hold-blocking", "--preview-lease-json"].includes(name)) {
      throw new Error(`Unknown agent-task-run option: ${name}`)
    }
  }
  const inputPath = stringOption(options, "--input-file")
  if (!inputPath) {
    throw new Error("agent-task-run requires --input-file <path>")
  }
  return {
    inputPath,
    json: options.get("--json") === true || stringOption(options, "--format") === "json",
    resultFile: stringOption(options, "--result-file") || undefined,
    previewHoldSeconds: stringOption(options, "--preview-hold-seconds"),
    previewPublicUrl: stringOption(options, "--preview-public-url"),
    previewPort: stringOption(options, "--preview-port"),
    previewBind: stringOption(options, "--preview-bind"),
    previewHoldBlocking: options.get("--preview-hold-blocking") === true,
    previewLeaseJson: stringOption(options, "--preview-lease-json"),
  }
}

/** Write caller-owned structured output without exposing an incomplete result. */
export async function writeAgentTaskRunResultFile(path: string, output: AgentTaskRunOutput | HeadlessAgentTaskResult): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("agent-task-run result-file parent must be a non-symlink directory")
  }
  try {
    const targetStat = await lstat(path)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error("agent-task-run result-file must be a regular file when it already exists")
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function captureOutput<T>(callback: () => Promise<T>): Promise<CapturedOutput<T>> {
  const originalWrite = process.stdout.write.bind(process.stdout)
  const originalErrorWrite = process.stderr.write.bind(process.stderr)
  let stdout = ""
  let stderr = ""
  ;(process.stdout.write as typeof process.stdout.write) = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString()
    callWriteCallback(encodingOrCallback, callback)
    return true
  }) as typeof process.stdout.write
  ;(process.stderr.write as typeof process.stderr.write) = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString()
    callWriteCallback(encodingOrCallback, callback)
    return true
  }) as typeof process.stderr.write
  try {
    const result = await callback()
    return { result, stdout, stderr, exitCode: Number(result) || 0 }
  } finally {
    process.stdout.write = originalWrite
    process.stderr.write = originalErrorWrite
  }
}

function callWriteCallback(encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): void {
  if (typeof encodingOrCallback === "function") {
    encodingOrCallback()
  } else if (callback) {
    callback()
  }
}

function parseRecipeRunOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { success: false, error: { message: "WP Codebox recipe run returned no JSON output." } }
  }
  const parsed = parseCommandJson(trimmed, "WP Codebox recipe run output")
  return objectValue(parsed) || { success: false, error: { message: "WP Codebox recipe run returned a non-object JSON value." } }
}

async function persistGeneratedRecipeArtifact(artifacts: string, contents: string): Promise<GeneratedRecipeArtifactRef> {
  const path = "files/generated-recipe/recipe.json"
  const absolutePath = join(artifacts, path)
  await mkdir(join(artifacts, "files", "generated-recipe"), { recursive: true })
  await writeFile(absolutePath, contents)
  return { path, absolutePath, kind: "generated-recipe", contentType: "application/json" }
}

function stringOption(options: Map<string, string | true>, name: string): string {
  const value = options.get(name)
  return typeof value === "string" ? value : ""
}

function sandboxSession(input: AgentTaskRunInput, run: Record<string, unknown>, artifacts: string, status: "completed" | "failed"): Record<string, unknown> {
  const artifactsRecord = objectValue(run.artifacts) || {}
  const runtimeRecord = objectValue(run.runtime) || {}
  const runtimePreview = objectValue(runtimeRecord.preview) || {}
  return stripUndefined({
    schema: "wp-codebox/sandbox-session/v1",
    id: stringValue(input.sandbox_session_id) || stringValue(input.orchestrator?.agent_task_id),
    status,
    artifacts: stripUndefined({
      directory: artifacts,
      bundle_id: stringValue(artifactsRecord.id) || stringValue(artifactsRecord.bundle_id) || stringValue(artifactsRecord.bundleId),
      preview_url: stringValue(runtimePreview.url) || stringValue(artifactsRecord.preview_url) || stringValue(artifactsRecord.previewUrl),
    }),
    orchestrator: input.orchestrator,
  })
}

function diagnostics(run: Record<string, unknown>, exitCode: number, normalizedSuccess = false, failureEvidence?: Record<string, unknown>): Array<Record<string, unknown>> {
  const existing = Array.isArray(run.diagnostics) ? run.diagnostics.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  if (normalizedSuccess) {
    return existing.filter((entry) => stringValue(entry.class) !== "wp-codebox.agent_task_run_failed")
  }
  if (existing.length > 0) {
    return existing
  }
  if (run.success === true) {
    return []
  }
  const errorRecord = objectValue(run.error) || {}
  return [{
    class: "wp-codebox.agent_task_run_failed",
    message: stringValue(errorRecord.message) || "WP Codebox agent task run failed.",
    data: stripUndefined({
      exit_code: exitCode,
      phase: stringValue(failureEvidence?.phase),
      command: stringValue(failureEvidence?.command),
      failure_evidence: failureEvidence,
    }),
  }]
}

function evidenceRefs(run: Record<string, unknown>, artifacts: string, failureEvidence?: Record<string, unknown>): Array<Record<string, unknown>> {
  const artifactsRecord = objectValue(run.artifacts) || {}
  const terminalResult = terminalResultFromRun(run, objectValue(run.agentTaskResult) || {})
  const refs: Array<Record<string, unknown> | null> = [
    { kind: "codebox-artifacts", uri: artifacts, label: "WP Codebox artifacts" },
    stringValue(artifactsRecord.manifestPath) ? { kind: "codebox-manifest", uri: stringValue(artifactsRecord.manifestPath), label: "WP Codebox artifact manifest" } : null,
    stringValue(artifactsRecord.reviewPath) ? { kind: "codebox-review", uri: stringValue(artifactsRecord.reviewPath), label: "WP Codebox review payload" } : null,
    stringValue(artifactsRecord.patchPath) ? { kind: "codebox-patch", uri: stringValue(artifactsRecord.patchPath), label: "WP Codebox patch" } : null,
    terminalResult ? { kind: "codebox-agent-terminal-result", uri: artifacts, label: "WP Codebox agent terminal result", metadata: terminalResult } : null,
    failureEvidence ? { kind: "codebox-agent-task-failure-evidence", uri: artifacts, label: "WP Codebox agent task failure evidence", metadata: failureEvidenceSummary(failureEvidence) } : null,
  ]
  return refs.filter((entry): entry is Record<string, unknown> => Boolean(entry))
}

function terminalResultFromRun(run: Record<string, unknown>, agentTaskResult: Record<string, unknown>): AgentTerminalResult | undefined {
  return normalizeAgentTerminalResult(run.terminal_result)
    ?? normalizeAgentTerminalResult(agentTaskResult.terminal_result)
    ?? normalizeAgentTerminalResult(agentSandboxRuntime(run))
}

function componentContractReport(run: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(run.componentContracts) ? run.componentContracts.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
}

export function buildFailureEvidence(values: FailureEvidenceInput): Record<string, unknown> {
  const runRecord = objectValue(values.run.run) || {}
  const runtimeRecord = objectValue(values.run.runtime) || objectValue(runRecord.runtime) || {}
  const artifactsRecord = objectValue(values.run.artifacts) || {}
  const execution = failedExecution(values.run)
  const phase = failedPhase(values.run)
  const errorRecord = objectValue(values.run.error) || serializeUnknownError(values.error)
  const stdout = stringValue(execution?.stdout) || values.capture?.stdout || ""
  const stderr = stringValue(execution?.stderr) || values.capture?.stderr || ""
  const recipeRunEvidence = stripUndefined({
    schema: stringValue(values.run.schema) || undefined,
    recipe_path: values.generatedRecipeArtifact?.path ?? values.recipePath,
    recipe_artifact: values.generatedRecipeArtifact ? {
      path: values.generatedRecipeArtifact.path,
      kind: values.generatedRecipeArtifact.kind,
      content_type: values.generatedRecipeArtifact.contentType,
    } : undefined,
    status: stringValue(runRecord.status) || stringValue(values.run.status) || undefined,
    run_id: stringValue(runRecord.runId) || undefined,
  })
  const runtimeEvidence = nonEmptyObject(stripUndefined({
    id: stringValue(runtimeRecord.id) || undefined,
    status: stringValue(runtimeRecord.status) || undefined,
  }))

  return stripUndefined({
    schema: "wp-codebox/agent-task-run-failure-evidence/v1",
    phase: stringValue(execution?.recipePhase) || stringValue(phase?.name) || "agent-task-run",
    command: stringValue(execution?.recipeCommand) || stringValue(execution?.command) || "wp-codebox recipe-run --json",
    exit_code: numberValue(execution?.exitCode) ?? values.capture?.exitCode ?? 1,
    message: stringValue(errorRecord.message) || "WP Codebox agent task run failed.",
    task: values.task,
    recipe_run: recipeRunEvidence,
    runtime: runtimeEvidence,
    sandbox: stripUndefined({
      sandbox_session_id: stringValue(values.input.sandbox_session_id) || undefined,
      orchestrator: values.input.orchestrator,
      artifacts_directory: values.artifacts,
      artifact_bundle_id: stringValue(artifactsRecord.id) || stringValue(artifactsRecord.bundle_id) || stringValue(artifactsRecord.bundleId) || undefined,
    }),
    stdout: outputSnippet(stdout),
    stderr: outputSnippet(stderr),
    diagnostics: Array.isArray(values.run.diagnostics) ? values.run.diagnostics.filter((entry) => Boolean(objectValue(entry))) : undefined,
    phase_evidence: Array.isArray(values.run.phaseEvidence) ? values.run.phaseEvidence.filter((entry) => Boolean(objectValue(entry))) : undefined,
    error: Object.keys(errorRecord).length > 0 ? errorRecord : undefined,
    wp: values.wpVersion,
  })
}

function failedExecution(run: Record<string, unknown>): Record<string, unknown> | undefined {
  const executions = Array.isArray(run.executions) ? run.executions.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  return [...executions].reverse().find((execution) => numberValue(execution.exitCode) !== undefined && numberValue(execution.exitCode) !== 0)
}

function failedPhase(run: Record<string, unknown>): Record<string, unknown> | undefined {
  const phases = Array.isArray(run.phaseEvidence) ? run.phaseEvidence.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
  return [...phases].reverse().find((phase) => stringValue(phase.status) === "failed")
}

function outputSnippet(value: string): Record<string, unknown> | undefined {
  if (!value) return undefined
  const truncated = value.length > FAILURE_SNIPPET_CHARS
  const snippet = truncated ? value.slice(-FAILURE_SNIPPET_CHARS) : value
  return { bytes: Buffer.byteLength(value), truncated, value: snippet }
}

function failureEvidenceSummary(failureEvidence: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
    schema: stringValue(failureEvidence.schema) || undefined,
    phase: stringValue(failureEvidence.phase) || undefined,
    command: stringValue(failureEvidence.command) || undefined,
    exit_code: numberValue(failureEvidence.exit_code),
    runtime: nonEmptyObject(objectValue(failureEvidence.runtime)),
    sandbox: nonEmptyObject(objectValue(failureEvidence.sandbox)),
  })
}

function structuredArtifactRefs(agentTaskResult: Record<string, unknown>, workloadOutputs: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  const direct = Array.isArray(agentTaskResult.structured_artifacts) ? agentTaskResult.structured_artifacts : []
  if (direct.length > 0) {
    return direct.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry)))
  }
  const outputs = objectValue(agentTaskResult.outputs) || {}
  const fromOutputs = Array.isArray(outputs.structured_artifacts) ? outputs.structured_artifacts : []
  const fromWorkloadOutputs = Array.isArray(workloadOutputs.structured_artifacts) ? workloadOutputs.structured_artifacts : []
  return dedupeRecords([...fromOutputs, ...fromWorkloadOutputs].filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))))
}

export function agentTaskResultFromRun(run: Record<string, unknown>, runRecord: Record<string, unknown> = {}, artifactsRecord: Record<string, unknown> = {}): Record<string, unknown> {
  return objectValue(run.agentTaskResult)
    || objectValue(run.agent_task_result)
    || objectValue(runRecord.agentTaskResult)
    || objectValue(runRecord.agent_task_result)
    || objectValue(artifactsRecord.agentTaskResult)
    || objectValue(artifactsRecord.agent_task_result)
    || {}
}

function agentReply(agentResult: Record<string, unknown>, terminalResult: AgentTerminalResult | undefined, runResult: AgentTaskRunResultSummary): Record<string, unknown> | undefined {
  const text = stringValue(agentResult.reply) || stringValue(agentResult.message) || stringValue(agentResult.response)
  const summary = stringValue(agentResult.summary) || runResult.summary
  const status = terminalResult?.status || runResult.status
  return nonEmptyObject(stripUndefined({
    text: text || undefined,
    summary: summary || undefined,
    status,
    metadata: nonEmptyObject(stripUndefined({ terminal_result: terminalResult })),
  }))
}

function previewMetadata(session: Record<string, unknown>, run: Record<string, unknown>): Record<string, unknown> | undefined {
  const runtime = objectValue(run.runtime) || {}
  const preview = objectValue(runtime.preview) || {}
  const sessionArtifacts = objectValue(session.artifacts) || {}
  return nonEmptyObject(stripUndefined({
    ...preview,
    url: stringValue(preview.url) || stringValue(runtime.previewUrl) || stringValue(sessionArtifacts.preview_url) || undefined,
  }))
}

function artifactResultMetadata(run: Record<string, unknown>, input: AgentTaskRunInput, runResult: AgentTaskRunResultSummary): Record<string, unknown> {
  const runRecord = objectValue(run.run) || {}
  const runtimeRecord = objectValue(run.runtime) || {}
  return stripUndefined({
    status: runResult.status,
    success: runResult.success,
    run_id: stringValue(runRecord.runId) || stringValue(runResult.metadata.run_id) || undefined,
    run_status: stringValue(runRecord.status) || stringValue(runResult.metadata.run_status) || undefined,
    runtime_id: stringValue(runtimeRecord.id) || stringValue(runResult.metadata.runtime_id) || undefined,
    runtime_status: stringValue(runtimeRecord.status) || stringValue(runResult.metadata.runtime_status) || undefined,
    sandbox_session_id: stringValue(input.sandbox_session_id) || undefined,
    orchestrator: input.orchestrator,
    parent_request_schema: stringValue(input.parent_request?.schema) || undefined,
  })
}

function artifactResultDiagnostics(diagnostics: Array<Record<string, unknown>>): Array<{ code: string, message: string, severity?: "info" | "warning" | "error", phase?: string, metadata?: Record<string, unknown> }> {
  return diagnostics.map((diagnostic) => stripUndefined({
    code: stringValue(diagnostic.code ?? diagnostic.class ?? diagnostic.kind) || "wp-codebox.agent_task_diagnostic",
    message: stringValue(diagnostic.message) || "WP Codebox agent task diagnostic.",
    severity: diagnostic.severity === "info" || diagnostic.severity === "warning" || diagnostic.severity === "error" ? diagnostic.severity : undefined,
    phase: stringValue(diagnostic.phase) || undefined,
    metadata: nonEmptyObject(objectValue(diagnostic.data ?? diagnostic.metadata)),
  }))
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  if (!path) return undefined
  try {
    return objectValue(JSON.parse(await readFile(path, "utf8")))
  } catch {
    return undefined
  }
}

function compactPreparedPaths(context: Record<string, unknown>, recipeInputs: Record<string, unknown>, taskInputs: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
    component_contracts: arrayRecords(context.preparedComponentContracts).map((contract) => compactRecord(contract, ["slug", "requestedPath", "preparedPath", "pluginFile", "loadAs", "activate", "status"])),
    workspaces: arrayRecords(context.preparedWorkspaces).map((workspace) => compactRecord(workspace, ["target", "mode", "metadata"])),
    staged_files: arrayRecords(context.preparedStagedFiles).map((file) => compactRecord(file, ["sourceRef", "target", "type", "provenance", "metadata"])),
    dependency_overlays: arrayRecords(context.preparedDependencyOverlays).map((overlay) => compactRecord(overlay, ["package", "target", "type", "mode", "metadata"])),
    runtime_overlays: arrayRecords(context.preparedRuntimeOverlays).map((overlay) => compactRecord(overlay, ["target", "type", "mode", "metadata"])),
    requested_component_contracts: arrayRecords(recipeInputs.component_contracts ?? taskInputs.component_contracts).map((contract) => compactRecord(contract, ["slug", "path", "loadAs", "activate"])),
  })
}

function compactLoaderEntries(run: Record<string, unknown>, context: Record<string, unknown>, stackSignals: Record<string, unknown>): Array<Record<string, unknown>> {
  const componentEntries = componentContractReport(run)
    .map((contract) => compactRecord(contract, ["slug", "pluginFile", "preparedPath", "loadAs", "activationStatus", "status"]))
  const preparedEntries = arrayRecords(context.preparedComponentContracts)
    .map((contract) => compactRecord(contract, ["slug", "pluginFile", "preparedPath", "loadAs", "activate", "status"]))
  const providerEntries = arrayRecords(stackSignals.provider_plugin_files)
    .map((plugin) => compactRecord(plugin, ["slug", "source", "plugin_file", "mounted_path", "load_as", "mounted"]))
  return dedupeRecords([...componentEntries, ...preparedEntries, ...providerEntries])
}

function compactLoadedEntrypoints(executions: Array<Record<string, unknown>>, sandboxStack: Record<string, unknown>, stackSignals: Record<string, unknown>): Array<Record<string, unknown>> {
  const activationExecutions = executions
    .filter((execution) => stringValue(execution.recipeCommand).startsWith("extra-plugin.activate:"))
    .map((execution) => stripUndefined({ entrypoint: stringValue(execution.recipeCommand).replace("extra-plugin.activate:", ""), load_as: "plugin", exit_code: numberValue(execution.exitCode) }))
  const pluginActivations = Object.entries(objectValue(sandboxStack.plugins) || {})
    .map(([entrypoint, value]) => stripUndefined({ entrypoint, active: objectValue(value)?.active, load_as: stringValue(objectValue(value)?.load_as), error: stringValue(objectValue(value)?.error) || undefined }))
  const providerPlugins = stringArray(stackSignals.provider_plugins)
    .map((entrypoint) => ({ entrypoint, source: "provider_plugins" }))
  return dedupeRecords([...activationExecutions, ...pluginActivations, ...providerPlugins])
}

function compactLifecycleActions(phaseEvidence: Array<Record<string, unknown>>, executions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const phases = phaseEvidence.map((phase) => compactRecord(phase, ["name", "status", "durationMs", "data", "error"]))
  const commands = executions.map((execution) => stripUndefined({ phase: stringValue(execution.recipePhase), command: stringValue(execution.recipeCommand) || stringValue(execution.command), exit_code: numberValue(execution.exitCode) }))
  return dedupeRecords([...phases, ...commands])
}

function compactRegisteredAbilities(sandboxRuntime: Record<string, unknown> | undefined, sandboxStack: Record<string, unknown>): Record<string, unknown> | undefined {
  const stackAbilities = objectValue(sandboxStack.abilities)
  const runtimeAbilities = objectValue(sandboxRuntime?.abilities)
  const source = stackAbilities || runtimeAbilities
  if (!source) return undefined
  return stripUndefined({
    count: numberValue(source.count),
    ids: stringArray(source.ids),
    requested: stringValue(source.requested) || undefined,
    requested_available: typeof source.requested_available === "boolean" ? source.requested_available : undefined,
  })
}

function agentSandboxRuntime(run: Record<string, unknown>): Record<string, unknown> | undefined {
  const agentTaskResult = objectValue(run.agentTaskResult)
  const raw = objectValue(agentTaskResult?.raw)
  const direct = objectValue(raw?.agent_runtime)
  if (direct) return direct

  for (const execution of [...arrayRecords(run.executions)].reverse()) {
    if (stringValue(execution.recipeCommand) !== "wp-codebox.agent-sandbox-run") continue
    const parsed = parseJsonObject(stringValue(execution.stdout)) || parseJsonObject(stringValue(execution.stderr))
    const runtime = objectValue(parsed?.agent_runtime)
    if (runtime) return runtime
  }
  return undefined
}

function sandboxToolIdsBeforeFiltering(policy: Record<string, unknown> | undefined): string[] {
  if (!policy || !Array.isArray(policy.tools)) return []
  return resolveEffectiveRuntimeToolPolicy(policy as unknown as SandboxToolPolicySnapshot).tools.map((tool) => tool.runtimeToolId)
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return undefined
  }
}

function compactRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return stripUndefined(Object.fromEntries(keys.map((key) => [key, record[key]])))
}

function dedupeRecords(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>()
  return records.filter((record) => {
    if (Object.keys(record).length === 0) return false
    const key = JSON.stringify(record)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(objectValue(entry))) : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((entry) => stringValue(entry)).filter(Boolean))].sort() : []
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = objectValue(value)
  if (!record) return undefined
  return Object.fromEntries(Object.entries(record).filter(([, entry]) => typeof entry === "string")) as Record<string, string>
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim()
}

function nonEmptyObject(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function serializeUnknownError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return stripUndefined({ name: error.name, message: error.message, stack: error.stack })
  }
  return { message: stringValue(error) || "Unknown WP Codebox agent task run failure." }
}
