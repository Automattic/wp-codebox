import { readFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { createRuntime, stripUndefined, type ArtifactBundle, type ExecutionResult, type Runtime, type RuntimeInfo, type WorkspaceRecipe, type WorkspaceRecipePluginRuntimeHealthProbe, type WorkspaceRecipeSiteSeed } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"
import { recipeExecutionSpec, sandboxWorkspaceContract } from "../agent-sandbox.js"
import { captureStdout, printRecipeHumanOutput, printRecipeValidateHumanOutput, serializeError } from "../output.js"
import { parsePreviewBind, parsePreviewHoldSeconds, parsePreviewPort, parsePreviewPublicUrl } from "../preview-options.js"
import { dryRunRecipe, pluginRuntimeHealthProbeStepIndex, pluginRuntimeSetupStepIndex, recipeDryRunSiteSeeds, siteSeedScopesAreBounded, type RecipeDryRunOutput, type RecipeDryRunSiteSeed, type RecipeDryRunStagedFile } from "../recipe-dry-run.js"
import { collectAndFinalizeFailedRecipeArtifacts, finalizeAgentSandboxEvidence, finalizeRecipeArtifactEvidence, recipeAgentResultFailure, recipeAgentResultOutput, recipeArtifactEvidenceFailure } from "../recipe-evidence.js"
import { activateExtraPluginsCode, cleanupRecipePreparedSources, installMuPluginsCode, prepareRecipeExtraPlugins, prepareRecipeRuntimeOverlays, prepareRecipeStagedFiles, prepareRecipeWorkspaces, recipeExtraPlugins, recipeMountType, type PreparedExtraPlugin, type PreparedRuntimeOverlay, type PreparedStagedFile, type PreparedWorkspaceMount } from "../recipe-sources.js"
import { parseWorkspaceRecipe, pluginRuntimeHealthProbeStep, recipePolicy, recipeWorkflowSteps, validateWorkspaceRecipe, type RecipeValidationIssue, type RecipeWorkflowPhase } from "../recipe-validation.js"
import { DEFAULT_WORDPRESS_VERSION, previewSpec, releaseRuntime, runtimeMetadata, type RunOutput } from "../runtime-command-wrappers.js"

interface RecipeRunOptions {
  recipePath: string
  artifactsDirectory?: string
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
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
  diagnostics?: RecipeRuntimeDiagnostic[]
  validation?: {
    issues: RecipeValidationIssue[]
  }
  benchResults?: BenchResults
  benchResultsList?: BenchResults[]
  artifacts?: ArtifactBundle
  interruption?: RecipeInterruptionMetadata
  logs?: string[]
  error?: RunOutput["error"]
}

type RecipeRunCommandOutput = RecipeRunOutput | RecipeDryRunOutput

type RecipeExecutionResult = ExecutionResult & {
  recipePhase?: RecipeWorkflowPhase
  recipeStepIndex?: number
  recipeCommand?: string
}

interface RecipeRuntimeDiagnostic {
  schema: "wp-codebox/plugin-runtime-diagnostic/v1"
  severity: "error"
  phase: "setup" | "health-probe" | "runtime" | "overlay-preparation"
  name?: string
  command?: string
  exitCode?: number
  message: string
  executionIndex?: number
}

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

interface BenchResults {
  component_id: string
  iterations: number
  scenarios: Array<Record<string, unknown>>
}

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
      return output.success ? 0 : 1
    }

    const { result, logs } = await captureStdout(execute)
    const interruptedResult = interruptedRecipeOutput(result, interruption)
    const output = logs.length > 0 ? { ...interruptedResult, logs } : interruptedResult
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    printJsonFailureDiagnostic(output)
    interruption?.propagateIfInterrupted()
    return output.success ? 0 : 1
  } finally {
    interruption?.dispose()
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

async function runRecipe(options: RecipeRunOptions, interruption?: RecipeInterruptionController): Promise<RecipeRunOutput> {
  const recipePath = resolve(options.recipePath)
  const recipeDirectory = dirname(recipePath)
  const recipe = parseWorkspaceRecipe(await readFile(recipePath, "utf8"), recipePath)
  const issues = await validateWorkspaceRecipe(recipe, recipePath)
  if (issues.length > 0) {
    return {
      success: false,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      executions: [],
      validation: { issues },
      error: {
        name: "RecipeValidationError",
        message: `Recipe validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
      },
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
  const awaitRecipe = <T>(promise: Promise<T>): Promise<T> => interruption ? interruption.interruptible(promise) : promise

  try {
    workspaceMounts = await prepareRecipeWorkspaces(recipe, recipeDirectory)
    extraPlugins = await prepareRecipeExtraPlugins(recipe, recipeDirectory)
    stagedFiles = await prepareRecipeStagedFiles(recipe, recipeDirectory)
    overlays = await prepareRecipeRuntimeOverlaysForRun(recipe, recipeDirectory)
    interruption?.throwIfInterrupted()

    runtime = await awaitRecipe(createRuntime(
      {
        backend: recipe.runtime?.backend ?? "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: recipe.runtime?.name ?? "wp-codebox-recipe",
          version: recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: recipe.runtime?.blueprint ?? { steps: [] },
        },
        policy: effectivePolicy,
        secretEnv,
        artifactsDirectory: options.artifactsDirectory ?? recipe.artifacts?.directory,
        metadata: {
          ...runtimeMetadata(options.artifactsDirectory ?? recipe.artifacts?.directory, recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION),
          ...recipeRunMetadata(recipe, recipePath, workspaceMounts, extraPlugins, stagedFiles, overlays, options.previewPublicUrl, options.previewPort, options.previewBind),
        },
        preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      createPlaygroundRuntimeBackend(),
    ))
    interruption?.throwIfInterrupted()

    for (const [index, mount] of (recipe.runtime?.stack?.mounts ?? []).entries()) {
      const source = resolve(recipeDirectory, mount.source)
      await awaitRecipe(runtime.mount({
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
      await awaitRecipe(runtime.mount({
        type: overlay.type,
        source: overlay.source,
        target: overlay.target,
        mode: overlay.mode,
        metadata: overlay.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    for (const workspace of workspaceMounts) {
      await awaitRecipe(runtime.mount({
        type: "directory",
        source: workspace.source,
        target: workspace.target,
        mode: workspace.mode,
        metadata: workspace.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    for (const plugin of extraPlugins) {
      await awaitRecipe(runtime.mount({
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

    for (const mount of recipe.inputs?.mounts ?? []) {
      const source = resolve(recipeDirectory, mount.source)
      await awaitRecipe(runtime.mount({
        type: await recipeMountType(source, mount.type),
        source,
        target: mount.target,
        mode: mount.mode ?? "readwrite",
        metadata: mount.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    for (const stagedFile of stagedFiles) {
      await awaitRecipe(runtime.mount({
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

    const pluginActivationCode = activateExtraPluginsCode(extraPlugins)
    if (pluginActivationCode) {
      executions.push(withRecipeExecutionPhase(await awaitRecipe(runtime.execute({ command: "wordpress.run-php", args: [`code=${pluginActivationCode}`] })), "setup", -1))
      interruption?.throwIfInterrupted()
    }

    for (const [index, setupStep] of (recipe.inputs?.pluginRuntime?.setup ?? []).entries()) {
      executions.push(await awaitRecipe(executeRecipePluginRuntimeStep(runtime, setupStep, recipeDirectory, "setup", index)))
      interruption?.throwIfInterrupted()
    }

    for (const [index, probe] of (recipe.inputs?.pluginRuntime?.healthProbes ?? []).entries()) {
      executions.push(await awaitRecipe(executeRecipePluginRuntimeHealthProbe(runtime, probe, recipeDirectory, index)))
      interruption?.throwIfInterrupted()
    }

    const siteSeeds = await awaitRecipe(importRecipeSiteSeeds(recipe, recipeDirectory, runtime, executions))
    interruption?.throwIfInterrupted()

    for (const workflowStep of recipeWorkflowSteps(recipe)) {
      executions.push(await awaitRecipe(executeRecipeWorkflowStep(runtime, workflowStep, recipeDirectory)))
      interruption?.throwIfInterrupted()
    }

    await awaitRecipe(runtime.observe({ type: "runtime-info" }))
    await awaitRecipe(runtime.observe({ type: "mounts" }))
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const evidence = await finalizeRecipeArtifactEvidence(artifacts, recipe, workspaceMounts, stagedFiles, effectivePolicy, secretEnv)
    const agentEvidence = await finalizeAgentSandboxEvidence(artifacts, executions)
    Object.assign(evidence, agentEvidence)
    markRecipeArtifactsFinalized(interruption, true)
    const strictFailure = recipeArtifactEvidenceFailure(evidence)
    const agentFailure = recipeAgentResultFailure(evidence.agentResult)
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds, () => cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles, overlays), interruption)
    interruption?.throwIfInterrupted()

    const benchResultsList = executions
      .filter((execution) => execution.command === "wordpress.bench" && execution.exitCode === 0)
      .map((execution) => parseBenchResults(execution.stdout))

    if (strictFailure || agentFailure) {
      return {
        success: false,
        schema: "wp-codebox/recipe-run/v1",
        recipePath,
        runtime: runtimeInfo ?? await runtime.info(),
        executions,
        stagedFiles: stagedFiles.map(recipeRunStagedFile),
        siteSeeds,
        ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
        ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
        ...(evidence.agentResult ? { agentResult: recipeAgentResultOutput(evidence.agentResult) } : {}),
        artifacts,
        error: strictFailure ?? agentFailure,
      }
    }

    return {
      success: true,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      runtime: runtimeInfo ?? await runtime.info(),
      executions,
      stagedFiles: stagedFiles.map(recipeRunStagedFile),
      siteSeeds,
      ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
      ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
      ...(evidence.agentResult ? { agentResult: recipeAgentResultOutput(evidence.agentResult) } : {}),
      artifacts,
    }
  } catch (error) {
    if (runtime) {
      artifacts = await collectAndFinalizeFailedRecipeArtifacts({
        runtime,
        existingArtifacts: artifacts,
        recipe,
        workspaceMounts,
        stagedFiles,
        policy: effectivePolicy,
        secretEnv,
        executions,
        interruption,
      })

      try {
        await runtime.destroy()
      } catch {
        // Preserve the original failure as the CLI result.
      }
    }

    await cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles, overlays)

    return {
      success: false,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      ...(runtime ? { runtime: await runtime.info() } : {}),
      executions,
      diagnostics: recipeRuntimeDiagnostics(recipe, executions, error),
      ...(artifacts ? { artifacts } : {}),
      ...(interruption?.metadata ? { interruption: interruption.metadata } : {}),
      error: serializeError(error),
    }
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

function parseBenchResults(raw: string): BenchResults {
  const parsed = JSON.parse(raw) as BenchResults
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.scenarios)) {
    throw new Error("Bench command did not emit a BenchResults envelope")
  }

  return parsed
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
  const options: Partial<RecipeRunOptions> = { json: false, dryRun: false }

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
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.recipePath) {
    throw new Error("Missing required option: --recipe")
  }

  return options as RecipeRunOptions
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

async function executeRecipeWorkflowStep(runtime: Runtime, workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], recipeDirectory: string): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(workflowStep.step, recipeDirectory))
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

function recipeRuntimeDiagnostics(recipe: WorkspaceRecipe, executions: RecipeExecutionResult[], error: unknown): RecipeRuntimeDiagnostic[] | undefined {
  const diagnostics: RecipeRuntimeDiagnostic[] = executions
    .map((execution, executionIndex) => ({ execution, executionIndex }))
    .filter(({ execution }) => execution.recipeCommand?.startsWith("plugin-runtime.") && execution.exitCode !== 0)
    .map(({ execution, executionIndex }) => ({
      schema: "wp-codebox/plugin-runtime-diagnostic/v1" as const,
      severity: "error" as const,
      phase: execution.recipeCommand?.startsWith("plugin-runtime.health:") ? "health-probe" as const : "setup" as const,
      name: execution.recipeCommand?.split(":").slice(1).join(":"),
      command: execution.command,
      exitCode: execution.exitCode,
      message: execution.stderr || execution.stdout || `Plugin runtime command failed with exit code ${execution.exitCode}`,
      executionIndex,
    }))

  const message = error instanceof Error ? error.message : String(error)
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
