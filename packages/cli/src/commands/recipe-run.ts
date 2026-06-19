import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { DEFAULT_WORDPRESS_VERSION, createRuntime, normalizeRuntimeEnvRecord, parseCommandOptions, resolveSecretEnvNames, type ArtifactBundle, type Runtime, type RuntimeAssetSpec, type RuntimePreviewSpec, type RuntimeRunRegistry, type WorkspaceRecipe, type WorkspaceRecipeComponentManifest, type WorkspaceRecipeExtraPlugin, type WorkspaceRecipeFixtureDatabase } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { recipeExecutionSpec, sandboxWorkspaceContract } from "../agent-sandbox.js"
import { captureStdout, printRecipeHumanOutput, printRecipeValidateHumanOutput, serializeError } from "../output.js"
import { parsePreviewBind, parsePreviewHoldSeconds, parsePreviewPort, parsePreviewPublicUrl } from "../preview-options.js"
import { dryRunRecipe, planWorkspaceRecipe, recipeDryRunSiteSeeds } from "../recipe-dry-run.js"
import { appendRecipeRuntimeEvidence, collectAndFinalizeFailedRecipeArtifacts, collectRecipeRuntimeArtifacts, finalizeAgentSandboxEvidence, finalizeRecipeArtifactEvidence, recipeAgentResultFailure, recipeArtifactEvidenceFailure, recipeReplayStatusOutput, recipeVerifyStepFailure } from "../recipe-evidence.js"
import type { PreparedRuntimeBackendPackage } from "../recipe-backend-package.js"
import { cleanupRecipePreparedSources, recipeBlueprintWithBootActivePlugins, recipeExtraPlugins, type PreparedDependencyOverlay, type PreparedExtraPlugin, type PreparedRuntimeOverlay, type PreparedStagedFile, type PreparedWorkspaceMount } from "../recipe-sources.js"
import { loadWorkspaceRecipe, recipePolicy, recipeWorkflowSteps, validateWorkspaceRecipe, type RecipeWorkflowPhase } from "../recipe-validation.js"
import { resolveCliRuntimeBackend } from "../runtime-backends.js"
import { previewSpec, releaseRuntime, runtimeMetadata, type RunOutput } from "../runtime-command-wrappers.js"
import { artifactManifestFilesByPath, parseBenchResults, writeBenchmarkArtifactEvidence } from "./recipe-run-benchmark-artifacts.js"
import { createRecipeRunContext } from "./recipe-run-context.js"
import { collectRecipeDeclaredArtifacts, materializeTypedRecipeDeclaredArtifacts, recipeDeclaredArtifactFailure, recipeProbeFailure, recipeRuntimeEvidenceFiles } from "./recipe-declared-artifacts.js"
import { completedRecipeOutputFields, finalizeCompletedRecipeRun, finalizeRecipeValidationFailure, finalizeRecoveredRecipeFailure, runRecipeCleanup, type RunResourceCleanupEvidence } from "./recipe-run-finalizer.js"
import { RecipeRunPhaseExecutor } from "./recipe-run-phase-executor.js"
import { createRecipeInterruptionController, interruptedRecipeOutput, markRecipeArtifactsFinalized, recipeInterruptionSerializedError } from "./recipe-run-interruption.js"
import { bestEffortTimeout, exitAfterPlaygroundCliBootFailure, exitAfterRecipeRunTimeout, exitAfterTerminalRecipePhaseFailure, printJsonFailureDiagnostic, RecipeRunTimeoutError, RecipeRuntimeCreateError, serializeRecipeRunError, writeRecipeJsonOutput } from "./recipe-run-output.js"
import { RecipePhaseError } from "./recipe-run-phases.js"
import { importRecipeSiteSeeds } from "./recipe-site-seeds.js"
import { applyRecipeRuntimeSetup, cleanupInputMountBaselines, prepareRecipeRuntimeSetup, recipeRunDependencyOverlay, recipeRunExtraPlugin, recipeRunStagedFile } from "./recipe-runtime-setup.js"
import { distributionStartupProbeFailure, executeRecipeWorkflowStep, recipeAdvisoryFailure, recipeBrowserEvidence, recipeWorkflowStepIsAdvisory, runDistributionSetupArtifacts, runDistributionStartupProbes, runRecipeProbes, withRecipeExecutionPhase } from "./recipe-run-workflow-evidence.js"
import type { RecipeAdvisoryFailure, RecipeBrowserEvidence, RecipeDiagnosticArtifactRef, RecipeExecutionResult, RecipeInterruptionController, RecipePhaseEvidence, RecipePhaseName, RecipePhpWasmRuntimeDiagnostic, RecipeRunCommandOutput, RecipeRunComponentContract, RecipeRunDeclaredArtifact, RecipeRunDistributionSetupArtifact, RecipeRunDistributionStartupProbe, RecipeRunFixtureDatabase, RecipeRunOptions, RecipeRunOutput, RecipeRunProbe, RecipeRunStagedFile, RecipeRuntimeDiagnostic, RecipeValidateOptions, RecipeValidateOutput } from "./recipe-run-types.js"

