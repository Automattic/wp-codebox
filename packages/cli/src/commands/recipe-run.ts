import { createHash } from "node:crypto"
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { DEFAULT_WORDPRESS_VERSION, artifactBundleRunRef, artifactManifestFile, createBenchResultsJsonSchema, createRuntime, refreshArtifactManifestFileSha256s, upsertArtifactManifestFiles, type ArtifactBundle, type ArtifactManifest, type ArtifactManifestFile, type BenchmarkArtifactRef, type BenchResults, type ExecutionResult, type Runtime, type RuntimeAssetSpec, type RuntimePreviewSpec, type RuntimeRunRecord, type RuntimeRunRegistry, type WorkspaceRecipe, type WorkspaceRecipeDeclaredArtifact, type WorkspaceRecipeFixtureDatabase, type WorkspaceRecipeMount, type WorkspaceRecipePluginRuntimeHealthProbe, type WorkspaceRecipeProbe, type WorkspaceRecipeSiteSeed } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { Ajv2020 } from "ajv/dist/2020.js"
import { recipeExecutionSpec, sandboxWorkspaceContract } from "../agent-sandbox.js"
import { executeAgentFanoutFromArgs } from "../agent-fanout.js"
import { captureStdout, printRecipeHumanOutput, printRecipeValidateHumanOutput, serializeError } from "../output.js"
import { parsePreviewBind, parsePreviewHoldSeconds, parsePreviewPort, parsePreviewPublicUrl } from "../preview-options.js"
import { dryRunRecipe, planWorkspaceRecipe, pluginRuntimeHealthProbeStepIndex, pluginRuntimeSetupStepIndex, recipeDryRunSiteSeeds, siteSeedScopesAreBounded } from "../recipe-dry-run.js"
import { appendRecipeRuntimeEvidence, collectAndFinalizeFailedRecipeArtifacts, collectRecipeRuntimeArtifacts, finalizeAgentSandboxEvidence, finalizeRecipeArtifactEvidence, recipeAgentResultFailure, recipeAgentResultOutput, recipeAgentTaskResultOutput, recipeArtifactEvidenceFailure, recipeCompletionOutcomeOutput, recipeReplayStatusOutput, recipeVerifyStepFailure } from "../recipe-evidence.js"
import { prepareRecipeRuntimeBackendPackage, type PreparedRuntimeBackendPackage } from "../recipe-backend-package.js"
import { cleanupRecipePreparedSources, installMuPluginsCode, prepareRecipeDependencyOverlays, prepareRecipeExtraPlugins, prepareRecipeRuntimeOverlays, prepareRecipeStagedFiles, prepareRecipeWorkspaces, recipeBlueprintWithBootActivePlugins, recipeExtraPlugins, recipeMountType, type PreparedDependencyOverlay, type PreparedExtraPlugin, type PreparedRuntimeOverlay, type PreparedStagedFile, type PreparedWorkspaceMount } from "../recipe-sources.js"
import { loadWorkspaceRecipe, pluginRuntimeHealthProbeStep, recipePolicy, recipeWorkflowSteps, validateWorkspaceRecipe, type RecipeWorkflowPhase } from "../recipe-validation.js"
import { resolveCliRuntimeBackend } from "../runtime-backends.js"
import { previewSpec, releaseRuntime, runtimeMetadata, type RunOutput } from "../runtime-command-wrappers.js"
import { createRecipeRunContext } from "./recipe-run-context.js"
import { createRecipeInterruptionController, interruptedRecipeOutput, markRecipeArtifactsFinalized, recipeInterruptionSerializedError } from "./recipe-run-interruption.js"
import { bestEffortTimeout, exitAfterPlaygroundCliBootFailure, exitAfterRecipeRunTimeout, exitAfterTerminalRecipePhaseFailure, isRecipeRunTimeoutError, printJsonFailureDiagnostic, recipeRunFailureStatus, RecipeDeclaredArtifactFailureError, RecipeProbeFailureError, RecipeRunTimeoutError, RecipeRuntimeCreateError, remainingRecipeTimeoutMs, serializeRecipeRunError, watchRecipeOperation, writeRecipeJsonOutput } from "./recipe-run-output.js"
import { RecipePhaseError, RecipePhaseTracker } from "./recipe-run-phases.js"
import type { RecipeAdvisoryFailure, RecipeBrowserEvidence, RecipeBrowserEvidenceFileRef, RecipeExecutionResult, RecipeInterruptionController, RecipePhaseEvidence, RecipePhaseName, RecipePhpWasmRuntimeDiagnostic, RecipeRunCommandOutput, RecipeRunDeclaredArtifact, RecipeRunFixtureDatabase, RecipeRunOptions, RecipeRunOutput, RecipeRunProbe, RecipeRunSiteSeed, RecipeRunStagedFile, RecipeRuntimeDiagnostic, RecipeValidateOptions, RecipeValidateOutput } from "./recipe-run-types.js"

const DEFAULT_RECIPE_RUN_TIMEOUT_MS = 25 * 60 * 1000
const SUCCESSFUL_RECIPE_RUNTIME_SNAPSHOT_TIMEOUT_MS = 120 * 1000

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
      exitAfterTerminalRecipePhaseFailure(output)
      return output.success ? 0 : 1
    }

    const { result, logs } = await captureStdout(execute)
    const interruptedResult = interruptedRecipeOutput(result, interruption)
    const output = logs.length > 0 ? { ...interruptedResult, logs } : interruptedResult
    await writeRecipeJsonOutput(output)
    printJsonFailureDiagnostic(output)
    interruption?.propagateIfInterrupted()
    exitAfterRecipeRunTimeout(output)
    exitAfterPlaygroundCliBootFailure(output)
    exitAfterTerminalRecipePhaseFailure(output)
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

  await writeRecipeJsonOutput(output)
  return output.success ? 0 : 1
}

