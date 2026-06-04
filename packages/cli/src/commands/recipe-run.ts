import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { RuntimeRunRegistry, artifactBundleRunRef, artifactManifestFile, createBenchResultsJsonSchema, createRuntimeRunId, defaultRunRegistryDirectory, createRuntime, refreshArtifactManifestFileSha256s, stripUndefined, upsertArtifactManifestFiles, type ArtifactBundle, type ArtifactManifest, type ArtifactManifestFile, type BenchmarkArtifactRef, type BenchResults, type ExecutionResult, type Runtime, type RuntimeAssetSpec, type RuntimeInfo, type RuntimeRunRecord, type WorkspaceRecipe, type WorkspaceRecipePluginRuntimeHealthProbe, type WorkspaceRecipeSiteSeed } from "@automattic/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"
import { Ajv2020 } from "ajv/dist/2020.js"
import { recipeExecutionSpec, sandboxWorkspaceContract } from "../agent-sandbox.js"
import { captureStdout, printRecipeHumanOutput, printRecipeValidateHumanOutput, serializeError } from "../output.js"
import { parsePreviewBind, parsePreviewHoldSeconds, parsePreviewPort, parsePreviewPublicUrl } from "../preview-options.js"
import { dryRunRecipe, pluginRuntimeHealthProbeStepIndex, pluginRuntimeSetupStepIndex, recipeDryRunSiteSeeds, siteSeedScopesAreBounded, type RecipeDryRunOutput, type RecipeDryRunSiteSeed, type RecipeDryRunStagedFile } from "../recipe-dry-run.js"
import { collectAndFinalizeFailedRecipeArtifacts, finalizeAgentSandboxEvidence, finalizeRecipeArtifactEvidence, recipeAgentResultFailure, recipeAgentResultOutput, recipeAgentTaskResultOutput, recipeArtifactEvidenceFailure, recipeCompletionOutcomeOutput, type AgentSandboxResultSummary, type AgentTaskSingleResult, type SandboxCompletionOutcome } from "../recipe-evidence.js"
import { cleanupRecipePreparedSources, installMuPluginsCode, prepareRecipeExtraPlugins, prepareRecipeRuntimeOverlays, prepareRecipeStagedFiles, prepareRecipeWorkspaces, recipeBlueprintWithBootActivePlugins, recipeExtraPlugins, recipeMountType, type PreparedExtraPlugin, type PreparedRuntimeOverlay, type PreparedStagedFile, type PreparedWorkspaceMount } from "../recipe-sources.js"
import { parseWorkspaceRecipe, pluginRuntimeHealthProbeStep, recipePolicy, recipeWorkflowSteps, validateWorkspaceRecipe, type RecipeValidationIssue, type RecipeWorkflowPhase } from "../recipe-validation.js"
import { DEFAULT_WORDPRESS_VERSION, previewSpec, releaseRuntime, runtimeMetadata, type RunOutput } from "../runtime-command-wrappers.js"

interface RecipeRunOptions {
  recipePath: string
  artifactsDirectory?: string
  runRegistryDirectory?: string
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  timeoutMs: number
  json: boolean
  dryRun: boolean
}

type RecipeInterruptionSignal = "SIGINT" | "SIGTERM" | "SIGHUP"

interface RecipeInterruptionMetadata {
  signal: RecipeInterruptionSignal
  receivedAt: string
  artifactsFinalized: boolean
}

interface RecipeInterruptionController {
  readonly metadata: RecipeInterruptionMetadata | undefined
  install(): void
  dispose(): void
  interruptible<T>(promise: Promise<T>): Promise<T>
  throwIfInterrupted(): void
  propagateIfInterrupted(): void
}

interface RecipeValidateOptions {
  recipePath: string
  json: boolean
}

interface RecipeValidateOutput {
  success: boolean
  schema: "wp-codebox/recipe-validation/v1"
  recipePath?: string
  valid: boolean
  issues: RecipeValidationIssue[]
  summary?: {
    steps: number
    mounts: number
    workspaces: number
    extraPlugins: number
    stagedFiles: number
  }
  error?: RunOutput["error"]
}

interface RecipeRunOutput {
  success: boolean
  schema: "wp-codebox/recipe-run/v1"
  recipePath?: string
  runtime?: RuntimeInfo
  executions: RecipeExecutionResult[]
  stagedFiles?: RecipeRunStagedFile[]
  siteSeeds?: RecipeRunSiteSeed[]
  phaseEvidence?: RecipePhaseEvidence[]
  diagnostics?: RecipeRuntimeDiagnostic[]
  validation?: {
    issues: RecipeValidationIssue[]
  }
  benchResults?: BenchResults
  benchResultsList?: BenchResults[]
  agentResult?: AgentSandboxResultSummary
  agentTaskResult?: AgentTaskSingleResult
  completionOutcome?: SandboxCompletionOutcome
  artifacts?: ArtifactBundle
  run?: RuntimeRunRecord
  interruption?: RecipeInterruptionMetadata
  logs?: string[]
  error?: RunOutput["error"]
}

type RecipeRunCommandOutput = RecipeRunOutput | RecipeDryRunOutput

const DEFAULT_RECIPE_RUN_TIMEOUT_MS = 25 * 60 * 1000

type RecipeExecutionResult = ExecutionResult & {
  recipePhase?: RecipeWorkflowPhase
  recipeStepIndex?: number
  recipeCommand?: string
}

type RecipePhaseName = "runtime_startup" | "mount_plugins" | "activate_plugins" | "run_blueprint_steps" | "run_workloads" | "collect_artifacts"

interface RecipePhaseEvidence {
  schema: "wp-codebox/recipe-phase-evidence/v1"
  name: RecipePhaseName
  status: "completed" | "failed"
  startedAt: string
  endedAt: string
  durationMs: number
  data?: Record<string, unknown>
  error?: RunOutput["error"]
}

interface RecipePluginRuntimeDiagnostic {
  schema: "wp-codebox/plugin-runtime-diagnostic/v1"
  severity: "error"
  phase: "setup" | "health-probe" | "runtime" | "overlay-preparation"
  name?: string
  command?: string
  exitCode?: number
  message: string
  executionIndex?: number
}

interface RecipePhaseDiagnostic {
  schema: "wp-codebox/recipe-phase-diagnostic/v1"
  severity: "error"
  phase: RecipePhaseName
  pluginFile?: string
  command?: string
  exitCode?: number
  message: string
  executionIndex?: number
}

type RecipeRuntimeDiagnostic = RecipePluginRuntimeDiagnostic | RecipePhaseDiagnostic

interface RecipeRunSiteSeed extends Omit<RecipeDryRunSiteSeed, "dryRunOnly"> {
  action: "imported" | "skipped"
  reason?: string
  counts?: Record<string, number>
  warnings?: string[]
  provenance?: Record<string, unknown>
}

interface RecipeRunStagedFile extends RecipeDryRunStagedFile {
  action: "staged"
}

interface BenchmarkArtifactOutput {
  schema: "wp-codebox/benchmark-artifacts/v1"
  artifactBundle: {
    id: string
    directory: string
    contentDigest: string
  }
  results: BenchResults[]
  scenarios: Array<{
    componentId: string
    scenarioId: string
    source?: string
    artifactRefs: BenchmarkArtifactRef[]
  }>
}

type BenchScenarioWithArtifactRefs = BenchResults["scenarios"][number] & {
  artifactRefs?: BenchmarkArtifactRef[]
  samples?: Array<{ artifacts?: unknown }>
}

const benchResultsAjv = new Ajv2020({ strict: false })
const validateBenchResultsSchema = benchResultsAjv.compile(createBenchResultsJsonSchema())

export async function runRecipeRunCommand(args: string[]): Promise<number> {
  const options = parseRecipeRunOptions(args)
  const interruption = options.dryRun ? undefined : createRecipeInterruptionController()
  interruption?.install()
  const execute = (): Promise<RecipeRunCommandOutput> => options.dryRun ? dryRunRecipe(options, { defaultWordPressVersion: DEFAULT_WORDPRESS_VERSION, resolveExecutionSpec: recipeExecutionSpec }) : runRecipe(options, interruption)

  try {
    if (!options.json) {
      const output = interruptedRecipeOutput(await execute(), interruption)
      printRecipeHumanOutput(output)
      interruption?.propagateIfInterrupted()
      exitAfterRecipeRunTimeout(output)
      exitAfterPlaygroundCliBootFailure(output)
      return output.success ? 0 : 1
    }

    const { result, logs } = await captureStdout(execute)
    const interruptedResult = interruptedRecipeOutput(result, interruption)
    const output = logs.length > 0 ? { ...interruptedResult, logs } : interruptedResult
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    printJsonFailureDiagnostic(output)
    interruption?.propagateIfInterrupted()
    exitAfterRecipeRunTimeout(output)
    exitAfterPlaygroundCliBootFailure(output)
    return output.success ? 0 : 1
  } finally {
    interruption?.dispose()
  }
}

function exitAfterPlaygroundCliBootFailure(output: RecipeRunCommandOutput): void {
  if (output.schema === "wp-codebox/recipe-run/v1" && output.error?.code === "wp-codebox-playground-cli-exited") {
    process.exit(output.success ? 0 : 1)
  }
}

function exitAfterRecipeRunTimeout(output: RecipeRunCommandOutput): void {
  if (output.schema === "wp-codebox/recipe-run/v1" && output.error?.code === "recipe-run-timeout") {
    process.exit(output.success ? 0 : 1)
  }
}