const DEFAULT_RECIPE_RUN_TIMEOUT_MS = 25 * 60 * 1000
const SUCCESSFUL_RECIPE_RUNTIME_SNAPSHOT_TIMEOUT_MS = 120 * 1000
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
      issues,
    }
    return await finalizeRecipeValidationFailure({
      recipePath,
      runRegistry,
      runRecord,
      artifactPointer,
      startedAtMs,
      failure,
      componentContracts: componentContractResults(recipe, [], [], [], failure),
      validation: { issues },
    })
  }

  const plan = await planWorkspaceRecipe(recipe, recipeDirectory, { recipePath, artifactsDirectory: configuredArtifactsDirectory }, { defaultWordPressVersion: DEFAULT_WORDPRESS_VERSION, resolveExecutionSpec: recipeExecutionSpec })
  const { valid: _policyValid, issues: _policyIssues, ...policy } = plan.policy
  const runtimeEnv = normalizeRuntimeEnv(recipe.inputs?.runtimeEnv ?? {})
  const secretEnv = resolveSecretEnvNames(recipe.inputs?.secretEnv ?? [], { field: "--secret-env name" })
  const effectivePolicy = Object.keys(secretEnv).length > 0 ? { ...policy, secrets: "connector-scoped" as const } : policy
  let workspaceMounts: PreparedWorkspaceMount[] = []
  let extraPlugins: PreparedExtraPlugin[] = []
  let dependencyOverlays: PreparedDependencyOverlay[] = []
  let stagedFiles: PreparedStagedFile[] = []
  let overlays: PreparedRuntimeOverlay[] = []
  let inputMountBaselinePaths: string[] = []
  let backendPackage: PreparedRuntimeBackendPackage | undefined
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  const executions: RecipeExecutionResult[] = []
  let fixtureDatabases: RecipeRunFixtureDatabase[] = []
  let distributionSetupArtifacts: RecipeRunDistributionSetupArtifact[] = []
  let distributionStartupProbes: RecipeRunDistributionStartupProbe[] = []
  let probes: RecipeRunProbe[] = []
  let declaredArtifacts: RecipeRunDeclaredArtifact[] = []
  let advisoryFailures: RecipeAdvisoryFailure[] = []
  let browserEvidence: RecipeBrowserEvidence[] = []
  let artifacts: ArtifactBundle | undefined
  let startupDurationMs: number | undefined
  let cleanupEvidence: RunResourceCleanupEvidence | undefined
  let runtimeDestroyed = false
  const destroyActiveRuntime = async (): Promise<void> => {
    if (!runtime || runtimeDestroyed) {
      return
    }

    runtimeDestroyed = true
    await bestEffortTimeout(runtime.destroy(), 2_000)
  }
  const phaseExecutor = new RecipeRunPhaseExecutor({ context, timeoutMs: options.timeoutMs, interruption, destroyActiveRuntime })
  const phaseTracker = phaseExecutor.tracker
  const awaitRecipe = <T>(operation: string, promiseOrFactory: Promise<T> | (() => Promise<T>), timeoutMs?: number): Promise<T> => phaseExecutor.operation(operation, promiseOrFactory, timeoutMs)
  const cancellationWatcher = interruption ? watchRunCancellationRequests(runRegistry, runRecord.runId, interruption) : undefined

  try {
    const preparedRuntimeSetup = await prepareRecipeRuntimeSetup(recipe, recipeDirectory, plan.runtime.backend)
    ;({ workspaceMounts, extraPlugins, dependencyOverlays, stagedFiles, overlays, inputMountBaselinePaths, backendPackage } = preparedRuntimeSetup)
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
        resolveCliRuntimeBackend(runtimeCreateSpec.backend, backendPackage?.runtimeBackendContext),
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

    executions.push(...(await applyRecipeRuntimeSetup({ recipe, recipeDirectory, runtime, prepared: preparedRuntimeSetup, phaseExecutor, interruption })).executions)

    fixtureDatabases = await phaseTracker.run("import_fixture_databases", phaseFixtureDatabaseData(recipe), async () => await awaitRecipe("fixture-databases.import", importRecipeFixtureDatabases(recipe, recipeDirectory, runtime!, executions)))
    const siteSeeds = await awaitRecipe("site-seeds.import", importRecipeSiteSeeds(recipe, recipeDirectory, runtime!, executions))
    distributionSetupArtifacts = await phaseTracker.run("run_distribution_setup_artifacts", phaseDistributionSetupArtifactData(recipe), async () => await awaitRecipe("distribution.setup-artifacts.run", runDistributionSetupArtifacts(recipe, recipeDirectory, runtime!, executions)))
    interruption?.throwIfInterrupted()

    const sandboxWorkspace = sandboxWorkspaceContract(workspaceMounts, recipe.inputs?.mounts ?? [])
    const workflowSteps = recipeWorkflowSteps(recipe)
    distributionStartupProbes = await phaseTracker.run("run_distribution_startup_probes", phaseDistributionStartupProbeData(recipe), async () => await awaitRecipe("distribution.startup-probes.run", runDistributionStartupProbes(recipe, runtime!, executions)))
    const startupProbeFailure = distributionStartupProbeFailure(distributionStartupProbes)
    if (startupProbeFailure) {
      throw startupProbeFailure
    }
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
      await materializeTypedRecipeDeclaredArtifacts(artifacts, declaredArtifacts)
      await appendRecipeRuntimeEvidence(artifacts, recipeRuntimeEvidenceFiles(fixtureDatabases, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts))
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
      declaredArtifacts = await collectRecipeDeclaredArtifacts(recipe, runtime)
      await materializeTypedRecipeDeclaredArtifacts(artifacts, declaredArtifacts)
      await appendRecipeRuntimeEvidence(artifacts, recipeRuntimeEvidenceFiles(fixtureDatabases, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts))
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
      const finalRuntimeInfo = runtimeInfo ?? await runtime.info()
      return await finalizeCompletedRecipeRun({
        success: false,
        recipePath,
        runRegistry,
        runRecord,
        artifactPointer,
        startedAtMs,
        runtime: finalRuntimeInfo,
        artifacts,
        startupDurationMs,
        cleanup: cleanupEvidence,
        phaseEvidence: phaseTracker.list(),
        browserEvidence,
        replayStatus: evidence.replayStatus ? recipeReplayStatusOutput(evidence.replayStatus) : undefined,
        failure: recipeFailure,
        output: completedRecipeOutputFields({ executions, componentContracts: componentContractResults(recipe, extraPlugins, phaseTracker.list(), executions), stagedFiles: stagedFiles.map(recipeRunStagedFile), fixtureDatabases, siteSeeds, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts, phaseEvidence: phaseTracker.list(), advisoryFailures, browserEvidence, benchResultsList, evidence }),
      })
    }

    const finalRuntimeInfo = runtimeInfo ?? await runtime.info()
    return await finalizeCompletedRecipeRun({
      success: true,
      recipePath,
      runRegistry,
      runRecord,
      artifactPointer,
      startedAtMs,
      runtime: finalRuntimeInfo,
      artifacts,
      startupDurationMs,
      cleanup: cleanupEvidence,
      phaseEvidence: phaseTracker.list(),
      browserEvidence,
      replayStatus: evidence.replayStatus ? recipeReplayStatusOutput(evidence.replayStatus) : undefined,
      output: completedRecipeOutputFields({ executions, componentContracts: componentContractResults(recipe, extraPlugins, phaseTracker.list(), executions), stagedFiles: stagedFiles.map(recipeRunStagedFile), fixtureDatabases, siteSeeds, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts, phaseEvidence: phaseTracker.list(), advisoryFailures, browserEvidence, benchResultsList, evidence }),
    })
  } catch (error) {
    const serializedError = interruption?.metadata ? recipeInterruptionSerializedError(interruption.metadata) : serializeRecipeRunError(error)
    const failureDiagnostics = recipeFailureRuntimeEvidenceFile({
      recipe,
      recipePath,
      extraPlugins,
      dependencyOverlays,
      workspaceMounts,
      stagedFiles,
      overlays,
      executions,
      fixtureDatabases,
      distributionSetupArtifacts,
      distributionStartupProbes,
      probes,
      declaredArtifacts,
      phaseEvidence: phaseTracker.list(),
      diagnostics: recipeRuntimeDiagnostics(recipe, executions, error) ?? [],
      error: serializedError,
    })
    let diagnosticArtifacts: RecipeDiagnosticArtifactRef[] = []
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
        const collectedArtifacts = artifacts
        browserEvidence = await recipeBrowserEvidence(artifacts, executions)
        await artifactPointer.update({ runtime: await activeRuntime.info(), artifacts, phases: phaseTracker.list(), browserEvidence })
        try {
          if (declaredArtifacts.length === 0) {
            declaredArtifacts = await collectRecipeDeclaredArtifacts(recipe, activeRuntime)
          }
          await materializeTypedRecipeDeclaredArtifacts(artifacts, declaredArtifacts)
          const evidenceFiles = await appendRecipeRuntimeEvidence(artifacts, [
            ...recipeRuntimeEvidenceFiles(fixtureDatabases, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts),
            failureDiagnostics,
          ])
          diagnosticArtifacts = evidenceFiles
            .filter((file) => file.kind === failureDiagnostics.kind)
            .map((file) => ({ path: join(basename(collectedArtifacts.directory), file.path), kind: file.kind, contentType: file.contentType, sha256: file.sha256 }))
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

    if (diagnosticArtifacts.length === 0) {
      const fallbackDiagnostic = await writeRecipeFailureDiagnosticArtifact(configuredArtifactsDirectory, failureDiagnostics.value)
      diagnosticArtifacts = fallbackDiagnostic ? [fallbackDiagnostic] : []
    }

    cleanupEvidence = await runRecipeCleanup(runRegistry, runRecord, async () => {
      await cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles, overlays, dependencyOverlays)
      await cleanupInputMountBaselines(inputMountBaselinePaths)
    })
    runRecord = await runRegistry.read(runRecord.runId)
    return await finalizeRecoveredRecipeFailure({
      recipePath,
      runRegistry,
      runRecord,
      artifactPointer,
      startedAtMs,
      originalError: error,
      serializedError,
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(artifacts ? { artifacts } : {}),
      startupDurationMs,
      cleanup: cleanupEvidence,
      phaseEvidence: phaseTracker.list(),
      browserEvidence,
      diagnosticArtifacts,
      interruption,
      output: {
        executions,
        componentContracts: componentContractResults(recipe, extraPlugins, phaseTracker.list(), executions, error),
        stagedFiles: stagedFiles.map(recipeRunStagedFile),
        fixtureDatabases,
        distributionSetupArtifacts,
        distributionStartupProbes,
        probes,
        declaredArtifacts,
        phaseEvidence: phaseTracker.list(),
        ...(advisoryFailures.length > 0 ? { advisoryFailures } : {}),
        ...(browserEvidence.length > 0 ? { browserEvidence } : {}),
        diagnostics: recipeRuntimeDiagnostics(recipe, executions, error),
      },
    })
  } finally {
    cancellationWatcher?.dispose()
  }
}

