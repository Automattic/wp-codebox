import { readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { artifactBundleRunRef, normalizeRecipeRunSummary, runtimeRunResultFromRecipeSummary, type ArtifactBundle, type RuntimeInfo, type RuntimeRunRecord, type RuntimeRunRegistry } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { serializeError } from "../output.js"
import { finalizeAgentSandboxEvidence, finalizeRecipeArtifactEvidence, recipeAgentResultOutput, recipeAgentTaskResultOutput, recipeCompletionOutcomeOutput, recipeReplayStatusOutput, recipeTerminalResultOutput } from "../recipe-evidence.js"
import { recipeRunFailureStatus, serializeRecipeRunError } from "./recipe-run-output.js"
import type { RecipeArtifactPointerTracker } from "./recipe-run-artifact-pointers.js"
import type { RecipeAdvisoryFailure, RecipeBrowserEvidence, RecipeDiagnosticArtifactRef, RecipeExecutionResult, RecipeInterruptionController, RecipePhaseEvidence, RecipeRunComponentContract, RecipeRunDeclaredArtifact, RecipeRunFixtureDatabase, RecipeRunOutput, RecipeRunProbe, RecipeRunSiteSeed, RecipeRunStagedFile } from "./recipe-run-types.js"
import type { RunOutput } from "../runtime-command-wrappers.js"

export interface RunResourceCleanupEvidence {
  durationMs: number
  state: "completed" | "failed"
  status: RuntimeRunRecord["lifecycle"]["cleanup"]["status"]
  attempts: number
  error?: RunOutput["error"]
}

interface RunResourceEvidenceOptions {
  startedAtMs: number
  status: RuntimeRunRecord["status"]
  startupDurationMs?: number
  cleanup?: RunResourceCleanupEvidence
  artifacts?: ArtifactBundle
  failure?: RunOutput["error"]
  phaseEvidence?: RecipePhaseEvidence[]
}

interface RecipeRunFinalizerBase {
  recipePath: string
  runRegistry: RuntimeRunRegistry
  runRecord: RuntimeRunRecord
  artifactPointer: RecipeArtifactPointerTracker
  startedAtMs: number
}

interface RecipeRunCommonOutputFields {
  runtime?: RuntimeInfo
  executions: RecipeExecutionResult[]
  componentContracts?: RecipeRunComponentContract[]
  stagedFiles?: RecipeRunStagedFile[]
  fixtureDatabases?: RecipeRunFixtureDatabase[]
  siteSeeds?: RecipeRunSiteSeed[]
  distributionSetupArtifacts?: RecipeRunOutput["distributionSetupArtifacts"]
  distributionStartupProbes?: RecipeRunOutput["distributionStartupProbes"]
  probes?: RecipeRunProbe[]
  declaredArtifacts?: RecipeRunDeclaredArtifact[]
  phaseEvidence?: RecipePhaseEvidence[]
  advisoryFailures?: RecipeAdvisoryFailure[]
  browserEvidence?: RecipeBrowserEvidence[]
  diagnostics?: RecipeRunOutput["diagnostics"]
  benchResults?: RecipeRunOutput["benchResults"]
  benchResultsList?: RecipeRunOutput["benchResultsList"]
  agentResult?: RecipeRunOutput["agentResult"]
  agentTaskResult?: RecipeRunOutput["agentTaskResult"]
  terminalResult?: RecipeRunOutput["terminalResult"]
  completionOutcome?: RecipeRunOutput["completionOutcome"]
  replayStatus?: RecipeRunOutput["replayStatus"]
  fuzzRun?: RecipeRunOutput["fuzzRun"]
  artifacts?: ArtifactBundle
  interruption?: RecipeRunOutput["interruption"]
}

interface FinalizeCompletedRecipeRunOptions extends RecipeRunFinalizerBase {
  success: boolean
  runtime: RuntimeInfo
  artifacts: ArtifactBundle
  startupDurationMs?: number
  cleanup?: RunResourceCleanupEvidence
  phaseEvidence: RecipePhaseEvidence[]
  browserEvidence: RecipeBrowserEvidence[]
  replayStatus?: RecipeRunOutput["replayStatus"]
  failure?: RunOutput["error"]
  output: RecipeRunCommonOutputFields
}

interface FinalizeRecoveredRecipeFailureOptions extends RecipeRunFinalizerBase {
  originalError: unknown
  serializedError: RunOutput["error"]
  runtime?: RuntimeInfo
  artifacts?: ArtifactBundle
  startupDurationMs?: number
  cleanup?: RunResourceCleanupEvidence
  phaseEvidence: RecipePhaseEvidence[]
  browserEvidence: RecipeBrowserEvidence[]
  diagnosticArtifacts: RecipeDiagnosticArtifactRef[]
  interruption?: RecipeInterruptionController
  output: RecipeRunCommonOutputFields
}

export function recipeRunOutputWithResult<T extends RecipeRunOutput>(output: T): T {
  output.result = normalizeRecipeRunSummary(output)
  return output
}

export function completedRecipeOutputFields(args: {
  executions: RecipeExecutionResult[]
  componentContracts?: RecipeRunComponentContract[]
  stagedFiles: RecipeRunStagedFile[]
  fixtureDatabases: RecipeRunFixtureDatabase[]
  siteSeeds: RecipeRunOutput["siteSeeds"]
  distributionSetupArtifacts: NonNullable<RecipeRunOutput["distributionSetupArtifacts"]>
  distributionStartupProbes: NonNullable<RecipeRunOutput["distributionStartupProbes"]>
  probes: RecipeRunProbe[]
  declaredArtifacts: RecipeRunDeclaredArtifact[]
  phaseEvidence: RecipePhaseEvidence[]
  advisoryFailures: RecipeAdvisoryFailure[]
  browserEvidence: RecipeBrowserEvidence[]
  benchResultsList: NonNullable<RecipeRunOutput["benchResultsList"]>
  fuzzRun?: RecipeRunOutput["fuzzRun"]
  evidence: Awaited<ReturnType<typeof finalizeRecipeArtifactEvidence>> & Awaited<ReturnType<typeof finalizeAgentSandboxEvidence>>
}): Pick<RecipeRunOutput, "executions"> & Partial<RecipeRunOutput> {
  return {
    executions: args.executions,
    componentContracts: args.componentContracts,
    stagedFiles: args.stagedFiles,
    fixtureDatabases: args.fixtureDatabases,
    siteSeeds: args.siteSeeds,
    ...(args.distributionSetupArtifacts.length > 0 ? { distributionSetupArtifacts: args.distributionSetupArtifacts } : {}),
    ...(args.distributionStartupProbes.length > 0 ? { distributionStartupProbes: args.distributionStartupProbes } : {}),
    probes: args.probes,
    declaredArtifacts: args.declaredArtifacts,
    phaseEvidence: args.phaseEvidence,
    ...(args.advisoryFailures.length > 0 ? { advisoryFailures: args.advisoryFailures } : {}),
    ...(args.browserEvidence.length > 0 ? { browserEvidence: args.browserEvidence } : {}),
    ...(args.benchResultsList.length === 1 ? { benchResults: args.benchResultsList[0] } : {}),
    ...(args.benchResultsList.length > 0 ? { benchResultsList: args.benchResultsList } : {}),
    ...(args.evidence.agentResult ? { agentResult: recipeAgentResultOutput(args.evidence.agentResult) } : {}),
    ...(args.evidence.agentTaskResult ? { agentTaskResult: recipeAgentTaskResultOutput(args.evidence.agentTaskResult) } : {}),
    ...(args.evidence.terminalResult ? { terminalResult: recipeTerminalResultOutput(args.evidence.terminalResult) } : {}),
    ...(args.evidence.completionOutcome ? { completionOutcome: recipeCompletionOutcomeOutput(args.evidence.completionOutcome) } : {}),
    ...(args.evidence.replayStatus ? { replayStatus: recipeReplayStatusOutput(args.evidence.replayStatus) } : {}),
    ...(args.fuzzRun ? { fuzzRun: args.fuzzRun } : {}),
  }
}

export async function finalizeRecipeValidationFailure(args: RecipeRunFinalizerBase & { failure: RunOutput["error"]; componentContracts?: RecipeRunComponentContract[]; validation: RecipeRunOutput["validation"] }): Promise<RecipeRunOutput> {
  let runRecord = await args.runRegistry.update(args.runRecord.runId, {
    status: "failed",
    metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs: args.startedAtMs, status: "failed", failure: args.failure }) },
    error: args.failure,
  })
  const output: RecipeRunOutput = recipeRunOutputWithResult({
    success: false,
    schema: "wp-codebox/recipe-run/v1",
    recipePath: args.recipePath,
    executions: [],
    componentContracts: args.componentContracts,
    validation: args.validation,
    run: runRecord,
    error: args.failure,
  })
  runRecord = await args.runRegistry.update(args.runRecord.runId, { result: runtimeRunResultFromRecipeSummary(output.result!) })
  output.run = runRecord
  await args.artifactPointer.update({ command: "recipe.validate", commandStatus: "failed", failure: args.failure, result: output.result })
  return output
}