export async function runRecipeValidateCommand(args: string[]): Promise<number> {
  const options = parseRecipeValidateOptions(args)
  const output = await validateRecipe(options)
  if (!options.json) {
    printRecipeValidateHumanOutput(output)
    return output.success ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return output.success ? 0 : 1
}

function printJsonFailureDiagnostic(output: { success: boolean; error?: { message?: string }; logs?: string[] }): void {
  if (output.success) {
    return
  }

  const message = output.error?.message?.trim()
  if (message) {
    console.error(message)
  }

  for (const log of output.logs ?? []) {
    const trimmed = log.trim()
    if (trimmed) {
      console.error(trimmed)
    }
  }
}

class RecipeInterruptedError extends Error {
  readonly code = "recipe-interrupted"

  constructor(readonly signal: RecipeInterruptionSignal, readonly receivedAt: string) {
    super(`Recipe run interrupted by ${signal}`)
    this.name = "RecipeInterruptedError"
  }
}

class RecipeRunTimeoutError extends Error {
  readonly code = "recipe-run-timeout"
  readonly activeOperation: string
  readonly elapsedMs: number
  readonly timeoutMs: number

  constructor(activeOperation: string, elapsedMs: number, timeoutMs: number) {
    super(`Recipe run timed out after ${elapsedMs}ms while waiting for ${activeOperation}`)
    this.name = "RecipeRunTimeoutError"
    this.activeOperation = activeOperation
    this.elapsedMs = elapsedMs
    this.timeoutMs = timeoutMs
  }
}

class RecipeRuntimeCreateError extends Error {
  readonly code = "recipe-runtime-create-failed"

  constructor(message: string, readonly context: Record<string, unknown>, cause: unknown) {
    super(message, { cause })
    this.name = "RecipeRuntimeCreateError"
  }
}

class RecipePhaseError extends Error {
  readonly code = "recipe-phase-failed"

  constructor(readonly phase: RecipePhaseName, readonly phaseData: Record<string, unknown> | undefined, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`Recipe phase ${phase} failed: ${message}`, { cause })
    this.name = "RecipePhaseError"
  }
}

class RecipePhaseTracker {
  private phases: RecipePhaseEvidence[] = []

  list(): RecipePhaseEvidence[] {
    return this.phases
  }

  complete(name: RecipePhaseName, data?: Record<string, unknown>): void {
    const now = new Date().toISOString()
    this.phases.push({
      schema: "wp-codebox/recipe-phase-evidence/v1",
      name,
      status: "completed",
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      ...(data ? { data } : {}),
    })
  }

  fail(name: RecipePhaseName, error: unknown, data?: Record<string, unknown>): void {
    const now = new Date().toISOString()
    this.phases.push({
      schema: "wp-codebox/recipe-phase-evidence/v1",
      name,
      status: "failed",
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      ...(data ? { data } : {}),
      error: serializeRecipeRunError(error),
    })
  }

  async run<T>(name: RecipePhaseName, data: Record<string, unknown> | undefined, callback: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now()
    const startedAt = new Date().toISOString()
    try {
      const result = await callback()
      this.phases.push({
        schema: "wp-codebox/recipe-phase-evidence/v1",
        name,
        status: "completed",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        ...(data ? { data } : {}),
      })
      return result
    } catch (error) {
      const phaseError = error instanceof RecipePhaseError || error instanceof RecipeRunTimeoutError ? error : new RecipePhaseError(name, data, error)
      this.phases.push({
        schema: "wp-codebox/recipe-phase-evidence/v1",
        name,
        status: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        ...(data ? { data } : {}),
        error: serializeRecipeRunError(error),
      })
      throw phaseError
    }
  }
}

function createRecipeInterruptionController(): RecipeInterruptionController {
  let metadata: RecipeInterruptionMetadata | undefined
  let rejectInterrupted: ((error: RecipeInterruptedError) => void) | undefined
  let installed = false
  const signals: RecipeInterruptionSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  const handler = (signal: RecipeInterruptionSignal): void => {
    if (!metadata) {
      metadata = { signal, receivedAt: new Date().toISOString(), artifactsFinalized: false }
    }
    rejectInterrupted?.(new RecipeInterruptedError(metadata.signal, metadata.receivedAt))
  }

  const controller: RecipeInterruptionController = {
    get metadata() {
      return metadata
    },
    install() {
      if (installed) {
        return
      }
      for (const signal of signals) {
        process.on(signal, handler)
      }
      installed = true
    },
    dispose() {
      if (!installed) {
        return
      }
      for (const signal of signals) {
        process.off(signal, handler)
      }
      installed = false
    },
    async interruptible<T>(promise: Promise<T>): Promise<T> {
      if (metadata) {
        throw new RecipeInterruptedError(metadata.signal, metadata.receivedAt)
      }

      let settled = false
      try {
        return await Promise.race([
          promise.finally(() => {
            settled = true
          }),
          new Promise<T>((_resolve, reject) => {
            rejectInterrupted = (error) => {
              if (!settled) {
                reject(error)
              }
            }
          }),
        ])
      } finally {
        rejectInterrupted = undefined
      }
    },
    throwIfInterrupted() {
      if (metadata) {
        throw new RecipeInterruptedError(metadata.signal, metadata.receivedAt)
      }
    },
    propagateIfInterrupted() {
      if (!metadata) {
        return
      }
      controller.dispose()
      process.kill(process.pid, metadata.signal)
    },
  }

  return controller
}

function markRecipeArtifactsFinalized(interruption: RecipeInterruptionController | undefined, artifactsFinalized: boolean): void {
  if (interruption?.metadata) {
    interruption.metadata.artifactsFinalized = artifactsFinalized
  }
}

function interruptedRecipeOutput<T extends RecipeRunCommandOutput>(output: T, interruption: RecipeInterruptionController | undefined): T {
  if (!interruption?.metadata || output.schema !== "wp-codebox/recipe-run/v1") {
    return output
  }

  return {
    ...output,
    success: false,
    interruption: interruption.metadata,
    error: {
      name: "RecipeInterruptedError",
      message: `Recipe run interrupted by ${interruption.metadata.signal}`,
      code: "recipe-interrupted",
    },
  } as T
}

function remainingRecipeTimeoutMs(startedAtMs: number, timeoutMs: number): number {
  return Math.max(1, timeoutMs - (Date.now() - startedAtMs))
}

async function watchRecipeOperation<T>(operation: string, promise: Promise<T>, startedAtMs: number, timeoutMs: number, configuredTimeoutMs = timeoutMs): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  promise.catch(() => undefined)

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new RecipeRunTimeoutError(operation, Date.now() - startedAtMs, configuredTimeoutMs))
        }, timeoutMs)
        timeout.unref()
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

async function bestEffortTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  promise.catch(() => undefined)
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => undefined),
  ])
}

function serializeRecipeRunError(error: unknown): RunOutput["error"] {
  const serialized = serializeError(error)
  if (error instanceof RecipeRunTimeoutError) {
    return {
      ...serialized,
      activeOperation: error.activeOperation,
      elapsedMs: error.elapsedMs,
      timeoutMs: error.timeoutMs,
    }
  }

  return serialized
}