async function runRecipe(options: RecipeRunOptions, interruption?: RecipeInterruptionController): Promise<RecipeRunOutput> {
  const context = await createRecipeRunContext(options)
  const { recipePath, recipeDirectory, recipe, configuredArtifactsDirectory, runRegistry, artifactPointer, startedAtMs } = context
  let { runRecord } = context
  await artifactPointer.update({ commandStatus: "queued" })
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
    await artifactPointer.update({ command: "recipe.validate", commandStatus: "failed", failure })
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

  const plan = await planWorkspaceRecipe(recipe, recipeDirectory, { recipePath, artifactsDirectory: configuredArtifactsDirectory }, { defaultWordPressVersion: DEFAULT_WORDPRESS_VERSION, resolveExecutionSpec: recipeExecutionSpec })
  const { valid: _policyValid, issues: _policyIssues, ...policy } = plan.policy
  const runtimeEnv = normalizeRuntimeEnv(recipe.inputs?.runtimeEnv ?? {})
  const secretEnv = resolveSecretEnv(recipe.inputs?.secretEnv ?? [])
  const effectivePolicy = Object.keys(secretEnv).length > 0 ? { ...policy, secrets: "connector-scoped" as const } : policy
  let workspaceMounts: PreparedWorkspaceMount[] = []
  let extraPlugins: PreparedExtraPlugin[] = []
  let dependencyOverlays: PreparedDependencyOverlay[] = []
  let stagedFiles: PreparedStagedFile[] = []
  let overlays: PreparedRuntimeOverlay[] = []
  const inputMountBaselinePaths: string[] = []
  let backendPackage: PreparedRuntimeBackendPackage | undefined
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  const executions: RecipeExecutionResult[] = []
  let fixtureDatabases: RecipeRunFixtureDatabase[] = []
  let probes: RecipeRunProbe[] = []
  let declaredArtifacts: RecipeRunDeclaredArtifact[] = []
  let advisoryFailures: RecipeAdvisoryFailure[] = []
  let browserEvidence: RecipeBrowserEvidence[] = []
  let artifacts: ArtifactBundle | undefined
  let startupDurationMs: number | undefined
  let cleanupEvidence: RunResourceCleanupEvidence | undefined
  let runtimeDestroyed = false
  const phaseTracker = new RecipePhaseTracker(serializeRecipeRunError, isRecipeRunTimeoutError)
  const destroyActiveRuntime = async (): Promise<void> => {
    if (!runtime || runtimeDestroyed) {
      return
    }

    runtimeDestroyed = true
    await bestEffortTimeout(runtime.destroy(), 2_000)
  }
  const awaitRecipe = <T>(operation: string, promiseOrFactory: Promise<T> | (() => Promise<T>), timeoutMs = remainingRecipeTimeoutMs(startedAtMs, options.timeoutMs)): Promise<T> => {
    return artifactPointer.update({ command: operation, commandStatus: "running", phases: phaseTracker.list() })
      .then(() => {
        const promise = typeof promiseOrFactory === "function" ? promiseOrFactory() : promiseOrFactory
        const guarded = watchRecipeOperation(operation, promise, startedAtMs, timeoutMs, options.timeoutMs)
        return interruption ? interruption.interruptible(guarded) : guarded
      })
      .then(async (result) => {
        await artifactPointer.update({ command: operation, commandStatus: "completed", phases: phaseTracker.list() })
        return result
      })
      .catch(async (error: unknown) => {
        if (isRecipeRunTimeoutError(error) || interruption?.metadata) {
          await destroyActiveRuntime()
        }
        await artifactPointer.update({ command: operation, commandStatus: "failed", failure: serializeRecipeRunError(error), phases: phaseTracker.list() })
        throw error
      })
  }

  try {
    workspaceMounts = await prepareRecipeWorkspaces(recipe, recipeDirectory)
    extraPlugins = await prepareRecipeExtraPlugins(recipe, recipeDirectory)
    dependencyOverlays = await prepareRecipeDependencyOverlays(recipe, recipeDirectory, extraPlugins)
    stagedFiles = await prepareRecipeStagedFiles(recipe, recipeDirectory)
    overlays = await prepareRecipeRuntimeOverlaysForRun(recipe, recipeDirectory)
    backendPackage = await prepareRecipeRuntimeBackendPackage(recipe, recipeDirectory)
    interruption?.throwIfInterrupted()

    runRecord = await runRegistry.update(runRecord.runId, { status: "booting" })
    const runtimeEnvironment = {
      kind: "wordpress" as const,
      name: plan.runtime.name,
      version: plan.runtime.wp,
      phpVersion: plan.runtime.phpVersion,
      wordpressInstallMode: plan.runtime.wordpressInstallMode,
      blueprint: plan.runtime.blueprint,
      assets: resolveRecipeRuntimeAssets(recipe, recipeDirectory),
    }
    const effectivePreview = effectiveRecipePreview(recipe.runtime?.preview, options)
    const runtimeCreateSpec = {
      backend: plan.runtime.backend,
      environment: runtimeEnvironment,
      policy: effectivePolicy,
      runtimeEnv,
      secretEnv,
      artifactsDirectory: configuredArtifactsDirectory,
      metadata: {
        ...runtimeMetadata(configuredArtifactsDirectory, plan.runtime.wp),
        run: { runId: runRecord.runId, registryDirectory: runRegistry.directory },
        ...recipeRunMetadata(recipe, recipePath, workspaceMounts, extraPlugins, dependencyOverlays, stagedFiles, overlays, backendPackage, effectivePreview),
      },
      preview: previewSpec(effectivePreview.publicUrl, effectivePreview.port, effectivePreview.bind, effectivePreview.siteUrl),
    }
    try {
      const startupStartedAtMs = Date.now()
      runtime = await phaseTracker.run("runtime_startup", {
        operation: "runtime.create",
        backend: runtimeCreateSpec.backend,
        ...(backendPackage ? { backendPackage: backendPackage.provenance } : {}),
        runtime: runtimeEnvironment,
      }, async () => await awaitRecipe("runtime.create", () => createRuntime(
        runtimeCreateSpec,
        resolveCliRuntimeBackend(runtimeCreateSpec.backend, { cliModule: backendPackage?.cliModule }),
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
        dependencyOverlays: dependencyOverlays.map(recipeRunDependencyOverlay),
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
        ...(backendPackage ? { backendPackage: backendPackage.provenance } : {}),
      }, error)
    }
    if (!runtime) {
      throw new Error("Runtime creation did not return a runtime")
    }
    runRecord = await runRegistry.update(runRecord.runId, { status: "running", runtime: await runtime.info() })
    await artifactPointer.update({ runtime: await runtime.info(), phases: phaseTracker.list() })
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

    for (const overlay of dependencyOverlays) {
      await awaitRecipe(`dependency-overlay.mount:${overlay.package}`, runtime.mount({
        type: overlay.type,
        source: overlay.source,
        target: overlay.target,
        mode: overlay.mode,
        metadata: overlay.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    for (const mount of recipe.inputs?.mounts ?? []) {
      const source = resolve(recipeDirectory, mount.source)
      const metadata = await inputMountMetadataWithBaseline(source, mount, inputMountBaselinePaths)
      await awaitRecipe(`input.mount:${mount.target}`, runtime.mount({
        type: await recipeMountType(source, mount.type),
        source,
        target: mount.target,
        mode: mount.mode ?? "readwrite",
        metadata,
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

    fixtureDatabases = await phaseTracker.run("import_fixture_databases", phaseFixtureDatabaseData(recipe), async () => await awaitRecipe("fixture-databases.import", importRecipeFixtureDatabases(recipe, recipeDirectory, runtime!, executions)))
    const siteSeeds = await awaitRecipe("site-seeds.import", importRecipeSiteSeeds(recipe, recipeDirectory, runtime!, executions))
    interruption?.throwIfInterrupted()

    const sandboxWorkspace = sandboxWorkspaceContract(workspaceMounts, recipe.inputs?.mounts ?? [])
    const workflowSteps = recipeWorkflowSteps(recipe)
    await phaseTracker.run("run_workloads", phaseWorkflowData(workflowSteps), async () => {
      for (const workflowStep of workflowSteps) {
        const operation = `workflow.${workflowStep.phase}[${workflowStep.index}]:${workflowStep.step.command}`
        try {
          const execution = await awaitRecipe(operation, () => executeRecipeWorkflowStep(runtime!, workflowStep, recipeDirectory, sandboxWorkspace, configuredArtifactsDirectory, options))
          executions.push({ ...execution, ...(recipeWorkflowStepIsAdvisory(workflowStep.step) ? { recipeAdvisory: true } : {}) })
          interruption?.throwIfInterrupted()
        } catch (error) {
          if (!recipeWorkflowStepIsAdvisory(workflowStep.step)) {
            throw error
          }
          advisoryFailures.push(recipeAdvisoryFailure(workflowStep, error))
          interruption?.clear()
        }
      }
    })

    probes = await phaseTracker.run("run_probes", phaseProbeData(recipe), async () => await awaitRecipe("recipe-probes.run", runRecipeProbes(recipe, recipeDirectory, runtime!, executions)))
    const probeFailure = recipeProbeFailure(probes)
    if (probeFailure) {
      throw probeFailure
    }

    let evidence = await phaseTracker.run("collect_artifacts", { includeLogs: true, includeObservations: true }, async () => {
      declaredArtifacts = await awaitRecipe("recipe-artifacts.collect", collectRecipeDeclaredArtifacts(recipe, runtime!))
      const declaredArtifactFailure = recipeDeclaredArtifactFailure(declaredArtifacts)
      await awaitRecipe("runtime.observe:runtime-info", runtime!.observe({ type: "runtime-info" }))
      await awaitRecipe("runtime.observe:mounts", runtime!.observe({ type: "mounts" }))
      runRecord = await runRegistry.update(runRecord.runId, { status: "collecting_artifacts", runtime: await runtime!.info() })
      artifacts = await awaitRecipe("runtime.collect-artifacts", collectRecipeRuntimeArtifacts(runtime!, { includeLogs: true, includeObservations: true }, { snapshotTimeoutMs: SUCCESSFUL_RECIPE_RUNTIME_SNAPSHOT_TIMEOUT_MS }))
      browserEvidence = await recipeBrowserEvidence(artifacts, executions)
      await artifactPointer.update({ runtime: await runtime!.info(), artifacts, phases: phaseTracker.list(), browserEvidence })
      await appendRecipeRuntimeEvidence(artifacts, recipeRuntimeEvidenceFiles(fixtureDatabases, probes, declaredArtifacts))
      if (declaredArtifactFailure) {
        throw declaredArtifactFailure
      }
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
    const verifyFailure = recipeVerifyStepFailure(executions)
    const recipeFailure = strictFailure ?? agentFailure ?? verifyFailure
    const successfulRecipe = !recipeFailure
    if (successfulRecipe && options.previewHoldSeconds) {
      artifacts = await awaitRecipe("runtime.collect-artifacts.preview-hold", collectRecipeRuntimeArtifacts(runtime, { includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds }, { snapshotTimeoutMs: SUCCESSFUL_RECIPE_RUNTIME_SNAPSHOT_TIMEOUT_MS }))
      browserEvidence = await recipeBrowserEvidence(artifacts, executions)
      await artifactPointer.update({ runtime: await runtime.info(), artifacts, phases: phaseTracker.list(), browserEvidence })
      evidence = await finalizeRecipeArtifactEvidence(artifacts, recipe, workspaceMounts, stagedFiles, effectivePolicy, secretEnv)
      const previewAgentEvidence = await finalizeAgentSandboxEvidence(artifacts, executions)
      Object.assign(evidence, previewAgentEvidence)
    }
    const runtimeInfo = successfulRecipe && options.previewHoldSeconds ? await runtime.info() : undefined
    const activeRuntime = runtime
    cleanupEvidence = await runRecipeCleanup(runRegistry, runRecord, async () => {
      await awaitRecipe("runtime.release", releaseRuntime(activeRuntime, successfulRecipe && options.previewHoldBlocking ? options.previewHoldSeconds : 0))
      await cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles, overlays, dependencyOverlays)
      await cleanupInputMountBaselines(inputMountBaselinePaths)
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

    if (recipeFailure) {
      runRecord = await runRegistry.update(runRecord.runId, {
        status: "failed",
        runtime: runtimeInfo ?? await runtime.info(),
        preview: artifacts.preview,
        artifactRefs: artifactBundleRunRef(artifacts),
        metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs, status: "failed", startupDurationMs, cleanup: cleanupEvidence, artifacts, failure: recipeFailure, phaseEvidence: phaseTracker.list() }), ...(evidence.replayStatus ? { replayStatus: recipeReplayStatusOutput(evidence.replayStatus) } : {}) },
        error: recipeFailure,
      })
      await artifactPointer.update({ commandStatus: "failed", runtime: runtimeInfo ?? await runtime.info(), artifacts, failure: recipeFailure, phases: phaseTracker.list(), browserEvidence })
      return {
        success: false,
        schema: "wp-codebox/recipe-run/v1",
        recipePath,
        runtime: runtimeInfo ?? await runtime.info(),
        executions,
        stagedFiles: stagedFiles.map(recipeRunStagedFile),
        fixtureDatabases,
        siteSeeds,
        probes,
        declaredArtifacts,
        phaseEvidence: phaseTracker.list(),
        ...(advisoryFailures.length > 0 ? { advisoryFailures } : {}),
        ...(browserEvidence.length > 0 ? { browserEvidence } : {}),
        ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
        ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
        ...(evidence.agentResult ? { agentResult: recipeAgentResultOutput(evidence.agentResult) } : {}),
        ...(evidence.agentTaskResult ? { agentTaskResult: recipeAgentTaskResultOutput(evidence.agentTaskResult) } : {}),
        ...(evidence.completionOutcome ? { completionOutcome: recipeCompletionOutcomeOutput(evidence.completionOutcome) } : {}),
        ...(evidence.replayStatus ? { replayStatus: recipeReplayStatusOutput(evidence.replayStatus) } : {}),
        artifacts,
        run: runRecord,
        error: recipeFailure,
      }
    }

    runRecord = await runRegistry.update(runRecord.runId, {
      status: "succeeded",
      runtime: runtimeInfo ?? await runtime.info(),
      preview: artifacts.preview,
      artifactRefs: artifactBundleRunRef(artifacts),
      metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs, status: "succeeded", startupDurationMs, cleanup: cleanupEvidence, artifacts, phaseEvidence: phaseTracker.list() }), ...(evidence.replayStatus ? { replayStatus: recipeReplayStatusOutput(evidence.replayStatus) } : {}) },
    })
    await artifactPointer.update({ commandStatus: "completed", runtime: runtimeInfo ?? await runtime.info(), artifacts, phases: phaseTracker.list(), browserEvidence })
    return {
      success: true,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      runtime: runtimeInfo ?? await runtime.info(),
      executions,
      stagedFiles: stagedFiles.map(recipeRunStagedFile),
      fixtureDatabases,
      siteSeeds,
      probes,
      declaredArtifacts,
      phaseEvidence: phaseTracker.list(),
      ...(advisoryFailures.length > 0 ? { advisoryFailures } : {}),
      ...(browserEvidence.length > 0 ? { browserEvidence } : {}),
      ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
      ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
      ...(evidence.agentResult ? { agentResult: recipeAgentResultOutput(evidence.agentResult) } : {}),
      ...(evidence.agentTaskResult ? { agentTaskResult: recipeAgentTaskResultOutput(evidence.agentTaskResult) } : {}),
      ...(evidence.completionOutcome ? { completionOutcome: recipeCompletionOutcomeOutput(evidence.completionOutcome) } : {}),
      ...(evidence.replayStatus ? { replayStatus: recipeReplayStatusOutput(evidence.replayStatus) } : {}),
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
      if (artifacts) {
        browserEvidence = await recipeBrowserEvidence(artifacts, executions)
        await artifactPointer.update({ runtime: await activeRuntime.info(), artifacts, phases: phaseTracker.list(), browserEvidence })
        try {
          if (declaredArtifacts.length === 0) {
            declaredArtifacts = await collectRecipeDeclaredArtifacts(recipe, activeRuntime)
          }
          await appendRecipeRuntimeEvidence(artifacts, recipeRuntimeEvidenceFiles(fixtureDatabases, probes, declaredArtifacts))
        } catch {
          // Preserve the original recipe failure; failure recovery already kept the base artifact bundle.
        }
      }

      if (error instanceof RecipeRunTimeoutError) {
        await destroyActiveRuntime()
      } else {
        await runRecipeCleanup(runRegistry, runRecord, async () => {
          try {
            await destroyActiveRuntime()
          } catch {
            // Preserve the original failure as the CLI result.
          }
        })
        runRecord = await runRegistry.read(runRecord.runId)
      }
    }

    cleanupEvidence = await runRecipeCleanup(runRegistry, runRecord, async () => {
      await cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles, overlays, dependencyOverlays)
      await cleanupInputMountBaselines(inputMountBaselinePaths)
    })
    runRecord = await runRegistry.read(runRecord.runId)
    const serializedError = interruption?.metadata ? recipeInterruptionSerializedError(interruption.metadata) : serializeRecipeRunError(error)
    runRecord = await runRegistry.update(runRecord.runId, {
      status: recipeRunFailureStatus(error, interruption),
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(artifacts ? { preview: artifacts.preview, artifactRefs: artifactBundleRunRef(artifacts) } : {}),
      metadata: { runResourceEvidence: await runResourceEvidence({ startedAtMs, status: recipeRunFailureStatus(error, interruption), startupDurationMs, cleanup: cleanupEvidence, artifacts, failure: serializedError, phaseEvidence: phaseTracker.list() }) },
      error: serializedError,
    })
    await artifactPointer.update({ commandStatus: "failed", ...(runtime ? { runtime: await runtime.info() } : {}), ...(artifacts ? { artifacts } : {}), failure: serializedError, phases: phaseTracker.list(), browserEvidence })

    return {
      success: false,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      ...(runtime ? { runtime: await runtime.info() } : {}),
      executions,
      stagedFiles: stagedFiles.map(recipeRunStagedFile),
      fixtureDatabases,
      probes,
      declaredArtifacts,
      phaseEvidence: phaseTracker.list(),
      ...(advisoryFailures.length > 0 ? { advisoryFailures } : {}),
      ...(browserEvidence.length > 0 ? { browserEvidence } : {}),
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
  if (!assets?.wordpressDirectory && !assets?.wordpressZip) {
    return undefined
  }

  return {
    ...assets,
    ...(assets.wordpressDirectory ? { wordpressDirectory: resolve(recipeDirectory, assets.wordpressDirectory) } : {}),
    ...(assets.wordpressZip ? { wordpressZip: isUrl(assets.wordpressZip) ? assets.wordpressZip : resolve(recipeDirectory, assets.wordpressZip) } : {}),
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
    const recipe = await loadWorkspaceRecipe(recipePath)
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
  const { parsed, prefix, suffix } = parseBenchResultsJson(raw)
  if (!validateBenchResultsSchema(parsed)) {
    throw new Error(`Bench command did not emit a wp-codebox/bench-results/v1 envelope: ${benchResultsAjv.errorsText(validateBenchResultsSchema.errors)}`)
  }

  const results = parsed as BenchResults
  const diagnostics = [...results.diagnostics]
  if (prefix.trim()) {
    diagnostics.push(benchOutputDiagnostic("bench-output-prefix", "before", prefix))
  }
  if (suffix.trim()) {
    diagnostics.push(benchOutputDiagnostic("bench-output-suffix", "after", suffix))
  }

  return {
    ...results,
    diagnostics,
    scenarios: results.scenarios.map((scenario) => enrichBenchScenarioArtifactRefs(scenario, manifestFiles)),
  }
}

function parseBenchResultsJson(raw: string): { parsed: unknown; prefix: string; suffix: string } {
  try {
    return { parsed: JSON.parse(raw) as unknown, prefix: "", suffix: "" }
  } catch (error) {
    const extracted = extractFirstJsonObject(raw)
    if (!extracted) {
      throw error
    }

    try {
      return { parsed: JSON.parse(extracted.json) as unknown, prefix: extracted.prefix, suffix: extracted.suffix }
    } catch {
      throw error
    }
  }
}

function extractFirstJsonObject(raw: string): { json: string; prefix: string; suffix: string } | undefined {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < raw.length; index++) {
      const character = raw[index]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (character === "\\") {
          escaped = true
        } else if (character === '"') {
          inString = false
        }
        continue
      }

      if (character === '"') {
        inString = true
      } else if (character === "{") {
        depth++
      } else if (character === "}") {
        depth--
        if (depth === 0) {
          return { json: raw.slice(start, index + 1), prefix: raw.slice(0, start), suffix: raw.slice(index + 1) }
        }
      }
    }
  }

  return undefined
}

function benchOutputDiagnostic(code: string, position: "before" | "after", output: string): BenchResults["diagnostics"][number] {
  return {
    severity: "warning",
    code,
    source: "wordpress.bench/stdout",
    message: `wordpress.bench emitted non-JSON stdout ${position} the bench-results envelope.`,
    details: {
      output: boundDiagnosticText(output),
    },
  }
}

function boundDiagnosticText(output: string): string {
  const normalized = output.trim()
  return normalized.length > 4000 ? `${normalized.slice(0, 4000)}...` : normalized
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

function normalizeRuntimeEnv(values: Record<string, unknown>): Record<string, string> {
  const runtimeEnv: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    const normalized = name.trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized) || typeof value !== "string") {
      continue
    }

    runtimeEnv[normalized] = value
  }

  return runtimeEnv
}

function parseRecipeRunOptions(args: string[]): RecipeRunOptions {
  const options: Partial<RecipeRunOptions> = { json: false, dryRun: false, previewHoldBlocking: false, timeoutMs: DEFAULT_RECIPE_RUN_TIMEOUT_MS }

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

    if (arg === "--preview-hold-blocking") {
      options.previewHoldBlocking = true
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
      case "--preview-hold-seconds":
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

function recipeWorkflowStepIsAdvisory(step: WorkspaceRecipe["workflow"]["steps"][number]): boolean {
  return step.allowFailure === true || step.advisory === true
}

function recipeAdvisoryFailure(workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], error: unknown): RecipeAdvisoryFailure {
  return {
    schema: "wp-codebox/recipe-advisory-failure/v1",
    phase: workflowStep.phase,
    index: workflowStep.index,
    command: workflowStep.step.command,
    status: "failed",
    error: serializeRecipeRunError(error),
  }
}

async function recipeBrowserEvidence(artifacts: ArtifactBundle, executions: RecipeExecutionResult[]): Promise<RecipeBrowserEvidence[]> {
  const manifestFiles = await artifactManifestFilesByPath(artifacts)
  return executions.flatMap((execution) => recipeBrowserEvidenceForExecution(execution, manifestFiles))
}

function recipeBrowserEvidenceForExecution(execution: RecipeExecutionResult, manifestFiles: Map<string, ArtifactManifestFile>): RecipeBrowserEvidence[] {
  const command = execution.recipeCommand ?? execution.command
  if (!recipeCommandProducesBrowserEvidence(command)) {
    return []
  }

  const parsed = parseJsonObject(execution.stdout)
  if (!parsed) {
    return []
  }

  if (Array.isArray(parsed.profiles)) {
    return parsed.profiles.flatMap((profile) => {
      const profileEvidence = recipeBrowserEvidenceFromParsedExecution(execution, command, profile, manifestFiles)
      return profileEvidence ? [profileEvidence] : []
    })
  }

  const evidence = recipeBrowserEvidenceFromParsedExecution(execution, command, parsed, manifestFiles)
  return evidence ? [evidence] : []
}

function recipeBrowserEvidenceFromParsedExecution(execution: RecipeExecutionResult, command: string, parsed: Record<string, unknown>, manifestFiles: Map<string, ArtifactManifestFile>): RecipeBrowserEvidence | undefined {
  const files = recipeBrowserEvidenceFiles(parsed.files, manifestFiles)
  const summaryFile = browserEvidenceFileRef(stringValue((parsed.files as Record<string, unknown> | undefined)?.summary), manifestFiles)
  if (Object.keys(files).length === 0 && !summaryFile) {
    return undefined
  }

  const summary = parsed.summary
  const summaryObject = isRecord(summary) ? summary : undefined
  return stripUndefined({
    schema: "wp-codebox/recipe-browser-evidence/v1",
    phase: execution.recipePhase,
    index: execution.recipeStepIndex,
    command,
    status: execution.exitCode === 0 ? "completed" : "failed",
    requestedUrl: stringValue(parsed.requestedUrl),
    finalUrl: stringValue(parsed.finalUrl ?? summaryObject?.finalUrl),
    summaryFile,
    files,
    summary,
    scriptResult: summaryObject?.scriptResult,
  }) as RecipeBrowserEvidence
}

function recipeBrowserEvidenceFiles(files: unknown, manifestFiles: Map<string, ArtifactManifestFile>): Record<string, RecipeBrowserEvidenceFileRef | RecipeBrowserEvidenceFileRef[]> {
  if (!isRecord(files)) {
    return {}
  }

  const refs: Record<string, RecipeBrowserEvidenceFileRef | RecipeBrowserEvidenceFileRef[]> = {}
  for (const [name, value] of Object.entries(files)) {
    const ref = Array.isArray(value)
      ? value.map((entry) => browserEvidenceFileRef(stringValue(entry), manifestFiles)).filter((entry): entry is RecipeBrowserEvidenceFileRef => Boolean(entry))
      : browserEvidenceFileRef(stringValue(value), manifestFiles)
    if (Array.isArray(ref)) {
      if (ref.length > 0) {
        refs[name] = ref
      }
      continue
    }
    if (ref) {
      refs[name] = ref
    }
  }
  return refs
}

function browserEvidenceFileRef(path: string | undefined, manifestFiles: Map<string, ArtifactManifestFile>): RecipeBrowserEvidenceFileRef | undefined {
  if (!path) {
    return undefined
  }
  const manifestFile = manifestFiles.get(path)
  return stripUndefined({
    path,
    kind: manifestFile?.kind,
    contentType: manifestFile?.contentType,
    sha256: manifestFile?.sha256,
  }) as RecipeBrowserEvidenceFileRef
}

function recipeCommandProducesBrowserEvidence(command: string): boolean {
  return command.startsWith("wordpress.browser-") || command === "wordpress.editor-canvas-probe" || command === "wordpress.html-capture"
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

async function executeRecipeWorkflowStep(runtime: Runtime, workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], recipeDirectory: string, sandboxWorkspace?: ReturnType<typeof sandboxWorkspaceContract>, artifactRoot?: string, options?: RecipeRunOptions): Promise<RecipeExecutionResult> {
  try {
    if (workflowStep.step.command === "wp-codebox.agent-fanout") {
      const startedAt = new Date().toISOString()
      const result = await executeAgentFanoutFromArgs(workflowStep.step.args ?? [], {
        artifactRoot: artifactRoot || recipeDirectory,
        recipeDirectory,
        previewHoldSeconds: options?.previewHoldSeconds === undefined ? "" : String(options.previewHoldSeconds),
        previewPublicUrl: options?.previewPublicUrl,
      })
      const finishedAt = new Date().toISOString()
      return withRecipeExecutionPhase({
        id: `agent-fanout-${workflowStep.index}`,
        command: workflowStep.step.command,
        args: workflowStep.step.args ?? [],
        exitCode: result.success ? 0 : 1,
        stdout: `${JSON.stringify(result, null, 2)}\n`,
        stderr: "",
        startedAt,
        finishedAt,
      }, workflowStep.phase, workflowStep.index, workflowStep.step.command)
    }
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

async function importRecipeFixtureDatabases(recipe: WorkspaceRecipe, recipeDirectory: string, runtime: Runtime, executions: RecipeExecutionResult[]): Promise<RecipeRunFixtureDatabase[]> {
  const results: RecipeRunFixtureDatabase[] = []
  for (const [index, fixture] of (recipe.inputs?.fixtureDatabases ?? []).entries()) {
    const source = resolve(recipeDirectory, fixture.source)
    const sql = await readFile(source, "utf8")
    const reset = {
      strategy: fixture.reset?.strategy ?? "truncate-tables" as const,
      tables: fixture.reset?.tables ?? [],
    }
    const execution = await runtime.execute({
      command: "wordpress.run-php",
      args: [`code=${fixtureDatabaseImportCode(fixture, sql, reset)}`],
    })
    executions.push(withRecipeExecutionPhase(execution, "setup", index, `fixture-database.import:${fixture.name}`))
    const imported = parseFixtureDatabaseImportResult(execution.stdout)
    results.push({
      schema: "wp-codebox/fixture-database-result/v1",
      index,
      name: fixture.name,
      version: fixture.version,
      source,
      format: fixture.format ?? "sql",
      action: "imported",
      reset,
      identity: {
        name: fixture.name,
        version: fixture.version,
        sourceSha256: createHash("sha256").update(sql).digest("hex"),
      },
      counts: imported.counts,
      ...(fixture.metadata ? { metadata: fixture.metadata } : {}),
    })
  }
  return results
}

async function runRecipeProbes(recipe: WorkspaceRecipe, recipeDirectory: string, runtime: Runtime, executions: RecipeExecutionResult[]): Promise<RecipeRunProbe[]> {
  const results: RecipeRunProbe[] = []
  for (const [index, probe] of (recipe.probes ?? []).entries()) {
    const execution = await executeRecipeProbe(runtime, probe, recipeDirectory, index)
    executions.push(execution)
    const parsedJson = parseProbeJson(execution.stdout)
    const failedJsonExpectation = probe.expectJson === true && parsedJson === undefined
    results.push(stripUndefined({
      schema: "wp-codebox/recipe-probe-result/v1" as const,
      index,
      name: probe.name,
      status: execution.exitCode === 0 && !failedJsonExpectation ? "passed" as const : "failed" as const,
      command: execution.command,
      args: execution.args,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      parsedJson,
      allowFailure: probe.allowFailure === true,
      metadata: probe.metadata,
    }))
  }
  return results
}

async function executeRecipeProbe(runtime: Runtime, probe: WorkspaceRecipeProbe, recipeDirectory: string, index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(probe.step, recipeDirectory))
    return withRecipeExecutionPhase(execution, "setup", index, `recipe.probe:${probe.name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe probe "${probe.name}" failed before producing a result: ${message}`, { cause: error })
  }
}

async function collectRecipeDeclaredArtifacts(recipe: WorkspaceRecipe, runtime: Runtime): Promise<RecipeRunDeclaredArtifact[]> {
  const results: RecipeRunDeclaredArtifact[] = []
  for (const [index, artifact] of (recipe.artifacts?.paths ?? []).entries()) {
    results.push(await collectRecipeDeclaredArtifact(runtime, artifact, index))
  }
  return results
}

async function collectRecipeDeclaredArtifact(runtime: Runtime, artifact: WorkspaceRecipeDeclaredArtifact, index: number): Promise<RecipeRunDeclaredArtifact> {
  const required = artifact.required !== false
  try {
    const execution = await runtime.execute({
      command: "wordpress.run-php",
      args: [`code=${declaredArtifactReadCode(artifact.path, artifact.parseJson === true)}`],
    })
    const collected = JSON.parse(execution.stdout.trim() || "{}") as Record<string, unknown>
    const exists = collected.exists === true
    return stripUndefined({
      schema: "wp-codebox/recipe-declared-artifact-result/v1" as const,
      index,
      name: artifact.name,
      path: artifact.path,
      required,
      status: exists ? "collected" as const : "missing" as const,
      exists,
      type: collected.type,
      size: collected.size,
      sha256: collected.sha256,
      parsedJson: collected.parsedJson,
      metadata: artifact.metadata,
    }) as RecipeRunDeclaredArtifact
  } catch (error) {
    return stripUndefined({
      schema: "wp-codebox/recipe-declared-artifact-result/v1" as const,
      index,
      name: artifact.name,
      path: artifact.path,
      required,
      status: "failed" as const,
      exists: false,
      error: serializeRecipeRunError(error),
      metadata: artifact.metadata,
    }) as RecipeRunDeclaredArtifact
  }
}

function recipeProbeFailure(probes: RecipeRunProbe[]): RecipeProbeFailureError | undefined {
  return probes.some((probe) => probe.status === "failed" && !probe.allowFailure) ? new RecipeProbeFailureError(probes) : undefined
}

function recipeDeclaredArtifactFailure(declaredArtifacts: RecipeRunDeclaredArtifact[]): RecipeDeclaredArtifactFailureError | undefined {
  return declaredArtifacts.some((artifact) => artifact.required && artifact.status !== "collected") ? new RecipeDeclaredArtifactFailureError(declaredArtifacts) : undefined
}

function recipeRuntimeEvidenceFiles(fixtureDatabases: RecipeRunFixtureDatabase[], probes: RecipeRunProbe[], declaredArtifacts: RecipeRunDeclaredArtifact[]): Array<{ filename: string; kind: string; value: unknown }> {
  return [
    ...(fixtureDatabases.length > 0 ? [{ filename: "fixture-databases.json", kind: "fixture-database-results", value: { schema: "wp-codebox/fixture-database-results/v1", fixtures: fixtureDatabases } }] : []),
    ...(probes.length > 0 ? [{ filename: "recipe-probes.json", kind: "recipe-probe-results", value: { schema: "wp-codebox/recipe-probe-results/v1", passed: !recipeProbeFailure(probes), probes } }] : []),
    ...(declaredArtifacts.length > 0 ? [{ filename: "recipe-declared-artifacts.json", kind: "recipe-declared-artifact-results", value: { schema: "wp-codebox/recipe-declared-artifact-results/v1", passed: !recipeDeclaredArtifactFailure(declaredArtifacts), artifacts: declaredArtifacts } }] : []),
  ]
}

function parseFixtureDatabaseImportResult(stdout: string): { counts: Record<string, number> } {
  const parsed = JSON.parse(stdout.trim() || "{}") as { counts?: Record<string, unknown> }
  const counts: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed.counts ?? {})) {
    if (typeof value === "number") {
      counts[key] = value
    }
  }
  return { counts }
}

function parseProbeJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return undefined
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function fixtureDatabaseImportCode(fixture: WorkspaceRecipeFixtureDatabase, sql: string, reset: RecipeRunFixtureDatabase["reset"]): string {
  const encodedSql = JSON.stringify(sql)
  const encodedTables = JSON.stringify(reset.tables)
  const encodedResetStrategy = JSON.stringify(reset.strategy)
  const encodedName = JSON.stringify(fixture.name)
  const encodedVersion = JSON.stringify(fixture.version)
  return `
global $wpdb;
$fixture_name = ${encodedName};
$fixture_version = ${encodedVersion};
$reset_strategy = ${encodedResetStrategy};
$reset_tables = json_decode(${JSON.stringify(encodedTables)}, true);
$sql = ${encodedSql};
$counts = array('resetTables' => 0, 'statements' => 0);
if (!is_array($reset_tables)) {
    throw new RuntimeException('Fixture database reset tables must be an array.');
}
if ('truncate-tables' === $reset_strategy) {
    foreach ($reset_tables as $table) {
        $table = (string) $table;
        if (!preg_match('/^[A-Za-z0-9_$]+$/', $table)) {
            throw new RuntimeException('Fixture database reset table has an unsafe name: ' . $table);
        }
        $reset_result = $wpdb->query('DELETE FROM ' . $table);
        if (false === $reset_result && !str_contains(strtolower((string) $wpdb->last_error), 'no such table')) {
            throw new RuntimeException('Fixture database reset failed for ' . $table . ': ' . $wpdb->last_error);
        }
        $counts['resetTables']++;
    }
}
$statements = preg_split('/;\s*(?:\r?\n|$)/', $sql);
foreach ($statements as $statement) {
    $statement = trim($statement);
    if ('' === $statement || str_starts_with($statement, '--')) {
        continue;
    }
    $result = $wpdb->query($statement);
    if (false === $result) {
        throw new RuntimeException('Fixture database import failed for ' . $fixture_name . '@' . $fixture_version . ': ' . $wpdb->last_error);
    }
    $counts['statements']++;
}
echo wp_json_encode(array('counts' => $counts));`
}

function declaredArtifactReadCode(path: string, parseJson: boolean): string {
  const encodedPath = JSON.stringify(path)
  return `
$path = ${encodedPath};
$parse_json = ${parseJson ? "true" : "false"};
$result = array('exists' => file_exists($path));
if (!$result['exists']) {
    echo wp_json_encode($result);
    return;
}
$result['type'] = is_dir($path) ? 'directory' : (is_file($path) ? 'file' : 'other');
if (is_file($path)) {
    $contents = file_get_contents($path);
    if (false === $contents) {
        throw new RuntimeException('Unable to read declared artifact path: ' . $path);
    }
    $result['size'] = strlen($contents);
    $result['sha256'] = hash('sha256', $contents);
    if ($parse_json) {
        $decoded = json_decode($contents, true);
        if (JSON_ERROR_NONE !== json_last_error()) {
            throw new RuntimeException('Declared artifact JSON parse failed for ' . $path . ': ' . json_last_error_msg());
        }
        $result['parsedJson'] = $decoded;
    }
} elseif (is_dir($path)) {
    $entries = array_values(array_diff(scandir($path) ?: array(), array('.', '..')));
    sort($entries);
    $result['size'] = count($entries);
    $result['sha256'] = hash('sha256', wp_json_encode($entries));
}
echo wp_json_encode($result);`
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

function phaseFixtureDatabaseData(recipe: WorkspaceRecipe): Record<string, unknown> {
  const fixtures = recipe.inputs?.fixtureDatabases ?? []
  return {
    count: fixtures.length,
    fixtures: fixtures.map((fixture, index) => ({
      index,
      name: fixture.name,
      version: fixture.version,
      format: fixture.format ?? "sql",
      resetStrategy: fixture.reset?.strategy ?? "truncate-tables",
      resetTables: fixture.reset?.tables ?? [],
    })),
  }
}

function phaseProbeData(recipe: WorkspaceRecipe): Record<string, unknown> {
  const probes = recipe.probes ?? []
  return {
    count: probes.length,
    probes: probes.map((probe, index) => ({
      index,
      name: probe.name,
      command: probe.step.command,
      expectJson: probe.expectJson === true,
      allowFailure: probe.allowFailure === true,
    })),
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

  const phpWasmDiagnostic = phpWasmRuntimeDiagnostic(error)
  if (phpWasmDiagnostic) {
    diagnostics.push(phpWasmDiagnostic)
  }

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

  if ((recipe.inputs?.pluginRuntime || recipe.runtime?.overlays || recipe.runtime?.backendPackage || message.includes("plugin runtime") || message.includes("runtime overlay") || message.includes("backend package")) && diagnostics.length === 0) {
    diagnostics.push({
      schema: "wp-codebox/plugin-runtime-diagnostic/v1",
      severity: "error",
      phase: message.includes("backend package") ? "backend-preparation" : message.includes("runtime overlay") ? "overlay-preparation" : message.includes("health probe") ? "health-probe" : message.includes("setup") ? "setup" : "runtime",
      message,
    })
  }

  return diagnostics.length > 0 ? diagnostics : undefined
}

function phpWasmRuntimeDiagnostic(error: unknown): RecipePhpWasmRuntimeDiagnostic | undefined {
  const candidate = phpWasmRuntimeErrorCandidate(error)
  if (!candidate) {
    return undefined
  }

  const diagnostic = candidate.diagnostic && typeof candidate.diagnostic === "object" && !Array.isArray(candidate.diagnostic)
    ? candidate.diagnostic as Record<string, unknown>
    : undefined

  return {
    schema: "wp-codebox/php-wasm-runtime-diagnostic/v1",
    severity: "error",
    phase: "preflight",
    message: typeof candidate.message === "string" ? candidate.message : "PHP wasm runtime asset preflight failed.",
    ...(diagnostic ? { runtime: diagnostic } : {}),
    ...(typeof candidate.repair === "string" ? { repair: candidate.repair } : {}),
  }
}

function phpWasmRuntimeErrorCandidate(error: unknown): { message?: unknown; code?: unknown; diagnostic?: unknown; repair?: unknown; cause?: unknown } | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }

  const candidate = error as { message?: unknown; code?: unknown; diagnostic?: unknown; repair?: unknown; cause?: unknown }
  if (candidate.code === "wp-codebox-php-wasm-runtime-asset-invalid") {
    return candidate
  }

  return phpWasmRuntimeErrorCandidate(candidate.cause)
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

function effectiveRecipePreview(recipePreview: RuntimePreviewSpec | undefined, options: RecipeRunOptions): RuntimePreviewSpec {
  return stripUndefined({
    publicUrl: options.previewPublicUrl ?? recipePreview?.publicUrl,
    siteUrl: recipePreview?.siteUrl,
    port: options.previewPort ?? recipePreview?.port,
    bind: options.previewBind ?? recipePreview?.bind,
  })
}

function recipeRunMetadata(recipe: WorkspaceRecipe, recipePath: string, workspaceMounts: PreparedWorkspaceMount[], extraPlugins: PreparedExtraPlugin[], dependencyOverlays: PreparedDependencyOverlay[], stagedFiles: PreparedStagedFile[], overlays: PreparedRuntimeOverlay[], backendPackage: PreparedRuntimeBackendPackage | undefined, preview: RuntimePreviewSpec): Record<string, unknown> {
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
        dependency_overlays: recipe.inputs?.dependency_overlays ?? [],
        pluginRuntime: recipe.inputs?.pluginRuntime ?? {},
        fixtureDatabases: recipe.inputs?.fixtureDatabases ?? [],
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
      preview: stripUndefined({
        requested: recipe.runtime?.preview,
        effective: preview,
        source: previewMetadataSource(recipe.runtime?.preview, preview),
        cliOverrides: previewCliOverrides(recipe.runtime?.preview, preview),
      }),
      workflow,
      probes: recipe.probes ?? [],
      inputs: {
        workspaces: recipe.inputs?.workspaces ?? [],
        mounts: recipe.inputs?.mounts ?? [],
        extra_plugins: extraPluginMetadata,
        dependency_overlays: recipe.inputs?.dependency_overlays ?? [],
        pluginRuntime: recipe.inputs?.pluginRuntime ?? {},
        fixtureDatabases: recipe.inputs?.fixtureDatabases ?? [],
        siteSeeds: recipe.inputs?.siteSeeds ?? [],
        siteSeedProvenance,
        stagedFiles: recipe.inputs?.stagedFiles ?? [],
        stagedFileProvenance,
        secretEnv: recipe.inputs?.secretEnv ?? [],
        inherit: recipe.inputs?.inherit ?? {},
        inheritance: recipe.inputs?.inheritance ?? {},
      },
      artifacts: {
        paths: recipe.artifacts?.paths ?? [],
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
    preparedDependencyOverlays: dependencyOverlays.map(recipeRunDependencyOverlay),
    preparedRuntimeOverlays: overlays.map((overlay) => ({
      target: overlay.target,
      type: overlay.type,
      mode: overlay.mode,
      metadata: overlay.metadata,
    })),
    ...(backendPackage ? { preparedRuntimeBackend: backendPackage.provenance } : {}),
  }
}

async function inputMountMetadataWithBaseline(source: string, mount: WorkspaceRecipeMount, cleanupPaths: string[]): Promise<Record<string, unknown> | undefined> {
  const metadata = mount.metadata ? { ...mount.metadata } : {}
  if ((mount.mode ?? "readwrite") !== "readwrite") {
    return Object.keys(metadata).length > 0 ? metadata : undefined
  }
  if (typeof metadata.baselineSource === "string" && metadata.baselineSource.length > 0) {
    return metadata
  }

  let sourceStats
  try {
    sourceStats = await stat(source)
  } catch {
    return Object.keys(metadata).length > 0 ? metadata : undefined
  }
  if (!sourceStats.isDirectory() || await hasGitMetadata(source)) {
    return Object.keys(metadata).length > 0 ? metadata : undefined
  }

  const baselineSource = await mkdtemp(join(tmpdir(), "wp-codebox-input-mount-baseline-"))
  cleanupPaths.push(baselineSource)
  await cp(source, baselineSource, {
    recursive: true,
    filter: (entry) => shouldCopyInputMountBaselineEntry(source, entry),
  })
  metadata.baselineSource = baselineSource
  metadata.baselineStrategy = "input-mount-snapshot"
  return metadata
}

async function cleanupInputMountBaselines(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
  paths.length = 0
}

async function hasGitMetadata(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"))
    return true
  } catch {
    return false
  }
}

function shouldCopyInputMountBaselineEntry(sourceRoot: string, entry: string): boolean {
  const relativePath = entry.slice(sourceRoot.length).replace(/^\/+/, "")
  if (!relativePath) {
    return true
  }
  const firstSegment = relativePath.split("/")[0]
  return firstSegment !== ".git" && firstSegment !== "node_modules"
}

function recipeRunDependencyOverlay(overlay: PreparedDependencyOverlay): Record<string, unknown> {
  return {
    source: overlay.source,
    sourceRef: overlay.sourceRef,
    target: overlay.target,
    package: overlay.package,
    consumer: overlay.consumer,
    type: overlay.type,
    mode: overlay.mode,
    metadata: overlay.metadata,
  }
}

function previewCliOverrides(recipePreview: RuntimePreviewSpec | undefined, effectivePreview: RuntimePreviewSpec): RuntimePreviewSpec | undefined {
  const overrides = stripUndefined({
    publicUrl: recipePreview?.publicUrl !== effectivePreview.publicUrl ? effectivePreview.publicUrl : undefined,
    port: recipePreview?.port !== effectivePreview.port ? effectivePreview.port : undefined,
    bind: recipePreview?.bind !== effectivePreview.bind ? effectivePreview.bind : undefined,
  })
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

function previewMetadataSource(recipePreview: RuntimePreviewSpec | undefined, effectivePreview: RuntimePreviewSpec): string | undefined {
  if (Object.keys(effectivePreview).length === 0) {
    return undefined
  }

  return recipePreview ? "recipe-runtime-preview" : "cli-preview-options"
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