export async function finalizeCompletedRecipeRun(args: FinalizeCompletedRecipeRunOptions): Promise<RecipeRunOutput> {
  const status = args.success ? "succeeded" : "failed"
  let runRecord = await args.runRegistry.update(args.runRecord.runId, {
    status,
    runtime: args.runtime,
    preview: args.artifacts.preview,
    artifactRefs: artifactBundleRunRef(args.artifacts),
    metadata: {
      runResourceEvidence: await runResourceEvidence({ startedAtMs: args.startedAtMs, status, startupDurationMs: args.startupDurationMs, cleanup: args.cleanup, artifacts: args.artifacts, failure: args.failure, phaseEvidence: args.phaseEvidence }),
      ...(args.replayStatus ? { replayStatus: args.replayStatus } : {}),
    },
    ...(args.failure ? { error: args.failure } : {}),
  })
  const output = recipeRunOutputWithResult(stripUndefined({
    success: args.success,
    schema: "wp-codebox/recipe-run/v1" as const,
    recipePath: args.recipePath,
    ...args.output,
    runtime: args.runtime,
    artifacts: args.artifacts,
    run: runRecord,
    error: args.failure,
  }) as RecipeRunOutput)
  runRecord = await args.runRegistry.update(args.runRecord.runId, { result: runtimeRunResultFromRecipeSummary(output.result!) })
  output.run = runRecord
  await args.artifactPointer.update({ commandStatus: args.success ? "completed" : "failed", runtime: args.runtime, artifacts: args.artifacts, failure: args.failure, phases: args.phaseEvidence, browserEvidence: args.browserEvidence, result: output.result })
  return output
}