async function runRecipe(options: RecipeRunOptions, interruption?: RecipeInterruptionController): Promise<RecipeRunOutput> {
  const recipePath = resolve(options.recipePath)
  const recipeDirectory = dirname(recipePath)
  const recipe = parseWorkspaceRecipe(await readFile(recipePath, "utf8"), recipePath)
  const configuredArtifactsDirectory = options.artifactsDirectory ?? recipe.artifacts?.directory
  const runRegistry = new RuntimeRunRegistry(options.runRegistryDirectory ?? defaultRunRegistryDirectory(configuredArtifactsDirectory))
  const startedAtMs = Date.now()
  let runRecord = await runRegistry.create({
    runId: createRuntimeRunId(),
    status: "queued",
    metadata: {
      kind: "recipe-run",
      recipePath,
      artifactsDirectory: configuredArtifactsDirectory,
    },
    replay: {
      command: ["wp-codebox", "recipe-run", "--recipe", recipePath],
      recipePath,
    },
  })
  const issues = await validateWorkspaceRecipe(recipe, recipePath)
  if (issues.length > 0) {
    const failure = {
      name: "RecipeValidationError",
      message: `Recipe validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
    }
    runRecord = await runRegistry.update(runRecord.runId, {
      status: "failed",
      metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs, status: "failed", failure }) },
      error: failure,
    })
    return {
      success: false,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      executions: [],
      validation: { issues },
      run: runRecord,
      error: failure,
    }
  }

  const policy = recipePolicy(recipe)
  const secretEnv = resolveSecretEnv(recipe.inputs?.secretEnv ?? [])
  const effectivePolicy = Object.keys(secretEnv).length > 0 ? { ...policy, secrets: "connector-scoped" as const } : policy
  let workspaceMounts: PreparedWorkspaceMount[] = []
  let extraPlugins: PreparedExtraPlugin[] = []
  let stagedFiles: PreparedStagedFile[] = []
  let overlays: PreparedRuntimeOverlay[] = []
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  const executions: RecipeExecutionResult[] = []
  let artifacts: ArtifactBundle | undefined
  let startupDurationMs: number | undefined
  let cleanupEvidence: RunResourceCleanupEvidence | undefined
  const phaseTracker = new RecipePhaseTracker()
  const awaitRecipe = <T>(operation: string, promise: Promise<T>, timeoutMs = remainingRecipeTimeoutMs(startedAtMs, options.timeoutMs)): Promise<T> => {
    const guarded = watchRecipeOperation(operation, promise, startedAtMs, timeoutMs, options.timeoutMs)
    return interruption ? interruption.interruptible(guarded) : guarded
  }

  try {
    workspaceMounts = await prepareRecipeWorkspaces(recipe, recipeDirectory)
    extraPlugins = await prepareRecipeExtraPlugins(recipe, recipeDirectory)
    stagedFiles = await prepareRecipeStagedFiles(recipe, recipeDirectory)
    overlays = await prepareRecipeRuntimeOverlaysForRun(recipe, recipeDirectory)
    interruption?.throwIfInterrupted()

    runRecord = await runRegistry.update(runRecord.runId, { status: "booting" })
    const runtimeEnvironment = {
      kind: "wordpress" as const,
      name: recipe.runtime?.name ?? "wp-codebox-recipe",
      version: recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION,
      blueprint: recipeBlueprintWithBootActivePlugins(recipe.runtime?.blueprint, extraPlugins),
      assets: resolveRecipeRuntimeAssets(recipe, recipeDirectory),
    }
    const runtimeCreateSpec = {
      backend: recipe.runtime?.backend ?? "wordpress-playground",
      environment: runtimeEnvironment,
      policy: effectivePolicy,
      secretEnv,
      artifactsDirectory: configuredArtifactsDirectory,
      metadata: {
        ...runtimeMetadata(configuredArtifactsDirectory, recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION),
        run: { runId: runRecord.runId, registryDirectory: runRegistry.directory },
        ...recipeRunMetadata(recipe, recipePath, workspaceMounts, extraPlugins, stagedFiles, overlays, options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
    }
    try {
      const startupStartedAtMs = Date.now()
      runtime = await phaseTracker.run("runtime_startup", {
        operation: "runtime.create",
        backend: runtimeCreateSpec.backend,
        runtime: runtimeEnvironment,
      }, async () => await awaitRecipe("runtime.create", createRuntime(
        runtimeCreateSpec,
        createPlaygroundRuntimeBackend(),
      )))
      startupDurationMs = Date.now() - startupStartedAtMs
    } catch (error) {
      const blueprintSteps = recipeBlueprintSteps(runtimeEnvironment.blueprint)
      if (blueprintSteps.length > 0) {
        phaseTracker.fail("run_blueprint_steps", error, {
          stepCount: blueprintSteps.length,
          appliedDuring: "runtime.create",
        })
      }
      throw new RecipeRuntimeCreateError("Runtime creation failed before recipe workflow execution.", {
        operation: "runtime.create",
        backend: runtimeCreateSpec.backend,
        environment: runtimeEnvironment,
        extraPlugins: extraPlugins.map(recipeRunExtraPlugin),
        workspaces: workspaceMounts.map((workspace) => ({
          source: workspace.source,
          target: workspace.target,
          mode: workspace.mode,
          metadata: workspace.metadata,
        })),
        stagedFiles: stagedFiles.map(recipeRunStagedFile),
        overlays: overlays.map((overlay) => ({
          source: overlay.source,
          target: overlay.target,
          type: overlay.type,
          mode: overlay.mode,
          metadata: overlay.metadata,
        })),
      }, error)
    }
    if (!runtime) {
      throw new Error("Runtime creation did not return a runtime")
    }
    runRecord = await runRegistry.update(runRecord.runId, { status: "running", runtime: await runtime.info() })
    const blueprintSteps = recipeBlueprintSteps(runtimeEnvironment.blueprint)
    phaseTracker.complete("run_blueprint_steps", {
      stepCount: blueprintSteps.length,
      appliedDuring: "runtime.create",
    })
    interruption?.throwIfInterrupted()

    for (const [index, mount] of (recipe.runtime?.stack?.mounts ?? []).entries()) {
      const source = resolve(recipeDirectory, mount.source)
      await awaitRecipe(`runtime.stack.mount[${index}]`, runtime.mount({
        type: await recipeMountType(source, mount.type),
        source,
        target: mount.target,
        mode: mount.mode ?? "readonly",
        metadata: {
          kind: "runtime-stack-mount",
          index,
          ...(mount.metadata ?? {}),
        },
      }))
      interruption?.throwIfInterrupted()
    }

    for (const overlay of overlays) {
      await awaitRecipe(`runtime.overlay.mount:${overlay.target}`, runtime.mount({
        type: overlay.type,
        source: overlay.source,
        target: overlay.target,
        mode: overlay.mode,
        metadata: overlay.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    for (const workspace of workspaceMounts) {
      await awaitRecipe(`workspace.mount:${workspace.target}`, runtime.mount({
        type: "directory",
        source: workspace.source,
        target: workspace.target,
        mode: workspace.mode,
        metadata: workspace.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    await phaseTracker.run("mount_plugins", phasePluginMountData(extraPlugins), async () => {
      for (const plugin of extraPlugins) {
        await awaitRecipe(`extra-plugin.mount:${plugin.slug}`, runtime!.mount({
          type: "directory",
          source: plugin.source,
          target: plugin.target,
          mode: "readonly",
          metadata: {
            kind: "extra-plugin",
            slug: plugin.slug,
            source: plugin.provenance,
          },
        }))
        interruption?.throwIfInterrupted()
      }
    })

    for (const mount of recipe.inputs?.mounts ?? []) {
      const source = resolve(recipeDirectory, mount.source)
      await awaitRecipe(`input.mount:${mount.target}`, runtime.mount({
        type: await recipeMountType(source, mount.type),
        source,
        target: mount.target,
        mode: mount.mode ?? "readwrite",
        metadata: mount.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    for (const stagedFile of stagedFiles) {
      await awaitRecipe(`staged-file.mount:${stagedFile.target}`, runtime.mount({
        type: stagedFile.type,
        source: stagedFile.source,
        target: stagedFile.target,
        mode: "readwrite",
        metadata: stagedFile.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    const muPluginInstallCode = installMuPluginsCode(extraPlugins)
    if (muPluginInstallCode) {
      executions.push(withRecipeExecutionPhase(await runtime.execute({ command: "wordpress.run-php", args: [`code=${muPluginInstallCode}`] }), "setup", -2))
    }

    const activatedPlugins = extraPlugins.filter((plugin) => plugin.loadAs === "plugin" && plugin.activate !== false)
    if (activatedPlugins.length > 0) {
      const activePluginsAfterActivation = await phaseTracker.run("activate_plugins", phasePluginActivationData(activatedPlugins), async () => {
        for (const plugin of activatedPlugins) {
          executions.push(withRecipeExecutionPhase(await runtime!.execute({ command: "wordpress.run-php", args: [`code=${activateExtraPluginCode(plugin.pluginFile)}`] }), "setup", -1, `extra-plugin.activate:${plugin.pluginFile}`))
          interruption?.throwIfInterrupted()
        }
        return await activePlugins(runtime!)
      })
      const activationPhase = [...phaseTracker.list()].reverse().find((phase: RecipePhaseEvidence) => phase.name === "activate_plugins")
      if (activationPhase?.data) {
        activationPhase.data.activePlugins = activePluginsAfterActivation
      }
    }

    for (const [index, setupStep] of (recipe.inputs?.pluginRuntime?.setup ?? []).entries()) {
      executions.push(await awaitRecipe(`plugin-runtime.setup[${index}]`, executeRecipePluginRuntimeStep(runtime, setupStep, recipeDirectory, "setup", index)))
      interruption?.throwIfInterrupted()
    }

    for (const [index, probe] of (recipe.inputs?.pluginRuntime?.healthProbes ?? []).entries()) {
      executions.push(await awaitRecipe(`plugin-runtime.health:${probe.name}`, executeRecipePluginRuntimeHealthProbe(runtime, probe, recipeDirectory, index)))
      interruption?.throwIfInterrupted()
    }

    const siteSeeds = await awaitRecipe("site-seeds.import", importRecipeSiteSeeds(recipe, recipeDirectory, runtime, executions))
    interruption?.throwIfInterrupted()

    const sandboxWorkspace = sandboxWorkspaceContract(workspaceMounts, recipe.inputs?.mounts ?? [])
    const workflowSteps = recipeWorkflowSteps(recipe)
    await phaseTracker.run("run_workloads", phaseWorkflowData(workflowSteps), async () => {
      for (const workflowStep of workflowSteps) {
        executions.push(await awaitRecipe(`workflow.${workflowStep.phase}[${workflowStep.index}]:${workflowStep.step.command}`, executeRecipeWorkflowStep(runtime!, workflowStep, recipeDirectory, sandboxWorkspace)))
        interruption?.throwIfInterrupted()
      }
    })

    let evidence = await phaseTracker.run("collect_artifacts", { includeLogs: true, includeObservations: true }, async () => {
      await awaitRecipe("runtime.observe:runtime-info", runtime!.observe({ type: "runtime-info" }))
      await awaitRecipe("runtime.observe:mounts", runtime!.observe({ type: "mounts" }))
      runRecord = await runRegistry.update(runRecord.runId, { status: "collecting_artifacts", runtime: await runtime!.info() })
      artifacts = await awaitRecipe("runtime.collect-artifacts", runtime!.collectArtifacts({ includeLogs: true, includeObservations: true }))
      const recipeEvidence = await finalizeRecipeArtifactEvidence(artifacts, recipe, workspaceMounts, stagedFiles, effectivePolicy, secretEnv)
      const agentEvidence = await finalizeAgentSandboxEvidence(artifacts, executions)
      Object.assign(recipeEvidence, agentEvidence)
      markRecipeArtifactsFinalized(interruption, true)
      return recipeEvidence
    })
    if (!artifacts) {
      throw new Error("Recipe artifact collection did not return an artifact bundle")
    }
    const strictFailure = recipeArtifactEvidenceFailure(evidence)
    const agentFailure = recipeAgentResultFailure(evidence.agentResult)
    const successfulRecipe = !strictFailure && !agentFailure
    if (successfulRecipe && options.previewHoldSeconds) {
      artifacts = await awaitRecipe("runtime.collect-artifacts.preview-hold", runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds }))
      evidence = await finalizeRecipeArtifactEvidence(artifacts, recipe, workspaceMounts, stagedFiles, effectivePolicy, secretEnv)
      const previewAgentEvidence = await finalizeAgentSandboxEvidence(artifacts, executions)
      Object.assign(evidence, previewAgentEvidence)
    }
    const runtimeInfo = successfulRecipe && options.previewHoldSeconds ? await runtime.info() : undefined
    const activeRuntime = runtime
    cleanupEvidence = await runRecipeCleanup(runRegistry, runRecord, async () => {
      await awaitRecipe("runtime.release", releaseRuntime(activeRuntime, successfulRecipe ? options.previewHoldSeconds : 0))
      await cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles, overlays)
    })
    runRecord = await runRegistry.read(runRecord.runId)
    interruption?.throwIfInterrupted()

    const benchmarkManifestFiles = await artifactManifestFilesByPath(artifacts)
    const benchResultsList = executions
      .filter((execution) => execution.command === "wordpress.bench" && execution.exitCode === 0)
      .map((execution) => parseBenchResults(execution.stdout, benchmarkManifestFiles))
    if (benchResultsList.length > 0) {
      await writeBenchmarkArtifactEvidence(artifacts, benchResultsList)
    }

    if (strictFailure || agentFailure) {
      runRecord = await runRegistry.update(runRecord.runId, {
        status: "failed",
        runtime: runtimeInfo ?? await runtime.info(),
        preview: artifacts.preview,
        artifactRefs: artifactBundleRunRef(artifacts),
        metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs, status: "failed", startupDurationMs, cleanup: cleanupEvidence, artifacts, failure: strictFailure ?? agentFailure, phaseEvidence: phaseTracker.list() }) },
        error: strictFailure ?? agentFailure,
      })
      return {
        success: false,
        schema: "wp-codebox/recipe-run/v1",
        recipePath,
        runtime: runtimeInfo ?? await runtime.info(),
        executions,
        stagedFiles: stagedFiles.map(recipeRunStagedFile),
        siteSeeds,
        phaseEvidence: phaseTracker.list(),
        ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
        ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
        ...(evidence.agentResult ? { agentResult: recipeAgentResultOutput(evidence.agentResult) } : {}),
        ...(evidence.agentTaskResult ? { agentTaskResult: recipeAgentTaskResultOutput(evidence.agentTaskResult) } : {}),
        ...(evidence.completionOutcome ? { completionOutcome: recipeCompletionOutcomeOutput(evidence.completionOutcome) } : {}),
        artifacts,
        run: runRecord,
        error: strictFailure ?? agentFailure,
      }
    }

    runRecord = await runRegistry.update(runRecord.runId, {
      status: "succeeded",
      runtime: runtimeInfo ?? await runtime.info(),
      preview: artifacts.preview,
      artifactRefs: artifactBundleRunRef(artifacts),
      metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs, status: "succeeded", startupDurationMs, cleanup: cleanupEvidence, artifacts, phaseEvidence: phaseTracker.list() }) },
    })
    return {
      success: true,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      runtime: runtimeInfo ?? await runtime.info(),
      executions,
      stagedFiles: stagedFiles.map(recipeRunStagedFile),
      siteSeeds,
      phaseEvidence: phaseTracker.list(),
      ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
      ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
      ...(evidence.agentResult ? { agentResult: recipeAgentResultOutput(evidence.agentResult) } : {}),
      ...(evidence.agentTaskResult ? { agentTaskResult: recipeAgentTaskResultOutput(evidence.agentTaskResult) } : {}),
      ...(evidence.completionOutcome ? { completionOutcome: recipeCompletionOutcomeOutput(evidence.completionOutcome) } : {}),
      artifacts,
      run: runRecord,
    }
  } catch (error) {
    if (runtime) {
      const activeRuntime = runtime
      artifacts = await phaseTracker.run("collect_artifacts", { failureRecovery: true, includeLogs: true, includeObservations: true }, async () => await collectAndFinalizeFailedRecipeArtifacts({
        runtime: activeRuntime,
        existingArtifacts: artifacts,
        recipe,
        workspaceMounts,
        stagedFiles,
        policy: effectivePolicy,
        secretEnv,
        executions,
        interruption,
      }))

      if (error instanceof RecipeRunTimeoutError) {
        void activeRuntime.destroy().catch(() => undefined)
      } else {
        await runRecipeCleanup(runRegistry, runRecord, async () => {
          try {
            await bestEffortTimeout(activeRuntime.destroy(), 2_000)
          } catch {
            // Preserve the original failure as the CLI result.
          }
        })
        runRecord = await runRegistry.read(runRecord.runId)
      }
    }

    cleanupEvidence = await runRecipeCleanup(runRegistry, runRecord, () => cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles, overlays))
    runRecord = await runRegistry.read(runRecord.runId)
    const serializedError = serializeRecipeRunError(error)
    runRecord = await runRegistry.update(runRecord.runId, {
      status: recipeRunFailureStatus(error, interruption),
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(artifacts ? { preview: artifacts.preview, artifactRefs: artifactBundleRunRef(artifacts) } : {}),
      metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs, status: recipeRunFailureStatus(error, interruption), startupDurationMs, cleanup: cleanupEvidence, artifacts, failure: serializedError, phaseEvidence: phaseTracker.list() }) },
      error: serializedError,
    })

    return {
      success: false,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      ...(runtime ? { runtime: await runtime.info() } : {}),
      executions,
      phaseEvidence: phaseTracker.list(),
      diagnostics: recipeRuntimeDiagnostics(recipe, executions, error),
      ...(artifacts ? { artifacts } : {}),
      run: runRecord,
      ...(interruption?.metadata ? { interruption: interruption.metadata } : {}),
      error: serializedError,
    }
  }
}

function resolveRecipeRuntimeAssets(recipe: WorkspaceRecipe, recipeDirectory: string): RuntimeAssetSpec | undefined {
  const assets = recipe.runtime?.assets
  if (!assets?.wordpressZip) {
    return undefined
  }

  return {
    ...assets,
    wordpressZip: isUrl(assets.wordpressZip) ? assets.wordpressZip : resolve(recipeDirectory, assets.wordpressZip),
  }
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

interface RunResourceCleanupEvidence {
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

async function runRecipeCleanup(runRegistry: RuntimeRunRegistry, runRecord: RuntimeRunRecord, cleanup: () => Promise<void>): Promise<RunResourceCleanupEvidence> {
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

function recipeRunFailureStatus(error: unknown, interruption?: RecipeInterruptionController): RuntimeRunRecord["status"] {
  if (interruption?.metadata) {
    return "cancelled"
  }

  if (error instanceof RecipeRunTimeoutError) {
    return "timed_out"
  }

  return "failed"
}

async function runResourceEvidence(options: RunResourceEvidenceOptions): Promise<Record<string, unknown>> {
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
    case "run_workloads":
      return "workload"
    case "collect_artifacts":
      return "artifact_collection"
    default:
      return "execution"
  }
}

async function prepareRecipeRuntimeOverlaysForRun(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedRuntimeOverlay[]> {
  try {
    return await prepareRecipeRuntimeOverlays(recipe, recipeDirectory)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe runtime overlay preparation failed: ${message}`, { cause: error })
  }
}