function watchRunCancellationRequests(runRegistry: RuntimeRunRegistry, runId: string, interruption: RecipeInterruptionController): { dispose(): void } {
  let disposed = false
  let checking = false
  const check = async (): Promise<void> => {
    if (disposed || checking || interruption.metadata) {
      return
    }
    checking = true
    try {
      const record = await runRegistry.read(runId)
      if (record.lifecycle.cancelRequested && !record.lifecycle.terminal) {
        interruption.requestCancellation()
      }
    } catch {
      // Cancellation polling must not replace the primary recipe-run failure.
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => {
    void check()
  }, 1_000)
  timer.unref()
  void check()
  return {
    dispose() {
      disposed = true
      clearInterval(timer)
    },
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

function normalizeRuntimeEnv(values: Record<string, unknown>): Record<string, string> {
  return normalizeRuntimeEnvRecord(values, { field: "inputs.runtimeEnv", invalid: "omit" })
}

function parseRecipeRunOptions(args: string[]): RecipeRunOptions {
  const parsed = parseCommandOptions(args, new Set(["--json", "--dry-run", "--preview-hold-blocking"]))
  if (parsed.positionals.length > 0) {
    throw new Error(`Invalid argument: ${parsed.positionals[0]}`)
  }
  const options: Partial<RecipeRunOptions> = {
    json: parsed.options.get("--json") === true,
    dryRun: parsed.options.get("--dry-run") === true,
    previewHoldBlocking: parsed.options.get("--preview-hold-blocking") === true,
    timeoutMs: DEFAULT_RECIPE_RUN_TIMEOUT_MS,
  }
  for (const [name, value] of parsed.options) {
    if (value === true) {
      continue
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
  const parsed = parseCommandOptions(args, new Set(["--json"]))
  if (parsed.positionals.length > 0) {
    throw new Error(`Invalid argument: ${parsed.positionals[0]}`)
  }
  const options: Partial<RecipeValidateOptions> = { json: parsed.options.get("--json") === true }
  for (const [name, value] of parsed.options) {
    if (value === true) {
      continue
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

function recipeFailureRuntimeEvidenceFile(args: {
  recipe: WorkspaceRecipe
  recipePath: string
  extraPlugins: PreparedExtraPlugin[]
  dependencyOverlays: PreparedDependencyOverlay[]
  workspaceMounts: PreparedWorkspaceMount[]
  stagedFiles: PreparedStagedFile[]
  overlays: PreparedRuntimeOverlay[]
  executions: RecipeExecutionResult[]
  fixtureDatabases: RecipeRunFixtureDatabase[]
  distributionSetupArtifacts: RecipeRunDistributionSetupArtifact[]
  distributionStartupProbes: RecipeRunDistributionStartupProbe[]
  probes: RecipeRunProbe[]
  declaredArtifacts: RecipeRunDeclaredArtifact[]
  phaseEvidence: RecipePhaseEvidence[]
  diagnostics: RecipeRuntimeDiagnostic[]
  error: RunOutput["error"]
}): { filename: string; kind: string; value: unknown } {
  return {
    filename: "recipe-run-failure-diagnostics.json",
    kind: "recipe-run-failure-diagnostics",
    value: stripUndefined({
      schema: "wp-codebox/recipe-run-failure-diagnostics/v1",
      createdAt: new Date().toISOString(),
      recipe: {
        path: args.recipePath,
        schema: args.recipe.schema,
        runtime: args.recipe.runtime ?? {},
        workflow: recipeWorkflowMetadata(args.recipe),
        inputs: {
          extra_plugins: args.extraPlugins.map(recipeRunExtraPlugin),
          dependency_overlays: args.dependencyOverlays.map(recipeRunDependencyOverlay),
          workspaces: args.workspaceMounts.map((workspace) => ({ target: workspace.target, mode: workspace.mode, metadata: workspace.metadata })),
          stagedFiles: args.stagedFiles.map(recipeRunStagedFile),
          secretEnv: args.recipe.inputs?.secretEnv ?? [],
        },
        artifacts: args.recipe.artifacts ?? {},
      },
      preparedRuntimeOverlays: args.overlays.map((overlay) => ({ target: overlay.target, type: overlay.type, mode: overlay.mode, metadata: overlay.metadata })),
      executions: args.executions,
      fixtureDatabases: args.fixtureDatabases,
      distributionSetupArtifacts: args.distributionSetupArtifacts,
      distributionStartupProbes: args.distributionStartupProbes,
      probes: args.probes,
      declaredArtifacts: args.declaredArtifacts,
      phaseEvidence: args.phaseEvidence,
      diagnostics: args.diagnostics,
      error: args.error,
    }),
  }
}

async function writeRecipeFailureDiagnosticArtifact(artifactsDirectory: string | undefined, value: unknown): Promise<RecipeDiagnosticArtifactRef | undefined> {
  if (!artifactsDirectory) {
    return undefined
  }

  const directory = resolve(artifactsDirectory)
  const path = join(directory, "recipe-run-failure-diagnostics.json")
  const contents = `${JSON.stringify(value, null, 2)}\n`
  await mkdir(directory, { recursive: true })
  await writeFile(path, contents)
  return {
    path: "recipe-run-failure-diagnostics.json",
    kind: "recipe-run-failure-diagnostics",
    contentType: "application/json",
    sha256: createHash("sha256").update(contents).digest("hex"),
  }
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

function phaseDistributionStartupProbeData(recipe: WorkspaceRecipe): Record<string, unknown> {
  const probes = recipe.distribution?.startupProbes ?? []
  return {
    count: probes.length,
    probes: probes.map((probe, index) => ({
      index,
      name: probe.name,
      type: probe.type,
      executable: probe.type === "wp-cli" || probe.type === "php" || probe.type === "browser",
    })),
  }
}

function phaseDistributionSetupArtifactData(recipe: WorkspaceRecipe): Record<string, unknown> {
  const artifacts = recipe.distribution?.setupArtifacts ?? []
  return {
    count: artifacts.length,
    artifacts: artifacts.map((artifact, index) => ({
      index,
      name: artifact.name,
      type: artifact.type,
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
    metadata: plugin.metadata,
  }))
  const componentContracts = componentContractResults(recipe, extraPlugins, [], [])
  const componentManifest = recipeComponentManifest(extraPlugins, recipe.inputs?.component_manifest)
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
        component_manifest: componentManifest,
        component_contracts: componentContracts,
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
        component_manifest: componentManifest,
        component_contracts: componentContracts,
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
    preparedComponentContracts: componentContracts,
    ...(backendPackage ? { preparedRuntimeBackend: backendPackage.provenance } : {}),
  }
}

function recipeComponentManifest(extraPlugins: PreparedExtraPlugin[], fallback: WorkspaceRecipeComponentManifest | undefined): Record<string, unknown> | undefined {
  if (extraPlugins.length === 0) {
    return fallback as Record<string, unknown> | undefined
  }

  const components: Record<string, unknown>[] = []
  const providers: Record<string, unknown>[] = []
  for (const plugin of extraPlugins) {
    const contract = recordValue(plugin.metadata?.componentContract)
    const entry = stripUndefined({
      slug: plugin.slug,
      source: plugin.source,
      target: plugin.target,
      pluginFile: plugin.pluginFile,
      loadAs: plugin.loadAs,
      activate: plugin.activate,
      contractIndex: numberValue(contract?.index),
      requestedPath: stringValue(contract?.requestedPath) || undefined,
    })
    if (contract) {
      components.push(entry)
    } else {
      providers.push(entry)
    }
  }

  return {
    schema: "wp-codebox/component-manifest/v1",
    components,
    providers,
  }
}

function componentContractResults(recipe: WorkspaceRecipe, extraPlugins: PreparedExtraPlugin[], phases: RecipePhaseEvidence[], executions: RecipeExecutionResult[], error?: unknown): RecipeRunComponentContract[] | undefined {
  const preparedByIndex = new Map<number, PreparedExtraPlugin>()
  for (const plugin of extraPlugins) {
    const contract = recordValue(plugin.metadata?.componentContract)
    const index = numberValue(contract?.index)
    if (index !== undefined) preparedByIndex.set(index, plugin)
  }

  const contracts = componentContractRecipeEntries(recipe).map(({ contract, plugin }) => {
    const index = numberValue(contract.index) ?? 0
    const prepared = preparedByIndex.get(index)
    return prepared
      ? componentContractResult(prepared, phases, executions)
      : componentContractPreparationFailure(contract, plugin, error)
  })
    .filter((contract): contract is RecipeRunComponentContract => Boolean(contract))

  return contracts.length > 0 ? contracts : undefined
}

function componentContractResult(plugin: PreparedExtraPlugin, phases: RecipePhaseEvidence[], executions: RecipeExecutionResult[]): RecipeRunComponentContract | undefined {
  const contract = recordValue(plugin.metadata?.componentContract)
  if (!contract) return undefined

  const failures = componentContractFailures(plugin, phases, executions)
  const mounted = phaseCompleted(phases, "mount_plugins")
  const activated = plugin.loadAs === "plugin" && plugin.activate !== false && activePluginPhaseIncludes(phases, plugin.pluginFile)
  const activationFailed = failures.some((failure) => failure.phase === "activate_plugins")
  const activationStatus = plugin.loadAs === "mu-plugin"
    ? "not_applicable"
    : plugin.activate === false
      ? "not_requested"
      : activated
        ? "activated"
        : activationFailed
          ? "failed"
          : "pending"

  return stripUndefined({
    schema: "wp-codebox/component-contract-result/v1",
    index: numberValue(contract.index) ?? 0,
    slug: plugin.slug,
    requestedPath: stringValue(contract.requestedPath) || stringValue(plugin.provenance.original) || plugin.source,
    originalPath: stringValue(contract.originalPath) || undefined,
    preparedPath: plugin.source,
    target: plugin.target,
    pluginFile: plugin.pluginFile,
    loadAs: plugin.loadAs,
    activate: plugin.activate,
    status: failures.length > 0 ? "failed" : activated ? "activated" : mounted ? "mounted" : "prepared",
    activationStatus,
    failures,
  }) as RecipeRunComponentContract
}

function componentContractPreparationFailure(contract: Record<string, unknown>, plugin: WorkspaceRecipeExtraPlugin, error: unknown): RecipeRunComponentContract {
  const errorRecord = recordValue(error)
  const message = error instanceof Error ? error.message : stringValue(errorRecord?.message) || String(error || "Component contract was not prepared.")
  const loadAs = stringValue(plugin.loadAs) || stringValue(contract.loadAs) || "mu-plugin"
  return stripUndefined({
    schema: "wp-codebox/component-contract-result/v1",
    index: numberValue(contract.index) ?? 0,
    slug: stringValue(plugin.slug) || stringValue(contract.slug) || "",
    requestedPath: stringValue(contract.requestedPath) || stringValue(plugin.source) || "",
    originalPath: stringValue(contract.originalPath) || undefined,
    preparedPath: stringValue(plugin.source) || stringValue(contract.preparedPath) || undefined,
    target: stringValue(plugin.slug) ? pluginTargetForReport(stringValue(plugin.slug) || "", loadAs) : undefined,
    pluginFile: stringValue(plugin.pluginFile) || undefined,
    loadAs,
    activate: plugin.activate !== false,
    status: "failed",
    activationStatus: "pending",
    failures: [stripUndefined({ phase: "prepare_plugins", message, issues: Array.isArray(errorRecord?.issues) ? errorRecord.issues : undefined })],
  }) as RecipeRunComponentContract
}

function componentContractRecipeEntries(recipe: WorkspaceRecipe): Array<{ contract: Record<string, unknown>; plugin: WorkspaceRecipeExtraPlugin }> {
  return (recipe.inputs?.extra_plugins ?? []).flatMap((plugin) => {
    const contract = recordValue(plugin.metadata?.componentContract)
    return contract ? [{ contract, plugin }] : []
  })
}

function componentContractFailures(plugin: PreparedExtraPlugin, phases: RecipePhaseEvidence[], executions: RecipeExecutionResult[]): Array<Record<string, unknown>> {
  const failures: Array<Record<string, unknown>> = []
  for (const phase of phases) {
    if (phase.status !== "failed" || (phase.name !== "mount_plugins" && phase.name !== "activate_plugins")) continue
    const phasePlugins = Array.isArray(phase.data?.plugins) ? phase.data.plugins.filter((entry): entry is Record<string, unknown> => Boolean(recordValue(entry))) : []
    const phaseTargetsPlugin = phasePlugins.some((entry) => stringValue(entry.slug) === plugin.slug || stringValue(entry.pluginFile) === plugin.pluginFile)
    if (!phaseTargetsPlugin) continue
    failures.push(stripUndefined({
      phase: phase.name,
      message: phase.error?.message,
      code: phase.error?.code,
      pluginFile: plugin.pluginFile,
    }))
  }

  for (const execution of executions) {
    if (execution.exitCode === 0) continue
    const activatesPlugin = execution.recipeCommand === `extra-plugin.activate:${plugin.pluginFile}`
    const installsMuLoader = plugin.loadAs === "mu-plugin" && execution.recipeCommand === "extra-plugin.install-mu-loader"
    if (!activatesPlugin && !installsMuLoader) continue
    failures.push(stripUndefined({
      phase: activatesPlugin ? "activate_plugins" : "mount_plugins",
      command: execution.recipeCommand,
      exitCode: execution.exitCode,
      message: execution.stderr || execution.stdout || `Recipe command failed with exit code ${execution.exitCode}`,
      pluginFile: plugin.pluginFile,
    }))
  }

  return failures
}

function pluginTargetForReport(slug: string, loadAs: string): string {
  return loadAs === "mu-plugin" ? `/wordpress/wp-content/mu-plugins/wp-codebox-runtime/${slug}` : `/wordpress/wp-content/plugins/${slug}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function phaseCompleted(phases: RecipePhaseEvidence[], name: RecipePhaseName): boolean {
  return phases.some((phase) => phase.name === name && phase.status === "completed")
}

function activePluginPhaseIncludes(phases: RecipePhaseEvidence[], pluginFile: string): boolean {
  return phases.some((phase) => phase.name === "activate_plugins" && Array.isArray(phase.data?.activePlugins) && phase.data.activePlugins.includes(pluginFile))
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