export async function finalizeRecoveredRecipeFailure(args: FinalizeRecoveredRecipeFailureOptions): Promise<RecipeRunOutput> {
  const status = recipeRunFailureStatus(args.originalError, args.interruption)
  let runRecord = await args.runRegistry.update(args.runRecord.runId, {
    status,
    ...(args.runtime ? { runtime: args.runtime } : {}),
    ...(args.artifacts ? { preview: args.artifacts.preview, artifactRefs: artifactBundleRunRef(args.artifacts) } : {}),
    metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs: args.startedAtMs, status, startupDurationMs: args.startupDurationMs, cleanup: args.cleanup, artifacts: args.artifacts, failure: args.serializedError, phaseEvidence: args.phaseEvidence }) },
    error: args.serializedError,
  })
  const output = recipeRunOutputWithResult(stripUndefined({
    success: false,
    schema: "wp-codebox/recipe-run/v1" as const,
    recipePath: args.recipePath,
    ...args.output,
    ...(args.runtime ? { runtime: args.runtime } : {}),
    ...(args.artifacts ? { artifacts: args.artifacts } : {}),
    run: runRecord,
    ...(args.interruption?.metadata ? { interruption: args.interruption.metadata } : {}),
    error: args.serializedError,
  }) as RecipeRunOutput)
  runRecord = await args.runRegistry.update(args.runRecord.runId, { result: runtimeRunResultFromRecipeSummary(output.result!) })
  output.run = runRecord
  await args.artifactPointer.update({ commandStatus: "failed", ...(args.runtime ? { runtime: args.runtime } : {}), ...(args.artifacts ? { artifacts: args.artifacts } : {}), failure: args.serializedError, phases: args.phaseEvidence, browserEvidence: args.browserEvidence, diagnosticArtifacts: args.diagnosticArtifacts, result: output.result })
  return output
}

export async function runRecipeCleanup(runRegistry: RuntimeRunRegistry, runRecord: RuntimeRunRecord, cleanup: () => Promise<void>): Promise<RunResourceCleanupEvidence> {
  const startedAtMs = Date.now()
  await runRegistry.update(runRecord.runId, { cleanup: { status: "running" } })
  try {
    await cleanup()
    const updatedRunRecord = await runRegistry.update(runRecord.runId, { cleanup: { status: "succeeded" } })
    return cleanupEvidenceFromRunRecord(updatedRunRecord, Date.now() - startedAtMs)
  } catch (error) {
    const updatedRunRecord = await runRegistry.update(runRecord.runId, { cleanup: { status: "failed", error: serializeError(error) } })
    const cleanupError = serializeRecipeRunError(error)
    cleanupEvidenceFromRunRecord(updatedRunRecord, Date.now() - startedAtMs, cleanupError)
    throw error
  }
}