async function validateRecipe(options: RecipeValidateOptions): Promise<RecipeValidateOutput> {
  const recipePath = resolve(options.recipePath)
  try {
    const raw = await readFile(recipePath, "utf8")
    const recipe = parseWorkspaceRecipe(raw, recipePath)
    const issues = await validateWorkspaceRecipe(recipe, recipePath)

    return {
      success: issues.length === 0,
      schema: "wp-codebox/recipe-validation/v1",
      recipePath,
      valid: issues.length === 0,
      issues,
      summary: {
        steps: recipeWorkflowSteps(recipe).length,
        mounts: recipe.inputs?.mounts?.length ?? 0,
        workspaces: recipe.inputs?.workspaces?.length ?? 0,
        extraPlugins: recipeExtraPlugins(recipe).length,
        stagedFiles: recipe.inputs?.stagedFiles?.length ?? 0,
      },
    }
  } catch (error) {
    return {
      success: false,
      schema: "wp-codebox/recipe-validation/v1",
      recipePath,
      valid: false,
      issues: [
        {
          code: "invalid-recipe",
          path: "$",
          message: error instanceof SyntaxError ? `Recipe JSON is invalid: ${error.message}` : error instanceof Error ? error.message : String(error),
        },
      ],
      error: serializeError(error),
    }
  }
}

function parseBenchResults(raw: string, manifestFiles: Map<string, ArtifactManifestFile>): BenchResults {
  const parsed = JSON.parse(raw) as unknown
  if (!validateBenchResultsSchema(parsed)) {
    throw new Error(`Bench command did not emit a wp-codebox/bench-results/v1 envelope: ${benchResultsAjv.errorsText(validateBenchResultsSchema.errors)}`)
  }

  const results = parsed as BenchResults
  return {
    ...results,
    scenarios: results.scenarios.map((scenario) => enrichBenchScenarioArtifactRefs(scenario, manifestFiles)),
  }
}

function enrichBenchScenarioArtifactRefs(scenario: BenchResults["scenarios"][number], manifestFiles: Map<string, ArtifactManifestFile>): BenchScenarioWithArtifactRefs {
  const artifactRefs = [
    ...scenarioArtifactRefs(scenario.artifacts, manifestFiles, "scenario-artifact"),
    ...sampleArtifactRefs((scenario as BenchScenarioWithArtifactRefs).samples, manifestFiles),
    ...metricArtifactRefs(scenario.metrics, manifestFiles),
    ...browserArtifactRefs(scenario.metrics, manifestFiles),
  ]
  const existingRefs = Array.isArray((scenario as BenchScenarioWithArtifactRefs).artifactRefs) ? (scenario as BenchScenarioWithArtifactRefs).artifactRefs ?? [] : []
  const dedupedRefs = dedupeBenchmarkArtifactRefs([...existingRefs, ...artifactRefs])

  return stripUndefined({
    ...scenario,
    ...(dedupedRefs.length > 0 ? { artifactRefs: dedupedRefs } : {}),
  }) as BenchScenarioWithArtifactRefs
}

async function writeBenchmarkArtifactEvidence(artifacts: ArtifactBundle, benchResultsList: BenchResults[]): Promise<void> {
  const scenarios = benchResultsList.flatMap((result) => result.scenarios.map((scenario) => ({
    componentId: result.component_id,
    scenarioId: String(scenario.id ?? ""),
    source: typeof scenario.source === "string" ? scenario.source : undefined,
    artifactRefs: (scenario as BenchScenarioWithArtifactRefs).artifactRefs ?? [],
  }))).filter((scenario) => scenario.scenarioId.length > 0 || scenario.artifactRefs.length > 0)
  const output: BenchmarkArtifactOutput = {
    schema: "wp-codebox/benchmark-artifacts/v1",
    artifactBundle: {
      id: artifacts.id,
      directory: artifacts.directory,
      contentDigest: artifacts.contentDigest,
    },
    results: benchResultsList,
    scenarios,
  }
  const relativePath = "files/bench-results.json"
  await writeFile(join(artifacts.directory, relativePath), `${JSON.stringify(output, null, 2)}\n`)
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
  upsertArtifactManifestFiles(manifest, [artifactManifestFile(relativePath, "benchmark-results", "application/json")])
  await refreshArtifactManifestFileSha256s(artifacts.directory, manifest)
  await writeFile(artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function artifactManifestFilesByPath(artifacts: ArtifactBundle): Promise<Map<string, ArtifactManifestFile>> {
  try {
    const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
    return new Map((manifest.files ?? []).map((file) => [file.path, file]))
  } catch {
    return new Map()
  }
}

function scenarioArtifactRefs(input: unknown, manifestFiles: Map<string, ArtifactManifestFile>, source: BenchmarkArtifactRef["source"], sampleIndex?: number): BenchmarkArtifactRef[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return []
  }

  return Object.entries(input).flatMap(([name, value]) => artifactValueRefs(name, value, manifestFiles, source, sampleIndex))
}

function sampleArtifactRefs(samples: BenchScenarioWithArtifactRefs["samples"], manifestFiles: Map<string, ArtifactManifestFile>): BenchmarkArtifactRef[] {
  if (!Array.isArray(samples)) {
    return []
  }

  return samples.flatMap((sample, sampleIndex) => scenarioArtifactRefs(sample.artifacts, manifestFiles, "sample-artifact", sampleIndex))
}

function artifactValueRefs(name: string, value: unknown, manifestFiles: Map<string, ArtifactManifestFile>, source: BenchmarkArtifactRef["source"], sampleIndex?: number): BenchmarkArtifactRef[] {
  if (typeof value === "string") {
    return [benchmarkArtifactRef(value, { name, source, sampleIndex }, manifestFiles)]
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return []
  }
  const record = value as Record<string, unknown>
  if (typeof record.path === "string") {
    return [benchmarkArtifactRef(record.path, {
      name,
      source,
      sampleIndex,
      kind: typeof record.kind === "string" ? record.kind : undefined,
      contentType: typeof record.contentType === "string" ? record.contentType : typeof record.mime === "string" ? record.mime : undefined,
    }, manifestFiles)]
  }

  return Object.entries(record).flatMap(([childName, childValue]) => artifactValueRefs(`${name}.${childName}`, childValue, manifestFiles, source, sampleIndex))
}

function metricArtifactRefs(metrics: BenchResults["scenarios"][number]["metrics"], manifestFiles: Map<string, ArtifactManifestFile>): BenchmarkArtifactRef[] {
  if (!metrics || typeof metrics !== "object") {
    return []
  }

  return Object.keys(metrics).sort().map((metric) => benchmarkArtifactRef("files/bench-results.json", { source: "metric-source", metric, kind: "benchmark-results", contentType: "application/json" }, manifestFiles))
}

function browserArtifactRefs(metrics: BenchResults["scenarios"][number]["metrics"], manifestFiles: Map<string, ArtifactManifestFile>): BenchmarkArtifactRef[] {
  if (!metrics || !Object.keys(metrics).some((metric) => metric.startsWith("browser_"))) {
    return []
  }

  return [...manifestFiles.values()]
    .filter((file) => file.path.startsWith("files/browser/"))
    .map((file) => benchmarkArtifactRef(file.path, { source: "browser-artifact", kind: file.kind, contentType: file.contentType }, manifestFiles))
}

function benchmarkArtifactRef(path: string, options: Omit<Partial<BenchmarkArtifactRef>, "path"> & { source: BenchmarkArtifactRef["source"] }, manifestFiles: Map<string, ArtifactManifestFile>): BenchmarkArtifactRef {
  const manifestFile = manifestFiles.get(path)
  return stripUndefined({
    path,
    kind: options.kind ?? manifestFile?.kind ?? "artifact",
    contentType: options.contentType ?? manifestFile?.contentType,
    sha256: manifestFile?.sha256.value,
    source: options.source,
    name: options.name,
    metric: options.metric,
    sampleIndex: options.sampleIndex,
  }) as BenchmarkArtifactRef
}

function dedupeBenchmarkArtifactRefs(refs: BenchmarkArtifactRef[]): BenchmarkArtifactRef[] {
  const seen = new Set<string>()
  const deduped: BenchmarkArtifactRef[] = []
  for (const ref of refs) {
    const key = `${ref.source}:${ref.path}:${ref.name ?? ""}:${ref.metric ?? ""}:${ref.sampleIndex ?? ""}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(ref)
  }

  return deduped
}

function resolveSecretEnv(names: string[]): Record<string, string> {
  const secretEnv: Record<string, string> = {}
  for (const name of names) {
    const normalized = name.trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
      throw new Error(`Invalid --secret-env name: ${name}`)
    }

    const value = process.env[normalized]
    if (value) {
      secretEnv[normalized] = value
    }
  }

  return secretEnv
}

function parseRecipeRunOptions(args: string[]): RecipeRunOptions {
  const options: Partial<RecipeRunOptions> = { json: false, dryRun: false, timeoutMs: DEFAULT_RECIPE_RUN_TIMEOUT_MS }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    if (arg === "--dry-run") {
      options.dryRun = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--recipe":
        options.recipePath = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--run-registry":
        options.runRegistryDirectory = value
        break
      case "--preview-hold":
        options.previewHoldSeconds = parsePreviewHoldSeconds(value)
        break
      case "--preview-public-url":
        options.previewPublicUrl = parsePreviewPublicUrl(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      case "--timeout":
        options.timeoutMs = parseRecipeRunTimeoutMs(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.recipePath) {
    throw new Error("Missing required option: --recipe")
  }

  return options as RecipeRunOptions
}

function parseRecipeRunTimeoutMs(value: unknown): number {
  const raw = String(value).trim()
  const match = raw.match(/^(\d+)(ms|s|m)?$/)
  if (!match) {
    throw new Error("--timeout must be a positive duration such as 5000ms, 30s, or 25m")
  }

  const amount = Number.parseInt(match[1], 10)
  const unit = match[2] ?? "ms"
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1000 : 1
  const timeoutMs = amount * multiplier
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout must be a positive duration")
  }

  return timeoutMs
}

function parseRecipeValidateOptions(args: string[]): RecipeValidateOptions {
  const options: Partial<RecipeValidateOptions> = { json: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--recipe":
        options.recipePath = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.recipePath) {
    throw new Error("Missing required option: --recipe")
  }

  return options as RecipeValidateOptions
}

function withRecipeExecutionPhase(execution: ExecutionResult, recipePhase: RecipeWorkflowPhase, recipeStepIndex: number, recipeCommand?: string): RecipeExecutionResult {
  return {
    ...execution,
    recipePhase,
    recipeStepIndex,
    recipeCommand,
  }
}

async function executeRecipeWorkflowStep(runtime: Runtime, workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], recipeDirectory: string, sandboxWorkspace?: ReturnType<typeof sandboxWorkspaceContract>): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(workflowStep.step, recipeDirectory, sandboxWorkspace))
    return withRecipeExecutionPhase(execution, workflowStep.phase, workflowStep.index, workflowStep.step.command)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe workflow ${workflowStep.phase}[${workflowStep.index}] failed: ${message}`, { cause: error })
  }
}

async function executeRecipePluginRuntimeStep(runtime: Runtime, step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string, phase: "setup", index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(step, recipeDirectory))
    return withRecipeExecutionPhase(execution, phase, pluginRuntimeSetupStepIndex(index), `plugin-runtime.setup:${index}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe plugin runtime setup[${index}] failed: ${message}`, { cause: error })
  }
}

async function executeRecipePluginRuntimeHealthProbe(runtime: Runtime, probe: WorkspaceRecipePluginRuntimeHealthProbe, recipeDirectory: string, index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(pluginRuntimeHealthProbeStep(probe), recipeDirectory))
    return withRecipeExecutionPhase(execution, "setup", pluginRuntimeHealthProbeStepIndex(index), `plugin-runtime.health:${probe.name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe plugin runtime health probe "${probe.name}" failed: ${message}`, { cause: error })
  }
}

function activateExtraPluginCode(pluginFile: string): string {
  return `$plugin_file = ${JSON.stringify(pluginFile)};
require_once ABSPATH . 'wp-admin/includes/plugin.php';
if (is_plugin_active($plugin_file)) {
    deactivate_plugins($plugin_file, true, false);
}
$result = activate_plugin($plugin_file, '', false, false);
if (is_wp_error($result)) {
    throw new RuntimeException('Failed to activate extra plugin ' . $plugin_file . ': ' . $result->get_error_message());
}
do_action('wp_codebox_runtime_plugin_activated', $plugin_file);
echo wp_json_encode(array('activated' => $plugin_file));`
}

async function activePlugins(runtime: Runtime): Promise<string[]> {
  const execution = await runtime.execute({
    command: "wordpress.run-php",
    args: ["code=echo wp_json_encode(array_values((array) get_option('active_plugins', array())));"],
  })
  const parsed = JSON.parse(execution.stdout.trim() || "[]") as unknown
  return Array.isArray(parsed) ? parsed.filter((plugin): plugin is string => typeof plugin === "string") : []
}

function phasePluginMountData(extraPlugins: PreparedExtraPlugin[]): Record<string, unknown> {
  return {
    count: extraPlugins.length,
    plugins: extraPlugins.map((plugin) => ({ slug: plugin.slug, pluginFile: plugin.pluginFile, target: plugin.target, loadAs: plugin.loadAs })),
  }
}

function phasePluginActivationData(activatedPlugins: PreparedExtraPlugin[]): Record<string, unknown> {
  return {
    count: activatedPlugins.length,
    plugins: activatedPlugins.map((plugin) => ({ slug: plugin.slug, pluginFile: plugin.pluginFile })),
  }
}