function cleanupEvidenceFromRunRecord(runRecord: RuntimeRunRecord, durationMs: number, error?: RunOutput["error"]): RunResourceCleanupEvidence {
  const cleanup = runRecord.lifecycle.cleanup
  return stripUndefined({
    durationMs,
    state: cleanup.status === "failed" ? "failed" as const : "completed" as const,
    status: cleanup.status,
    attempts: cleanup.attempts,
    error: error ?? cleanup.error,
  }) as RunResourceCleanupEvidence
}

export async function runResourceEvidence(options: RunResourceEvidenceOptions): Promise<Record<string, unknown>> {
  return stripUndefined({
    schema: "wp-codebox/run-resource-evidence/v1",
    status: options.status,
    timing: {
      startup: metricOrUnavailable(options.startupDurationMs, "runtime creation was not reached"),
      duration: { available: true, unit: "ms", value: Date.now() - options.startedAtMs },
      cleanup: options.cleanup ?? unavailableMetric("runtime cleanup was not reached"),
    },
    resources: {
      hostProcess: hostProcessResourceEvidence(),
      runtimeMemory: unavailableMetric("WordPress Playground runtime memory is not exposed by the runtime backend"),
      runtimeProcessCount: unavailableMetric("WordPress Playground runtime process count is not exposed by the runtime backend"),
    },
    artifacts: await artifactSizeEvidence(options.artifacts),
    phases: options.phaseEvidence ?? [],
    reliability: {
      failureClassification: classifyRunResourceFailure(options.status, options.failure),
      retryCount: unavailableMetric("recipe-run does not retry worker executions"),
    },
  })
}

function metricOrUnavailable(value: number | undefined, reason: string): Record<string, unknown> {
  return typeof value === "number" ? { available: true, unit: "ms", value } : unavailableMetric(reason)
}

function unavailableMetric(reason: string): Record<string, unknown> {
  return { available: false, reason }
}

function hostProcessResourceEvidence(): Record<string, unknown> {
  const memory = process.memoryUsage()
  const usage = process.resourceUsage()
  return {
    available: true,
    pid: process.pid,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    maxRssBytes: usage.maxRSS > 0 ? usage.maxRSS * 1024 : undefined,
    source: "node-process",
  }
}

async function artifactSizeEvidence(artifacts: ArtifactBundle | undefined): Promise<Record<string, unknown>> {
  if (!artifacts) {
    return unavailableMetric("artifact bundle was not created")
  }

  try {
    return {
      available: true,
      directory: artifacts.directory,
      bytes: await directorySizeBytes(artifacts.directory),
      bundleId: artifacts.id,
    }
  } catch (error) {
    return unavailableMetric(`artifact size could not be measured: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function directorySizeBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      total += await directorySizeBytes(path)
    } else if (entry.isFile()) {
      total += (await stat(path)).size
    }
  }
  return total
}

function classifyRunResourceFailure(status: RuntimeRunRecord["status"], failure: RunOutput["error"] | undefined): Record<string, unknown> {
  if (!failure) {
    return { available: true, value: status === "succeeded" ? "none" : "unknown" }
  }

  const code = failure.code ?? failure.name
  const phase = typeof failure.phase === "string" ? failure.phase : undefined
  const value = code === "recipe-phase-failed" && phase
    ? classifyRecipePhaseFailure(phase)
    : code === "recipe-run-timeout"
    ? "timeout"
    : code === "recipe-interrupted"
      ? "cancelled"
      : code === "recipe-cleanup-failed"
        ? "cleanup"
      : code === "recipe-runtime-create-failed" || code === "wp-codebox-playground-cli-exited"
        ? "startup"
        : status === "cancelled"
          ? "cancelled"
          : "execution"

  return { available: true, value, code, ...(phase ? { phase } : {}), message: failure.message }
}

function classifyRecipePhaseFailure(phase: string): string {
  switch (phase) {
    case "runtime_startup":
    case "run_blueprint_steps":
      return "startup"
    case "mount_plugins":
      return "plugin_mount"
    case "activate_plugins":
      return "plugin_activation"
    case "import_fixture_databases":
      return "fixture_database"
    case "run_workloads":
      return "workload"
    case "run_probes":
      return "probe"
    case "collect_artifacts":
      return "artifact_collection"
    default:
      return "execution"
  }
}