function phaseWorkflowData(workflowSteps: ReturnType<typeof recipeWorkflowSteps>): Record<string, unknown> {
  return {
    count: workflowSteps.length,
    steps: workflowSteps.map((workflowStep) => ({ phase: workflowStep.phase, index: workflowStep.index, command: workflowStep.step.command })),
  }
}

function recipeBlueprintSteps(blueprint: unknown): unknown[] {
  if (!blueprint || typeof blueprint !== "object" || !("steps" in blueprint) || !Array.isArray(blueprint.steps)) {
    return []
  }

  return blueprint.steps
}

function recipeRuntimeDiagnostics(recipe: WorkspaceRecipe, executions: RecipeExecutionResult[], error: unknown): RecipeRuntimeDiagnostic[] | undefined {
  const diagnostics: RecipeRuntimeDiagnostic[] = executions
    .map((execution, executionIndex) => ({ execution, executionIndex }))
    .filter(({ execution }) => (execution.recipeCommand?.startsWith("plugin-runtime.") || execution.recipeCommand?.startsWith("extra-plugin.activate:")) && execution.exitCode !== 0)
    .map(({ execution, executionIndex }) => ({
      schema: execution.recipeCommand?.startsWith("extra-plugin.activate:") ? "wp-codebox/recipe-phase-diagnostic/v1" as const : "wp-codebox/plugin-runtime-diagnostic/v1" as const,
      severity: "error" as const,
      phase: execution.recipeCommand?.startsWith("extra-plugin.activate:") ? "activate_plugins" as const : execution.recipeCommand?.startsWith("plugin-runtime.health:") ? "health-probe" as const : "setup" as const,
      ...(execution.recipeCommand?.startsWith("extra-plugin.activate:") ? { pluginFile: execution.recipeCommand.slice("extra-plugin.activate:".length) } : { name: execution.recipeCommand?.split(":").slice(1).join(":") }),
      command: execution.command,
      exitCode: execution.exitCode,
      message: execution.stderr || execution.stdout || `Plugin runtime command failed with exit code ${execution.exitCode}`,
      executionIndex,
    } as RecipeRuntimeDiagnostic))

  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RecipePhaseError && diagnostics.length === 0) {
    diagnostics.push({
      schema: "wp-codebox/recipe-phase-diagnostic/v1",
      severity: "error",
      phase: error.phase,
      ...(error.phase === "activate_plugins" ? { pluginFile: pluginFileFromActivationFailure(message, error.phaseData) } : {}),
      message,
    })
  }

  if ((recipe.inputs?.pluginRuntime || recipe.runtime?.overlays || message.includes("plugin runtime") || message.includes("runtime overlay")) && diagnostics.length === 0) {
    diagnostics.push({
      schema: "wp-codebox/plugin-runtime-diagnostic/v1",
      severity: "error",
      phase: message.includes("runtime overlay") ? "overlay-preparation" : message.includes("health probe") ? "health-probe" : message.includes("setup") ? "setup" : "runtime",
      message,
    })
  }

  return diagnostics.length > 0 ? diagnostics : undefined
}

function pluginFileFromActivationFailure(message: string, phaseData: Record<string, unknown> | undefined): string | undefined {
  const match = message.match(/Failed to activate extra plugin\s+([^:]+):/)
  if (match) {
    return match[1]
  }

  const plugins = phaseData?.plugins
  if (Array.isArray(plugins) && plugins.length === 1) {
    const plugin = plugins[0]
    return plugin && typeof plugin === "object" && "pluginFile" in plugin && typeof plugin.pluginFile === "string" ? plugin.pluginFile : undefined
  }

  return undefined
}

function recipeWorkflowMetadata(recipe: WorkspaceRecipe): { before?: Array<{ command: string; args: string[] }>; steps: Array<{ command: string; args: string[] }>; after?: Array<{ command: string; args: string[] }> } {
  return {
    ...(recipe.workflow.before ? { before: recipe.workflow.before.map(recipeStepMetadata) } : {}),
    steps: recipe.workflow.steps.map(recipeStepMetadata),
    ...(recipe.workflow.after ? { after: recipe.workflow.after.map(recipeStepMetadata) } : {}),
  }
}

function recipeStepMetadata(step: WorkspaceRecipe["workflow"]["steps"][number]): { command: string; args: string[] } {
  return { command: step.command, args: step.args ?? [] }
}

function recipeRunMetadata(recipe: WorkspaceRecipe, recipePath: string, workspaceMounts: PreparedWorkspaceMount[], extraPlugins: PreparedExtraPlugin[], stagedFiles: PreparedStagedFile[], overlays: PreparedRuntimeOverlay[], previewPublicUrl: string | undefined, previewPort: number | undefined, previewBind: string | undefined): Record<string, unknown> {
  const extraPluginMetadata = extraPlugins.map((plugin) => ({
    source: plugin.source,
    slug: plugin.slug,
    target: plugin.target,
    pluginFile: plugin.pluginFile,
    activate: plugin.activate,
    loadAs: plugin.loadAs,
    provenance: plugin.provenance,
  }))
  const siteSeedProvenance = recipeDryRunSiteSeeds(recipe, dirname(recipePath))
  const stagedFileProvenance = stagedFiles.map(recipeRunStagedFile)
  const workflow = recipeWorkflowMetadata(recipe)

  return {
    recipe: {
      path: recipePath,
      schema: recipe.schema,
      runtime: recipe.runtime ?? {},
      artifacts: recipe.artifacts ?? {},
      workflow,
      inputs: {
        workspaces: recipe.inputs?.workspaces ?? [],
        mounts: recipe.inputs?.mounts ?? [],
        extra_plugins: extraPluginMetadata,
        pluginRuntime: recipe.inputs?.pluginRuntime ?? {},
        siteSeeds: recipe.inputs?.siteSeeds ?? [],
        siteSeedProvenance,
        stagedFiles: recipe.inputs?.stagedFiles ?? [],
        stagedFileProvenance,
        secretEnv: recipe.inputs?.secretEnv ?? [],
        inherit: recipe.inputs?.inherit ?? {},
        inheritance: recipe.inputs?.inheritance ?? {},
      },
    },
    workspace: sandboxWorkspaceContract(workspaceMounts, recipe.inputs?.mounts ?? []),
    task: {
      kind: "recipe-run",
      recipePath,
      previewPublicUrl,
      previewPort,
      previewBind,
      workflow,
      inputs: {
        workspaces: recipe.inputs?.workspaces ?? [],
        mounts: recipe.inputs?.mounts ?? [],
        extra_plugins: extraPluginMetadata,
        pluginRuntime: recipe.inputs?.pluginRuntime ?? {},
        siteSeeds: recipe.inputs?.siteSeeds ?? [],
        siteSeedProvenance,
        stagedFiles: recipe.inputs?.stagedFiles ?? [],
        stagedFileProvenance,
        secretEnv: recipe.inputs?.secretEnv ?? [],
        inherit: recipe.inputs?.inherit ?? {},
        inheritance: recipe.inputs?.inheritance ?? {},
      },
    },
    preparedWorkspaces: workspaceMounts.map((workspace) => ({
      target: workspace.target,
      mode: workspace.mode,
      metadata: workspace.metadata,
    })),
    preparedStagedFiles: stagedFiles.map((stagedFile) => ({
      sourceRef: stagedFile.sourceRef,
      target: stagedFile.target,
      type: stagedFile.type,
      provenance: stagedFile.provenance,
      metadata: stagedFile.metadata,
    })),
    preparedRuntimeOverlays: overlays.map((overlay) => ({
      target: overlay.target,
      type: overlay.type,
      mode: overlay.mode,
      metadata: overlay.metadata,
    })),
  }
}

function recipeRunStagedFile(stagedFile: PreparedStagedFile): RecipeRunStagedFile {
  const index = typeof stagedFile.metadata.index === "number" ? stagedFile.metadata.index : 0
  return {
    index,
    source: stagedFile.originalSource,
    sourceRef: stagedFile.sourceRef,
    target: stagedFile.target,
    type: stagedFile.type,
    provenance: stagedFile.provenance,
    action: "staged",
  }
}

function recipeRunExtraPlugin(plugin: PreparedExtraPlugin): Record<string, unknown> {
  return {
    source: plugin.source,
    slug: plugin.slug,
    target: plugin.target,
    pluginFile: plugin.pluginFile,
    activate: plugin.activate,
    loadAs: plugin.loadAs,
    provenance: plugin.provenance,
  }
}

async function importRecipeSiteSeeds(recipe: WorkspaceRecipe, recipeDirectory: string, runtime: Runtime, executions: RecipeExecutionResult[]): Promise<RecipeRunSiteSeed[]> {
  const results: RecipeRunSiteSeed[] = []

  for (const [index, siteSeed] of (recipe.inputs?.siteSeeds ?? []).entries()) {
    const base = recipeSiteSeedRunBase(siteSeed, recipeDirectory, index)
    if (siteSeed.type !== "fixture") {
      results.push({
        ...base,
        action: "skipped",
        reason: "parent-site export is not implemented in this first executable site seed slice",
      })
      continue
    }

    const format = siteSeed.format ?? "json"
    const source = resolve(recipeDirectory, siteSeed.source ?? "")
    if (format === "json") {
      const rawSeed = JSON.parse(await readFile(source, "utf8"))
      const bounded = boundedFixtureSeed(rawSeed, siteSeed.scopes)
      const execution = await runtime.execute({
        command: "wordpress.run-php",
        args: [`code=${siteSeedJsonImportCode(siteSeed.name, bounded.seed)}`],
      })
      executions.push(withRecipeExecutionPhase(execution, "setup", index))
      const imported = parseSiteSeedImportResult(execution.stdout)
      results.push({
        ...base,
        action: "imported",
        counts: {
          ...bounded.counts,
          ...imported.counts,
        },
        ...(imported.warnings.length > 0 ? { warnings: imported.warnings } : {}),
        provenance: {
          importer: "json",
          source,
          ...(imported.provenance ?? {}),
        },
      })
      continue
    }

    const sourceContents = await readFile(source, "utf8")
    const execution = await runtime.execute({
      command: "wordpress.run-php",
      args: [`code=${siteSeedRegistryImportCode(siteSeed, format, source, sourceContents)}`],
    })
    executions.push(withRecipeExecutionPhase(execution, "setup", index))
    const imported = parseSiteSeedImportResult(execution.stdout)
    results.push({
      ...base,
      action: "imported",
      counts: imported.counts,
      ...(imported.warnings.length > 0 ? { warnings: imported.warnings } : {}),
      provenance: {
        importer: format,
        source,
        ...(imported.provenance ?? {}),
      },
    })
  }

  return results
}

function recipeSiteSeedRunBase(siteSeed: WorkspaceRecipeSiteSeed, recipeDirectory: string, index: number): Omit<RecipeRunSiteSeed, "action" | "reason" | "counts"> {
  return {
    index,
    type: siteSeed.type,
    name: siteSeed.name,
    ...(siteSeed.source ? { source: resolve(recipeDirectory, siteSeed.source) } : {}),
    ...(siteSeed.format ? { format: siteSeed.format } : {}),
    ...(siteSeed.type === "fixture" ? { importer: siteSeed.format ?? "json" } : {}),
    scopes: siteSeed.scopes,
    bounded: siteSeedScopesAreBounded(siteSeed),
    privacy: {
      exportsParentSiteData: false,
      importsIntoSandbox: siteSeed.type === "fixture",
      includesRecordData: siteSeed.type === "fixture",
      secrets: "excluded-by-default",
    },
  }
}

function parseSiteSeedImportResult(stdout: string): { counts: Record<string, number>; warnings: string[]; provenance?: Record<string, unknown> } {
  const parsed = JSON.parse(stdout.trim() || "{}") as { counts?: Record<string, unknown>; warnings?: unknown[]; provenance?: unknown }
  const counts: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed.counts ?? {})) {
    if (typeof value === "number") {
      counts[key] = value
    }
  }
  const warnings = (parsed.warnings ?? []).filter((warning): warning is string => typeof warning === "string")
  return {
    counts,
    warnings,
    ...(parsed.provenance && typeof parsed.provenance === "object" && !Array.isArray(parsed.provenance) ? { provenance: parsed.provenance as Record<string, unknown> } : {}),
  }
}

function siteSeedJsonImportCode(seedName: string, seed: unknown): string {
  const encodedSeed = JSON.stringify(JSON.stringify(seed))
  const encodedName = JSON.stringify(seedName)
  return `
$seed_name = ${encodedName};
$seed = json_decode(${encodedSeed}, true);
if (!is_array($seed)) {
    throw new RuntimeException('Site seed fixture must decode to a JSON object.');
}

$counts = array('posts' => 0, 'options' => 0, 'terms' => 0, 'users' => 0, 'media' => 0, 'activePlugins' => 0, 'activeTheme' => 0);

foreach (($seed['posts'] ?? array()) as $post) {
    if (!is_array($post)) {
        continue;
    }
    $postarr = array(
        'post_type' => isset($post['post_type']) ? (string) $post['post_type'] : 'post',
        'post_status' => isset($post['post_status']) ? (string) $post['post_status'] : (isset($post['status']) ? (string) $post['status'] : 'publish'),
        'post_title' => isset($post['post_title']) ? (string) $post['post_title'] : (isset($post['title']) ? (string) $post['title'] : 'Seeded post'),
        'post_content' => isset($post['post_content']) ? (string) $post['post_content'] : (isset($post['content']) ? (string) $post['content'] : ''),
        'post_excerpt' => isset($post['post_excerpt']) ? (string) $post['post_excerpt'] : (isset($post['excerpt']) ? (string) $post['excerpt'] : ''),
    );
    if (isset($post['slug'])) {
        $postarr['post_name'] = (string) $post['slug'];
    } elseif (isset($post['post_name'])) {
        $postarr['post_name'] = (string) $post['post_name'];
    }
    $post_id = wp_insert_post($postarr, true);
    if (is_wp_error($post_id)) {
        throw new RuntimeException('Failed to import site seed post from ' . $seed_name . ': ' . $post_id->get_error_message());
    }
    $counts['posts']++;
}

$options = $seed['options'] ?? array();
if (is_array($options)) {
    foreach ($options as $key => $option) {
        if (is_array($option) && array_key_exists('name', $option)) {
            update_option((string) $option['name'], $option['value'] ?? '');
            $counts['options']++;
            continue;
        }
        if (is_string($key)) {
            update_option($key, $option);
            $counts['options']++;
        }
    }
}

foreach (($seed['terms'] ?? array()) as $term) {
    if (!is_array($term) || empty($term['name']) || empty($term['taxonomy'])) {
        continue;
    }
    $result = wp_insert_term((string) $term['name'], (string) $term['taxonomy'], array_filter(array(
        'slug' => isset($term['slug']) ? (string) $term['slug'] : null,
        'description' => isset($term['description']) ? (string) $term['description'] : null,
    ), static fn($value) => $value !== null));
    if (is_wp_error($result) && 'term_exists' !== $result->get_error_code()) {
        throw new RuntimeException('Failed to import site seed term from ' . $seed_name . ': ' . $result->get_error_message());
    }
    $counts['terms']++;
}

foreach (($seed['users'] ?? array()) as $user) {
    if (!is_array($user)) {
        continue;
    }
    $login = isset($user['user_login']) ? (string) $user['user_login'] : (isset($user['login']) ? (string) $user['login'] : '');
    if ('' === $login || !preg_match('/^[A-Za-z0-9_.@-]+$/', $login)) {
        throw new RuntimeException('Unsafe site seed user login from ' . $seed_name . '.');
    }
    if (username_exists($login)) {
        $counts['users']++;
        continue;
    }
    $email = isset($user['user_email']) ? (string) $user['user_email'] : (isset($user['email']) ? (string) $user['email'] : $login . '@example.invalid');
    if (!is_email($email)) {
        $email = $login . '@example.invalid';
    }
    $user_id = wp_insert_user(array(
        'user_login' => $login,
        'user_pass' => wp_generate_password(24, true, true),
        'user_email' => $email,
        'display_name' => isset($user['display_name']) ? (string) $user['display_name'] : $login,
        'role' => isset($user['role']) ? (string) $user['role'] : (is_array($user['roles'] ?? null) && count($user['roles']) > 0 ? (string) reset($user['roles']) : 'subscriber'),
    ));
    if (is_wp_error($user_id)) {
        throw new RuntimeException('Failed to import site seed user from ' . $seed_name . ': ' . $user_id->get_error_message());
    }
    $counts['users']++;
}

foreach (($seed['media'] ?? array()) as $media) {
    if (!is_array($media)) {
        continue;
    }
    $attachment = array(
        'post_type' => 'attachment',
        'post_status' => isset($media['post_status']) ? (string) $media['post_status'] : 'inherit',
        'post_title' => isset($media['post_title']) ? (string) $media['post_title'] : (isset($media['title']) ? (string) $media['title'] : 'Seeded media'),
        'post_content' => isset($media['post_content']) ? (string) $media['post_content'] : '',
        'post_excerpt' => isset($media['post_excerpt']) ? (string) $media['post_excerpt'] : '',
        'post_mime_type' => isset($media['post_mime_type']) ? (string) $media['post_mime_type'] : (isset($media['mime_type']) ? (string) $media['mime_type'] : ''),
    );
    if (isset($media['slug'])) {
        $attachment['post_name'] = (string) $media['slug'];
    } elseif (isset($media['post_name'])) {
        $attachment['post_name'] = (string) $media['post_name'];
    }
    $attachment_id = wp_insert_post($attachment, true);
    if (is_wp_error($attachment_id)) {
        throw new RuntimeException('Failed to import site seed media from ' . $seed_name . ': ' . $attachment_id->get_error_message());
    }
    $counts['media']++;
}

$active_plugins = $seed['activePlugins'] ?? array();
if (is_array($active_plugins) && count($active_plugins) > 0) {
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    foreach ($active_plugins as $plugin) {
        $plugin_file = is_array($plugin) ? ($plugin['pluginFile'] ?? ($plugin['file'] ?? '')) : $plugin;
        $plugin_file = is_string($plugin_file) ? $plugin_file : '';
        if ('' === $plugin_file || str_starts_with($plugin_file, '/') || str_contains($plugin_file, '..') || !str_ends_with($plugin_file, '.php')) {
            throw new RuntimeException('Unsafe site seed active plugin entry from ' . $seed_name . '.');
        }
        if (!file_exists(WP_PLUGIN_DIR . '/' . $plugin_file)) {
            throw new RuntimeException('Site seed active plugin is not installed in sandbox: ' . $plugin_file);
        }
        $result = activate_plugin($plugin_file, '', false, true);
        if (is_wp_error($result)) {
            throw new RuntimeException('Failed to activate site seed plugin from ' . $seed_name . ': ' . $result->get_error_message());
        }
        $counts['activePlugins']++;
    }
}

$active_theme = $seed['activeTheme'] ?? null;
if (is_array($active_theme)) {
    $active_theme = $active_theme['stylesheet'] ?? ($active_theme['slug'] ?? null);
}
if (is_string($active_theme) && '' !== $active_theme) {
    if (!preg_match('/^[A-Za-z0-9_-]+$/', $active_theme)) {
        throw new RuntimeException('Unsafe site seed active theme entry from ' . $seed_name . '.');
    }
    $theme = wp_get_theme($active_theme);
    if (!$theme->exists()) {
        throw new RuntimeException('Site seed active theme is not installed in sandbox: ' . $active_theme);
    }
    switch_theme($active_theme);
    $counts['activeTheme']++;
}

echo wp_json_encode(array('schema' => 'wp-codebox/site-seed-import/v1', 'name' => $seed_name, 'counts' => $counts));
`}

function siteSeedRegistryImportCode(siteSeed: WorkspaceRecipeSiteSeed, format: string, source: string, sourceContents: string): string {
  const encodedName = JSON.stringify(siteSeed.name)
  const encodedFormat = JSON.stringify(format)
  const encodedSource = JSON.stringify(source)
  const encodedSourceBasename = JSON.stringify(basename(source))
  const encodedSourceContents = JSON.stringify(sourceContents)
  const encodedScopes = JSON.stringify(JSON.stringify(siteSeed.scopes))
  return `
$seed_name = ${encodedName};
$format = ${encodedFormat};
$source = ${encodedSource};
$source_basename = ${encodedSourceBasename};
$source_contents = ${encodedSourceContents};
$scopes = json_decode(${encodedScopes}, true);
if (!is_array($scopes)) {
    throw new RuntimeException('Site seed scopes must decode to an object.');
}

$importers = apply_filters('wp_codebox_site_seed_importers', array());
if (!is_array($importers) || !array_key_exists($format, $importers)) {
    throw new RuntimeException('No WP Codebox site seed importer registered for format: ' . $format);
}

$importer = $importers[$format];
$callback = is_array($importer) && array_key_exists('callback', $importer) ? $importer['callback'] : $importer;
if (!is_callable($callback)) {
    throw new RuntimeException('WP Codebox site seed importer is not callable for format: ' . $format);
}

$result = call_user_func($callback, array(
    'schema' => 'wp-codebox/site-seed-import-request/v1',
    'name' => $seed_name,
    'format' => $format,
    'source' => $source,
    'source_basename' => $source_basename,
    'source_contents' => $source_contents,
    'scopes' => $scopes,
    'metadata' => array(
        'source_size' => strlen($source_contents),
    ),
));

if (!is_array($result)) {
    throw new RuntimeException('WP Codebox site seed importer must return an array for format: ' . $format);
}

$counts = array();
foreach (($result['counts'] ?? array()) as $key => $value) {
    if (is_int($value) || is_float($value)) {
        $counts[(string) $key] = $value;
    }
}

$warnings = array();
foreach (($result['warnings'] ?? array()) as $warning) {
    if (is_string($warning)) {
        $warnings[] = $warning;
    }
}

$provenance = isset($result['provenance']) && is_array($result['provenance']) ? $result['provenance'] : array();
$provenance['importer'] = $format;
$provenance['source'] = $source;

echo wp_json_encode(array(
    'schema' => 'wp-codebox/site-seed-import/v1',
    'name' => $seed_name,
    'importer' => $format,
    'counts' => $counts,
    'warnings' => $warnings,
    'provenance' => $provenance,
));
`}

function boundedFixtureSeed(rawSeed: unknown, scopes: WorkspaceRecipeSiteSeed["scopes"]): { seed: Record<string, unknown>; counts: Record<string, number> } {
  if (!rawSeed || typeof rawSeed !== "object" || Array.isArray(rawSeed)) {
    throw new Error("Recipe fixture siteSeed JSON must be an object")
  }

  const seed = rawSeed as Record<string, unknown>
  const posts = boundedRecords(arrayRecords(seed.posts), scopes.posts, (record, scope) => matchesPostScope(record, scope))
  const options = boundedOptions(seed.options, scopes.options)
  const terms = boundedRecords(arrayRecords(seed.terms), scopes.terms, (record, scope) => matchesTermScope(record, scope))
  const users = boundedRecords(arrayRecords(seed.users), scopes.users, (record, scope) => matchesUserScope(record, scope))
  const media = boundedRecords(arrayRecords(seed.media), scopes.media, (record, scope) => matchesMediaScope(record, scope))
  const activePlugins = boundedActivePlugins(seed.activePlugins, scopes.activePlugins)
  const activeTheme = boundedActiveTheme(seed.activeTheme, scopes.activeTheme)

  return {
    seed: stripUndefined({ posts: posts.records, options: options.records, terms: terms.records, users: users.records, media: media.records, activePlugins: activePlugins.records, activeTheme: activeTheme.record }),
    counts: {
      fixturePostsIncluded: posts.records.length,
      fixturePostsExcluded: posts.excluded,
      fixtureOptionsIncluded: options.count,
      fixtureOptionsExcluded: options.excluded,
      fixtureTermsIncluded: terms.records.length,
      fixtureTermsExcluded: terms.excluded,
      fixtureUsersIncluded: users.records.length,
      fixtureUsersExcluded: users.excluded,
      fixtureMediaIncluded: media.records.length,
      fixtureMediaExcluded: media.excluded,
      fixtureActivePluginsIncluded: activePlugins.records.length,
      fixtureActivePluginsExcluded: activePlugins.excluded,
      fixtureActiveThemeIncluded: activeTheme.record === undefined ? 0 : 1,
      fixtureActiveThemeExcluded: activeTheme.excluded,
    },
  }
}

function boundedActivePlugins(activePlugins: unknown, scope: boolean | undefined): { records: Array<string | Record<string, unknown>>; excluded: number } {
  const records = Array.isArray(activePlugins)
    ? activePlugins.filter((plugin): plugin is string | Record<string, unknown> => typeof plugin === "string" || (Boolean(plugin) && typeof plugin === "object" && !Array.isArray(plugin)))
    : []

  if (scope !== true) {
    return { records: [], excluded: records.length }
  }

  const included = records.slice(0, 100)
  return { records: included, excluded: records.length - included.length }
}

function boundedActiveTheme(activeTheme: unknown, scope: boolean | undefined): { record: unknown; excluded: number } {
  if (activeTheme === undefined || activeTheme === null) {
    return { record: undefined, excluded: 0 }
  }

  if (scope !== true) {
    return { record: undefined, excluded: 1 }
  }

  return { record: activeTheme, excluded: 0 }
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []
}

function boundedRecords(records: Array<Record<string, unknown>>, scope: WorkspaceRecipeSiteSeed["scopes"]["posts"], matches: (record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>) => boolean): { records: Array<Record<string, unknown>>; excluded: number } {
  if (!scope) {
    return { records: [], excluded: records.length }
  }

  const filtered = records.filter((record) => matches(record, scope))
  const maxRecords = scope.maxRecords ?? filtered.length
  return {
    records: filtered.slice(0, maxRecords),
    excluded: records.length - Math.min(filtered.length, maxRecords),
  }
}

function boundedOptions(options: unknown, scope: WorkspaceRecipeSiteSeed["scopes"]["options"]): { records: Record<string, unknown> | Array<Record<string, unknown>> | undefined; count: number; excluded: number } {
  if (!scope || !scope.names || scope.names.length === 0) {
    const count = Array.isArray(options) ? options.length : options && typeof options === "object" ? Object.keys(options).length : 0
    return { records: undefined, count: 0, excluded: count }
  }

  const allowed = new Set(scope.names)
  const maxRecords = scope.maxRecords ?? allowed.size
  if (Array.isArray(options)) {
    const filtered = options.filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object" && !Array.isArray(option) && typeof option.name === "string" && allowed.has(option.name)).slice(0, maxRecords)
    return { records: filtered, count: filtered.length, excluded: options.length - filtered.length }
  }

  if (!options || typeof options !== "object") {
    return { records: undefined, count: 0, excluded: 0 }
  }

  const entries = Object.entries(options as Record<string, unknown>).filter(([name]) => allowed.has(name)).slice(0, maxRecords)
  return { records: Object.fromEntries(entries), count: entries.length, excluded: Object.keys(options).length - entries.length }
}

function matchesPostScope(record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>): boolean {
  return matchesNumberSelector(record, scope.ids, ["id", "ID"]) &&
    matchesStringSelector(record, scope.slugs, ["slug", "post_name"]) &&
    matchesStringSelector(record, scope.postTypes, ["post_type", "type"]) &&
    matchesStringSelector(record, scope.statuses, ["post_status", "status"])
}

function matchesTermScope(record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["terms"]>): boolean {
  return matchesNumberSelector(record, scope.ids, ["id", "term_id"]) &&
    matchesStringSelector(record, scope.slugs, ["slug"]) &&
    matchesStringSelector(record, scope.names, ["name"]) &&
    matchesStringSelector(record, scope.taxonomies, ["taxonomy"])
}

function matchesUserScope(record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["users"]>): boolean {
  return matchesNumberSelector(record, scope.ids, ["id", "ID"]) &&
    matchesStringSelector(record, scope.names, ["user_login", "login", "display_name", "name"]) &&
    matchesArrayStringSelector(record, scope.roles, ["roles"])
}

function matchesMediaScope(record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["media"]>): boolean {
  return matchesNumberSelector(record, scope.ids, ["id", "ID"]) &&
    matchesStringSelector(record, scope.slugs, ["slug", "post_name"]) &&
    matchesStringSelector(record, scope.names, ["post_title", "title", "name"]) &&
    matchesStringSelector(record, scope.statuses, ["post_status", "status"])
}

function matchesStringSelector(record: Record<string, unknown>, allowed: string[] | undefined, keys: string[]): boolean {
  if (!allowed || allowed.length === 0) {
    return true
  }
  const values = keys.map((key) => record[key]).filter((value): value is string => typeof value === "string")
  return values.some((value) => allowed.includes(value))
}

function matchesArrayStringSelector(record: Record<string, unknown>, allowed: string[] | undefined, keys: string[]): boolean {
  if (!allowed || allowed.length === 0) {
    return true
  }
  const values = keys.flatMap((key) => Array.isArray(record[key]) ? record[key] : []).filter((value): value is string => typeof value === "string")
  return values.some((value) => allowed.includes(value))
}

function matchesNumberSelector(record: Record<string, unknown>, allowed: number[] | undefined, keys: string[]): boolean {
  if (!allowed || allowed.length === 0) {
    return true
  }
  const values = keys.map((key) => record[key]).filter((value): value is number => typeof value === "number")
  return values.some((value) => allowed.includes(value))
}
