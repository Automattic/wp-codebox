import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, dirname, join, resolve } from "node:path"
import { DEFAULT_WORDPRESS_VERSION, createRuntime, normalizeRecipeRunSummary, normalizeRuntimeEnvRecord, parseCommandOptions, validateRuntimePolicy, type ArtifactBundle, type ArtifactPackageIdentity, type ArtifactPackageProvenance, type Runtime, type RuntimeAssetSpec, type RuntimePolicy, type RuntimePreviewSpec, type RuntimeRunRegistry, type WorkspaceRecipe, type WorkspaceRecipeComponentManifest, type WorkspaceRecipeExtraPlugin, type WorkspaceRecipeFixtureDatabase, type WorkspaceRecipeFuzzCasePhase } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { recipeExecutionSpec, sandboxWorkspaceContract } from "../agent-sandbox.js"
import { captureStdout, printRecipeHumanOutput, printRecipeValidateHumanOutput, serializeError } from "../output.js"
import { parsePreviewBind, parsePreviewHoldSeconds, parsePreviewLease, parsePreviewPort, parsePreviewPublicUrl } from "../preview-options.js"
import { dryRunRecipe, planWorkspaceRecipe, recipeDryRunSiteSeeds } from "../recipe-dry-run.js"
import { appendRecipeRuntimeEvidence, collectAndFinalizeFailedRecipeArtifacts, collectRecipeRuntimeArtifacts, finalizeAgentSandboxEvidence, finalizeRecipeArtifactEvidence, recipeAgentResultFailure, recipeArtifactEvidenceFailure, recipeReplayStatusOutput, recipeVerifyStepFailure } from "../recipe-evidence.js"
import { recipeExternalServiceBoundarySummaries } from "../recipe-external-services.js"
import { resolveRecipeSecretEnv } from "../recipe-secret-env.js"
import type { PreparedRuntimeBackendPackage } from "../recipe-backend-package.js"
import { cleanupRecipePreparedSources, recipeBlueprintWithBootActivePlugins, recipeExtraPlugins, type PreparedDependencyOverlay, type PreparedExtraPlugin, type PreparedRuntimeOverlay, type PreparedStagedFile, type PreparedWorkspaceMount } from "../recipe-sources.js"
import { loadWorkspaceRecipe, recipePolicy, recipeWorkflowSteps, validateRecipeRuntimePolicy, validateWorkspaceRecipe, type RecipeWorkflowPhase } from "../recipe-validation.js"
import { resolveCliRuntimeBackend } from "../runtime-backends.js"
import { previewSpec, releaseRuntime, runtimeMetadata, type RunOutput } from "../runtime-command-wrappers.js"
import { artifactManifestFilesByPath, parseBenchResults, writeBenchmarkArtifactEvidence } from "./recipe-run-benchmark-artifacts.js"
import { createRecipeRunContext } from "./recipe-run-context.js"
import { collectRecipeDeclaredArtifacts, materializeTypedRecipeDeclaredArtifacts, recipeDeclaredArtifactFailure, recipeProbeFailure, recipeRuntimeEvidenceFiles } from "./recipe-declared-artifacts.js"
import { completedRecipeOutputFields, finalizeCompletedRecipeRun, finalizeRecipeValidationFailure, finalizeRecoveredRecipeFailure, runRecipeCleanup, RunResourceCleanupError, type RunResourceCleanupEvidence } from "./recipe-run-finalizer.js"
import { RecipeRunPhaseExecutor } from "./recipe-run-phase-executor.js"
import { RecipeArtifactsMountConflictError, recipeArtifactsMountConflict } from "./recipe-run-artifacts-mount-guard.js"
import { createRecipeInterruptionController, interruptedRecipeOutput, markRecipeArtifactsFinalized, recipeInterruptionSerializedError } from "./recipe-run-interruption.js"
import { bestEffortTimeout, exitAfterPlaygroundCliBootFailure, exitAfterRecipeRunTimeout, exitAfterTerminalRecipePhaseFailure, printJsonFailureDiagnostic, RecipeRunTimeoutError, RecipeRuntimeCreateError, serializeRecipeRunError, writeRecipeJsonOutput, writeRecipeSummaryHumanOutput } from "./recipe-run-output.js"
import { RecipePhaseError } from "./recipe-run-phases.js"
import { markPreviewLeaseAvailable, markPreviewLeaseFailed, markPreviewLeaseReleased, startPreviewLeaseRecipeRun } from "./preview-lease.js"
import { importRecipeSiteSeeds } from "./recipe-site-seeds.js"
import { applyRecipeRuntimeSetup, cleanupInputMountBaselines, prepareRecipeRuntimeSetup, recipeRunDependencyOverlay, recipeRunExtraPlugin, recipeRunStagedFile, rewriteInputMountPathArgs } from "./recipe-runtime-setup.js"
import { provisionRuntimeServices, provisionRuntimeServicesForRecipe, runtimeServiceEvidenceFromError, type RuntimeServiceEvidence } from "../runtime-services.js"
import { distributionStartupProbeFailure, executeRecipeCollectWorkloadResult, executeRecipeWorkflowStep, recipeAdvisoryFailure, recipeBrowserEvidence, recipeStepFailure, recipeWorkflowArgsEvidence, recipeWorkflowStepIsAdvisory, runDistributionSetupArtifacts, runDistributionStartupProbes, runRecipeProbes, withRecipeExecutionPhase } from "./recipe-run-workflow-evidence.js"
import type { RecipeAdvisoryFailure, RecipeBrowserEvidence, RecipeDiagnosticArtifactRef, RecipeEffectiveRecipeArtifact, RecipeExecutionResult, RecipeFuzzCaseCommandRef, RecipeFuzzCaseResult, RecipeFuzzCaseStatus, RecipeFuzzRunResult, RecipeInterruptionController, RecipePhaseEvidence, RecipePhaseName, RecipePhpWasmRuntimeDiagnostic, RecipeRunCommandOutput, RecipeRunComponentContract, RecipeRunDeclaredArtifact, RecipeRunDistributionSetupArtifact, RecipeRunDistributionStartupProbe, RecipeRunFixtureDatabase, RecipeRunOptions, RecipeRunOutput, RecipeRunProbe, RecipeRunProvenance, RecipeRunStagedFile, RecipeRuntimeDiagnostic, RecipeStepFailure, RecipeValidateOptions, RecipeValidateOutput } from "./recipe-run-types.js"

const DEFAULT_RECIPE_RUN_TIMEOUT_MS = 25 * 60 * 1000
const SUCCESSFUL_RECIPE_RUNTIME_SNAPSHOT_TIMEOUT_MS = 120 * 1000
const packageRequire = createRequire(import.meta.url)
export async function runRecipeRunCommand(args: string[]): Promise<number> {
  const options = parseRecipeRunOptions(args)
  if (options.previewLeaseRequested && !options.previewLeaseChild) {
    return startPreviewLeaseRecipeRun({ args, json: options.json, recipePath: options.recipePath, artifactsDirectory: options.artifactsDirectory, runRegistryDirectory: options.runRegistryDirectory, previewHoldSeconds: options.previewHoldSeconds })
  }
  const interruption = options.dryRun ? undefined : createRecipeInterruptionController()
  interruption?.install()
  const execute = (): Promise<RecipeRunCommandOutput> => options.dryRun ? dryRunRecipe(options, { defaultWordPressVersion: DEFAULT_WORDPRESS_VERSION, resolveExecutionSpec: recipeExecutionSpec }) : runRecipe(options, interruption)

  try {
    if (options.summary) {
      const { result } = await captureStdout(execute)
      const output = interruptedRecipeOutput(result, interruption)
      const summary = normalizeRecipeRunSummary(output)
      if (options.json) await writeRecipeJsonOutput(summary)
      else await writeRecipeSummaryHumanOutput(summary)
      interruption?.propagateIfInterrupted()
      exitAfterRecipeRunTimeout(output)
      exitAfterPlaygroundCliBootFailure(output)
      exitAfterTerminalRecipePhaseFailure(output)
      return output.success ? 0 : 1
    }

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

export async function runRecipe(options: RecipeRunOptions, interruption?: RecipeInterruptionController): Promise<RecipeRunOutput> {
  const mountConflictFailure = await recipeArtifactsMountConflictFailure(options)
  if (mountConflictFailure) {
    return mountConflictFailure
  }

  const context = await createRecipeRunContext(options)
  const { recipePath, recipeDirectory, recipe, configuredArtifactsDirectory, runRegistry, artifactPointer, startedAtMs } = context
  let { runRecord } = context
  runRecord = await runRegistry.update(runRecord.runId, { metadata: { provenance: recipeRunProvenance(recipe, recipePath) } })
  await artifactPointer.update({ commandStatus: "queued" })
  const issues = [
    ...await validateWorkspaceRecipe(recipe, recipePath),
    ...validateRecipeRuntimePolicy(recipe, options.policy),
  ]
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
      provenance: recipeRunProvenance(recipe, recipePath),
    })
  }

  const plan = await planWorkspaceRecipe(recipe, recipeDirectory, { recipePath, artifactsDirectory: configuredArtifactsDirectory }, { defaultWordPressVersion: DEFAULT_WORDPRESS_VERSION, resolveExecutionSpec: recipeExecutionSpec })
  const { valid: _policyValid, issues: _policyIssues, ...plannedPolicy } = plan.policy
  const policy = options.policy ?? plannedPolicy
  const runtimeEnv = {
    ...distributionRuntimeEnv(recipe),
    ...normalizeRuntimeEnv(recipe.inputs?.runtimeEnv ?? {}),
  }
  const secretEnvResolution = resolveRecipeSecretEnv(recipe.inputs?.secretEnv ?? [], { field: "--secret-env name" })
  const secretEnv = secretEnvResolution.values
  const effectivePolicy = Object.keys(secretEnv).length > 0 ? { ...policy, secrets: "connector-scoped" as const } : policy
  let workspaceMounts: PreparedWorkspaceMount[] = []
  let extraPlugins: PreparedExtraPlugin[] = []
  let dependencyOverlays: PreparedDependencyOverlay[] = []
  let stagedFiles: PreparedStagedFile[] = []
  let overlays: PreparedRuntimeOverlay[] = []
  let inputMountBaselinePaths: string[] = []
  let inputMountPathMap: NonNullable<Awaited<ReturnType<typeof prepareRecipeRuntimeSetup>>["inputMountPathMap"]> = []
  let backendPackage: PreparedRuntimeBackendPackage | undefined
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  const executions: RecipeExecutionResult[] = []
  let fixtureDatabases: RecipeRunFixtureDatabase[] = []
  let distributionSetupArtifacts: RecipeRunDistributionSetupArtifact[] = []
  let distributionStartupProbes: RecipeRunDistributionStartupProbe[] = []
  let probes: RecipeRunProbe[] = []
  let declaredArtifacts: RecipeRunDeclaredArtifact[] = []
  let stepFailures: RecipeStepFailure[] = []
  let advisoryFailures: RecipeAdvisoryFailure[] = []
  let browserEvidence: RecipeBrowserEvidence[] = []
  let artifacts: ArtifactBundle | undefined
  let startupDurationMs: number | undefined
  let cleanupEvidence: RunResourceCleanupEvidence | undefined
  let managedServices: Awaited<ReturnType<typeof provisionRuntimeServices>> | undefined
  let managedServicesReleased = false
  let serviceEvidence: RuntimeServiceEvidence[] = []
  const releaseManagedServices = async (): Promise<void> => {
    if (!managedServices || managedServicesReleased) return
    await managedServices.release()
    managedServicesReleased = true
  }
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
    ;({ workspaceMounts, extraPlugins, dependencyOverlays, stagedFiles, overlays, inputMountBaselinePaths, inputMountPathMap, backendPackage } = preparedRuntimeSetup)
    interruption?.throwIfInterrupted()

    runRecord = await runRegistry.update(runRecord.runId, { status: "booting" })
    managedServices = await phaseTracker.run("provision_runtime_services", { services: recipe.inputs?.services?.map(({ id, kind }) => ({ id, kind })) ?? [] }, async () => await provisionRuntimeServicesForRecipe(
      recipe.inputs?.services ?? [],
      async (provisioning) => await awaitRecipe("runtime-services.provision", provisioning),
      { signal: interruption?.signal, onEvidence: (evidence) => { serviceEvidence = evidence } },
    ))
    serviceEvidence = managedServices.evidence
    Object.assign(runtimeEnv, managedServices.env)
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
        ...(serviceEvidence.length > 0 ? { managedRuntimeServices: serviceEvidence } : {}),
        ...recipeRunMetadata(recipe, recipePath, workspaceMounts, extraPlugins, dependencyOverlays, stagedFiles, overlays, backendPackage, effectivePreview),
      },
      preview: previewSpec(effectivePreview.publicUrl, effectivePreview.port, effectivePreview.bind, effectivePreview.siteUrl, effectivePreview.lease),
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
        const stepStartedAtMs = Date.now()
        try {
          const execution = await awaitRecipe(operation, async () => workflowStep.step.command === "wordpress.collect-workload-result"
            ? withRecipeExecutionPhase(executeRecipeCollectWorkloadResult(workflowStep.step, executions, new Date().toISOString()), workflowStep.phase, workflowStep.index, workflowStep.step.command, recipeWorkflowArgsEvidence(workflowStep.step.args, workflowStep.step.args), workflowStep.step.metadata)
            : executeRecipeWorkflowStep(runtime!, workflowStep, recipeDirectory, sandboxWorkspace, configuredArtifactsDirectory, options, inputMountPathMap))
          executions.push({ ...execution, ...(recipeWorkflowStepIsAdvisory(workflowStep.step) ? { recipeAdvisory: true } : {}) })
          interruption?.throwIfInterrupted()
        } catch (error) {
          const failure = recipeStepFailure(workflowStep, error, stepStartedAtMs)
          stepFailures.push(failure)
          await artifactPointer.update({ command: operation, commandStatus: "failed", failure: failure.error, phases: phaseTracker.list(), stepFailures })
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
      browserEvidence = await recipeBrowserEvidence(artifacts, executions, recipe)
      await artifactPointer.update({ runtime: await runtime!.info(), artifacts, phases: phaseTracker.list(), browserEvidence })
      await materializeTypedRecipeDeclaredArtifacts(artifacts, declaredArtifacts)
      await appendRecipeRuntimeEvidence(artifacts, recipeRuntimeEvidenceFiles(fixtureDatabases, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts))
      if (declaredArtifactFailure) {
        throw declaredArtifactFailure
      }
      const recipeEvidence = await finalizeRecipeArtifactEvidence(artifacts, recipe, workspaceMounts, stagedFiles, effectivePolicy, secretEnvResolution.summary)
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
      browserEvidence = await recipeBrowserEvidence(artifacts, executions, recipe)
      await artifactPointer.update({ runtime: await runtime.info(), artifacts, phases: phaseTracker.list(), browserEvidence })
      declaredArtifacts = await collectRecipeDeclaredArtifacts(recipe, runtime)
      await materializeTypedRecipeDeclaredArtifacts(artifacts, declaredArtifacts)
      await appendRecipeRuntimeEvidence(artifacts, recipeRuntimeEvidenceFiles(fixtureDatabases, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts))
      evidence = await finalizeRecipeArtifactEvidence(artifacts, recipe, workspaceMounts, stagedFiles, effectivePolicy, secretEnvResolution.summary)
      const previewAgentEvidence = await finalizeAgentSandboxEvidence(artifacts, executions)
      Object.assign(evidence, previewAgentEvidence)
    }
    const runtimeInfo = successfulRecipe && options.previewHoldSeconds ? await runtime.info() : undefined
    if (successfulRecipe && options.previewLeaseChild && options.previewLeaseFile) {
      await markPreviewLeaseAvailable(options.previewLeaseFile, { runId: runRecord.runId, preview: artifacts.preview, holdSeconds: options.previewHoldSeconds })
    }
    const activeRuntime = runtime
    cleanupEvidence = await runManagedServiceCleanup(runRegistry, runRecord, serviceEvidence, false, async () => {
      await awaitRecipe("runtime.release", async () => {
        try {
          await releaseRuntime(activeRuntime, successfulRecipe && options.previewHoldBlocking ? options.previewHoldSeconds : 0, async () => {
            await markPreviewLeaseReleased(options.previewLeaseFile)
          }, interruption)
        } catch (error) {
          if (!options.previewLeaseChild || interruption?.metadata?.reason !== "run-cancellation-request") {
            throw error
          }
          await markPreviewLeaseReleased(options.previewLeaseFile)
          interruption.clear()
        }
      })
      await releaseManagedServices()
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
    const fuzzRunResult = recipeFuzzRunResult(recipe, executions)

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
        output: { ...completedRecipeOutputFields({ executions, componentContracts: componentContractResults(recipe, extraPlugins, phaseTracker.list(), executions), stagedFiles: stagedFiles.map(recipeRunStagedFile), fixtureDatabases, siteSeeds, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts, stepFailures, phaseEvidence: phaseTracker.list(), advisoryFailures, browserEvidence, benchResultsList, fuzzRun: fuzzRunResult, evidence }), provenance: recipeRunProvenance(recipe, recipePath) },
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
      output: { ...completedRecipeOutputFields({ executions, componentContracts: componentContractResults(recipe, extraPlugins, phaseTracker.list(), executions), stagedFiles: stagedFiles.map(recipeRunStagedFile), fixtureDatabases, siteSeeds, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts, stepFailures, phaseEvidence: phaseTracker.list(), advisoryFailures, browserEvidence, benchResultsList, fuzzRun: fuzzRunResult, evidence }), provenance: recipeRunProvenance(recipe, recipePath) },
    })
  } catch (error) {
    const failedServiceEvidence = runtimeServiceEvidenceFromError(error)
    if (failedServiceEvidence) {
      serviceEvidence = failedServiceEvidence
      await runRegistry.update(runRecord.runId, { metadata: { managedRuntimeServices: serviceEvidence } })
    }
    await markPreviewLeaseFailed(options.previewLeaseFile, error)
    const serializedError = interruption?.metadata ? recipeInterruptionSerializedError(interruption.metadata) : serializeRecipeRunError(error)
    const failureDiagnostics = recipeFailureRuntimeEvidenceFile({
      recipe,
      recipePath,
      inputMountPathMap,
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
      stepFailures,
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
        secretEnv: secretEnvResolution.summary,
        executions,
        interruption,
      }))
      if (artifacts) {
        const collectedArtifacts = artifacts
        browserEvidence = await recipeBrowserEvidence(artifacts, executions, recipe)
        await artifactPointer.update({ runtime: await activeRuntime.info(), artifacts, phases: phaseTracker.list(), browserEvidence })
        try {
          if (declaredArtifacts.length === 0) {
            declaredArtifacts = await collectRecipeDeclaredArtifacts(recipe, activeRuntime)
          }
          await materializeTypedRecipeDeclaredArtifacts(artifacts, declaredArtifacts)
          const evidenceFiles = await appendRecipeRuntimeEvidence(artifacts, [
            ...recipeRuntimeEvidenceFiles(fixtureDatabases, distributionSetupArtifacts, distributionStartupProbes, probes, declaredArtifacts),
            recipeEffectiveRecipeEvidenceFile(recipe, recipePath, inputMountPathMap),
            failureDiagnostics,
          ])
          diagnosticArtifacts = evidenceFiles
            .filter((file) => file.kind === failureDiagnostics.kind || file.kind === "recipe-run-effective-recipe")
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
      diagnosticArtifacts = await writeRecipeFailureDiagnosticArtifacts(configuredArtifactsDirectory, [
        recipeEffectiveRecipeEvidenceFile(recipe, recipePath, inputMountPathMap),
        failureDiagnostics,
      ])
    }

    cleanupEvidence = await runManagedServiceCleanup(runRegistry, runRecord, serviceEvidence, true, async () => {
      await releaseManagedServices()
      await cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles, overlays, dependencyOverlays)
      await cleanupInputMountBaselines(inputMountBaselinePaths)
    })
    runRecord = await runRegistry.read(runRecord.runId)
    const fuzzRunResult = recipeFuzzRunResult(recipe, executions)
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
        ...(stepFailures.length > 0 ? { stepFailures } : {}),
        phaseEvidence: phaseTracker.list(),
        ...(advisoryFailures.length > 0 ? { advisoryFailures } : {}),
        ...(browserEvidence.length > 0 ? { browserEvidence } : {}),
        ...(fuzzRunResult ? { fuzzRun: fuzzRunResult } : {}),
        diagnostics: recipeRuntimeDiagnostics(recipe, executions, error),
        provenance: recipeRunProvenance(recipe, recipePath, diagnosticArtifacts),
      },
    })
  } finally {
    if (managedServices && !managedServicesReleased) {
      await managedServices.release().catch(() => undefined)
      await runRegistry.update(runRecord.runId, { metadata: { managedRuntimeServices: managedServices.evidence } }).catch(() => undefined)
    }
    cancellationWatcher?.dispose()
  }
}

export async function runManagedServiceCleanup(
  runRegistry: RuntimeRunRegistry,
  runRecord: Awaited<ReturnType<RuntimeRunRegistry["read"]>>,
  serviceEvidence: RuntimeServiceEvidence[],
  preservePrimaryFailure: boolean,
  cleanup: () => Promise<void>,
): Promise<RunResourceCleanupEvidence> {
  try {
    return await runRecipeCleanup(runRegistry, runRecord, cleanup)
  } catch (error) {
    if (preservePrimaryFailure && error instanceof RunResourceCleanupError) {
      return error.evidence
    }
    throw error
  } finally {
    await runRegistry.update(runRecord.runId, {
      metadata: { managedRuntimeServices: serviceEvidence },
    })
  }
}

async function recipeArtifactsMountConflictFailure(options: RecipeRunOptions): Promise<RecipeRunOutput | undefined> {
  const recipePath = resolve(options.recipePath)
  const recipeDirectory = dirname(recipePath)
  const recipe = await loadWorkspaceRecipe(recipePath)
  const configuredArtifactsDirectory = options.artifactsDirectory ?? recipe.artifacts?.directory
  const conflict = recipeArtifactsMountConflict(recipe, recipeDirectory, configuredArtifactsDirectory)
  if (!conflict) {
    return undefined
  }

  return {
    success: false,
    schema: "wp-codebox/recipe-run/v1",
    recipePath,
    executions: [],
    error: serializeError(new RecipeArtifactsMountConflictError(conflict)),
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

function withRecipeExecutionArgs(execution: RecipeExecutionResult, argsEvidence: RecipeExecutionResult["recipeArgs"]): RecipeExecutionResult {
  return argsEvidence ? { ...execution, recipeArgs: argsEvidence } : execution
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
    const issues = [
      ...await validateWorkspaceRecipe(recipe, recipePath),
      ...validateRecipeRuntimePolicy(recipe, options.policy),
    ]

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

function distributionRuntimeEnv(recipe: WorkspaceRecipe): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(recipe.distribution?.env ?? {})) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      values[name] = value === null ? "" : String(value)
    }
  }

  return normalizeRuntimeEnvRecord(values, { field: "distribution.env", invalid: "omit" })
}

function parseRecipeRunOptions(args: string[]): RecipeRunOptions {
  const parsed = parseCommandOptions(args, new Set(["--json", "--summary", "--summary-only", "--dry-run", "--preview-hold-blocking", "--preview-lease", "--preview-lease-child"]))
  if (parsed.positionals.length > 0) {
    throw new Error(`Invalid argument: ${parsed.positionals[0]}`)
  }
  const options: Partial<RecipeRunOptions> = {
    json: parsed.options.get("--json") === true,
    summary: parsed.options.get("--summary") === true || parsed.options.get("--summary-only") === true,
    dryRun: parsed.options.get("--dry-run") === true,
    previewHoldBlocking: parsed.options.get("--preview-hold-blocking") === true,
    previewLeaseRequested: parsed.options.get("--preview-lease") === true,
    previewLeaseChild: parsed.options.get("--preview-lease-child") === true,
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
      case "--preview-lease-json":
        options.previewLease = parsePreviewLease(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      case "--preview-lease-id":
        options.previewLeaseId = value
        break
      case "--preview-lease-file":
        options.previewLeaseFile = value
        break
      case "--timeout":
        options.timeoutMs = parseRecipeRunTimeoutMs(value)
        break
      case "--policy":
        options.policy = parseRecipePolicy(value)
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

function parseRecipePolicy(value: string): RuntimePolicy {
  const raw = value.trim().startsWith("{") ? value : readFileSync(resolve(value), "utf8")
  const policy = JSON.parse(raw) as unknown
  const result = validateRuntimePolicy(policy)
  if (!result.valid) {
    throw new Error(`Runtime policy is invalid: ${result.issues.map((issue) => issue.message).join("; ")}`)
  }

  return policy as RuntimePolicy
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
      case "--policy":
        options.policy = parseRecipePolicy(value)
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
  inputMountPathMap: NonNullable<Awaited<ReturnType<typeof prepareRecipeRuntimeSetup>>["inputMountPathMap"]>
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
  stepFailures: RecipeStepFailure[]
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
      provenance: recipeRunProvenance(args.recipe, args.recipePath),
      recipe: {
        path: args.recipePath,
        schema: args.recipe.schema,
        sourceSha256: recipeDigest(args.recipe),
        effectiveSha256: recipeDigest(effectiveRecipeForReplay(args.recipe, args.inputMountPathMap)),
        effectiveJson: effectiveRecipeForReplay(args.recipe, args.inputMountPathMap),
        runtime: args.recipe.runtime ?? {},
        workflow: effectiveRecipeWorkflowMetadata(args.recipe, args.inputMountPathMap),
        inputs: {
          extra_plugins: args.extraPlugins.map(recipeRunExtraPlugin),
          dependency_overlays: args.dependencyOverlays.map(recipeRunDependencyOverlay),
          workspaces: args.workspaceMounts.map((workspace) => ({ target: workspace.target, mode: workspace.mode, metadata: workspace.metadata })),
          stagedFiles: args.stagedFiles.map(recipeRunStagedFile),
          secretEnv: args.recipe.inputs?.secretEnv ?? [],
          externalServices: recipeExternalServiceBoundarySummaries(args.recipe),
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
      stepFailures: args.stepFailures,
      phaseEvidence: args.phaseEvidence,
      diagnostics: args.diagnostics,
      error: args.error,
    }),
  }
}

function recipeEffectiveRecipeEvidenceFile(recipe: WorkspaceRecipe, recipePath: string, inputMountPathMap: NonNullable<Awaited<ReturnType<typeof prepareRecipeRuntimeSetup>>["inputMountPathMap"]>): { filename: string; kind: string; value: RecipeEffectiveRecipeArtifact } {
  const effectiveRecipe = effectiveRecipeForReplay(recipe, inputMountPathMap)
  return {
    filename: "recipe-run-effective-recipe.json",
    kind: "recipe-run-effective-recipe",
    value: {
      schema: "wp-codebox/recipe-run-effective-recipe/v1",
      createdAt: new Date().toISOString(),
      recipePath,
      recipe: effectiveRecipe,
      sha256: recipeDigest(effectiveRecipe),
    },
  }
}

async function writeRecipeFailureDiagnosticArtifacts(artifactsDirectory: string | undefined, files: Array<{ filename: string; kind: string; value: unknown }>): Promise<RecipeDiagnosticArtifactRef[]> {
  if (!artifactsDirectory) {
    return []
  }

  const directory = resolve(artifactsDirectory)
  await mkdir(directory, { recursive: true })
  const refs: RecipeDiagnosticArtifactRef[] = []
  for (const file of files) {
    const path = join(directory, file.filename)
    const contents = `${JSON.stringify(file.value, null, 2)}\n`
    await writeFile(path, contents)
    refs.push({ path: file.filename, kind: file.kind, contentType: "application/json", sha256: createHash("sha256").update(contents).digest("hex") })
  }
  return refs
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
    steps: workflowSteps.map((workflowStep) => stripUndefined({ phase: workflowStep.phase, index: workflowStep.index, command: workflowStep.step.command, fuzzCaseId: workflowStep.fuzzCaseId, fuzzPhase: workflowStep.fuzzPhase })),
  }
}

export function recipeFuzzRunResult(recipe: WorkspaceRecipe, executions: RecipeExecutionResult[]): RecipeFuzzRunResult | undefined {
  if (!recipe.fuzzRun) {
    return undefined
  }

  const cases = recipe.fuzzRun.cases.map((fuzzCase, index): RecipeFuzzCaseResult => {
    const caseExecutions = executions
      .map((execution, executionIndex) => ({ execution, executionIndex }))
      .filter(({ execution }) => execution.fuzzCaseId === fuzzCase.case_id)
    const commandRefs = caseExecutions.map(({ execution, executionIndex }): RecipeFuzzCaseCommandRef => ({
      executionIndex,
      phase: execution.fuzzPhase ?? "action",
      stepIndex: execution.fuzzStepIndex ?? execution.recipeStepIndex ?? 0,
      command: execution.recipeCommand ?? execution.command,
      status: execution.exitCode === 0 ? "completed" : "failed",
      exitCode: execution.exitCode,
      result: {
        id: execution.id,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        stdout: execution.stdout,
        stderr: execution.stderr,
      },
    }))
    const status = fuzzCaseStatus(commandRefs, fuzzCase.phases)
    return stripUndefined({
      schema: "wp-codebox/fuzz-case-result/v1" as const,
      case_id: fuzzCase.case_id,
      index,
      status,
      timing: fuzzCaseTiming(commandRefs),
      input: fuzzCase.input,
      inputHash: fuzzCase.inputHash,
      metadata: fuzzCase.metadata,
      phases: fuzzCasePhaseResults(commandRefs),
      commandRefs,
      artifactRefs: (fuzzCase.artifacts ?? []).map((artifact) => stripUndefined({ name: artifact.name, path: artifact.path, required: artifact.required, metadata: artifact.metadata })),
      diagnostics: commandRefs.filter((ref) => ref.status === "failed").map((ref) => ({ severity: "error" as const, phase: ref.phase, commandRef: ref.executionIndex, message: `${ref.command} exited with ${ref.exitCode}` })),
      replay: fuzzCase.replay ?? {},
    }) as RecipeFuzzCaseResult
  })

  return {
    schema: "wp-codebox/fuzz-run-result/v1",
    sourceSchema: "wp-codebox/fuzz-run/v1",
    status: cases.some((fuzzCase) => fuzzCase.status === "failed") ? "failed" : cases.every((fuzzCase) => fuzzCase.status === "skipped") ? "skipped" : "passed",
    totalCases: cases.length,
    cases,
  }
}

function fuzzCaseStatus(commandRefs: RecipeFuzzCaseCommandRef[], phases: NonNullable<WorkspaceRecipe["fuzzRun"]>["cases"][number]["phases"]): RecipeFuzzCaseStatus {
  if (commandRefs.some((ref) => ref.status === "failed")) {
    return "failed"
  }
  const declaredStepCount = (Object.values(phases) as Array<WorkspaceRecipe["workflow"]["steps"] | undefined>).reduce((total, steps) => total + (steps?.length ?? 0), 0)
  return commandRefs.length >= declaredStepCount ? "passed" : "skipped"
}

function fuzzCaseTiming(commandRefs: RecipeFuzzCaseCommandRef[]): RecipeFuzzCaseResult["timing"] {
  const startedAt = commandRefs.map((ref) => ref.result.startedAt).filter(Boolean).sort()[0]
  const finishedAt = commandRefs.map((ref) => ref.result.finishedAt).filter(Boolean).sort().at(-1)
  const durationMs = startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : undefined
  return stripUndefined({ startedAt, finishedAt, durationMs })
}

function fuzzCasePhaseResults(commandRefs: RecipeFuzzCaseCommandRef[]): RecipeFuzzCaseResult["phases"] {
  const phases: RecipeFuzzCaseResult["phases"] = {}
  for (const phase of ["setup", "action", "assert", "teardown"] as const) {
    const phaseRefs = commandRefs.filter((ref) => ref.phase === phase)
    if (phaseRefs.length > 0) {
      phases[phase] = {
        status: phaseRefs.some((ref) => ref.status === "failed") ? "failed" : "passed",
        commandRefs: phaseRefs,
      }
    }
  }
  return phases
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

function effectiveRecipeWorkflowMetadata(recipe: WorkspaceRecipe, inputMountPathMap: NonNullable<Awaited<ReturnType<typeof prepareRecipeRuntimeSetup>>["inputMountPathMap"]>): { before?: Array<Record<string, unknown>>; steps: Array<Record<string, unknown>>; after?: Array<Record<string, unknown>> } {
  return {
    ...(recipe.workflow.before ? { before: recipe.workflow.before.map((step) => effectiveRecipeStepMetadata(step, inputMountPathMap)) } : {}),
    steps: recipe.workflow.steps.map((step) => effectiveRecipeStepMetadata(step, inputMountPathMap)),
    ...(recipe.workflow.after ? { after: recipe.workflow.after.map((step) => effectiveRecipeStepMetadata(step, inputMountPathMap)) } : {}),
  }
}

function effectiveRecipeStepMetadata(step: WorkspaceRecipe["workflow"]["steps"][number], inputMountPathMap: NonNullable<Awaited<ReturnType<typeof prepareRecipeRuntimeSetup>>["inputMountPathMap"]>): Record<string, unknown> {
  const original = step.args ?? []
  const effective = rewriteInputMountPathArgsForEvidence(original, inputMountPathMap)
  return stripUndefined({ command: step.command, args: effective, originalArgs: original, effectiveArgs: effective, argsRewritten: JSON.stringify(original) !== JSON.stringify(effective) })
}

function effectiveRecipeForReplay(recipe: WorkspaceRecipe, inputMountPathMap: NonNullable<Awaited<ReturnType<typeof prepareRecipeRuntimeSetup>>["inputMountPathMap"]>): WorkspaceRecipe {
  return {
    ...recipe,
    workflow: stripUndefined({
      ...recipe.workflow,
      ...(recipe.workflow.before ? { before: recipe.workflow.before.map((step) => effectiveRecipeStepForReplay(step, inputMountPathMap)) } : {}),
      steps: recipe.workflow.steps.map((step) => effectiveRecipeStepForReplay(step, inputMountPathMap)),
      ...(recipe.workflow.after ? { after: recipe.workflow.after.map((step) => effectiveRecipeStepForReplay(step, inputMountPathMap)) } : {}),
    }) as WorkspaceRecipe["workflow"],
  }
}

function effectiveRecipeStepForReplay(step: WorkspaceRecipe["workflow"]["steps"][number], inputMountPathMap: NonNullable<Awaited<ReturnType<typeof prepareRecipeRuntimeSetup>>["inputMountPathMap"]>): WorkspaceRecipe["workflow"]["steps"][number] {
  return { ...step, args: rewriteInputMountPathArgsForEvidence(step.args ?? [], inputMountPathMap) }
}

function rewriteInputMountPathArgsForEvidence(args: readonly string[], inputMountPathMap: NonNullable<Awaited<ReturnType<typeof prepareRecipeRuntimeSetup>>["inputMountPathMap"]>): string[] {
  return rewriteInputMountPathArgs([...args], inputMountPathMap)
}

function recipeDigest(recipe: WorkspaceRecipe): string {
  return createHash("sha256").update(`${JSON.stringify(recipe, null, 2)}\n`).digest("hex")
}

function recipeRunProvenance(recipe: WorkspaceRecipe, recipePath: string, diagnosticArtifacts: RecipeDiagnosticArtifactRef[] = []): RecipeRunProvenance {
  const effectiveRecipeRef = diagnosticArtifacts.find((artifact) => artifact.kind === "recipe-run-effective-recipe")
  return stripUndefined({
    schema: "wp-codebox/recipe-run-provenance/v1",
    packages: packageProvenance(recipe),
    recipe: stripUndefined({
      path: recipePath,
      sha256: recipeDigest(recipe),
      effectiveSha256: effectiveRecipeRef?.sha256,
      effectiveRecipeRef,
    }),
  }) as RecipeRunProvenance
}

function packageProvenance(recipe: WorkspaceRecipe): ArtifactPackageProvenance {
  const rootPackage = readPackageIdentity("../../../../package.json", "wp-codebox")
  const cliPackage = readPackageIdentity("../../package.json", "@automattic/wp-codebox-cli")
  const corePackage = readPackageIdentity("../../../runtime-core/package.json", "@automattic/wp-codebox-core")
  const playgroundPackage = readPackageIdentity("../../../runtime-playground/package.json", "@automattic/wp-codebox-playground")
  const playgroundCliVersion = packageDependencyVersion(playgroundPackage.manifest, "@wp-playground/cli")
  const wordpressBuildsVersion = packageDependencyVersion(playgroundPackage.manifest, "@wp-playground/wordpress-builds")

  return stripUndefined({
    schema: "wp-codebox/package-provenance/v1",
    wpCodebox: rootPackage.identity,
    runtimeCore: corePackage.identity,
    runtimePlayground: playgroundPackage.identity,
    cli: cliPackage.identity,
    playground: stripUndefined({
      cli: playgroundCliVersion ? { name: "@wp-playground/cli", version: playgroundCliVersion } : undefined,
      wordpressBuilds: wordpressBuildsVersion ? { name: "@wp-playground/wordpress-builds", version: wordpressBuildsVersion } : undefined,
    }),
    environment: stripUndefined({
      wordpressVersion: recipe.runtime?.wp,
      phpVersion: recipe.runtime?.phpVersion,
      nodeVersion: process.versions.node,
    }),
  }) as ArtifactPackageProvenance
}

function readPackageIdentity(packagePath: string, fallbackName: string): { identity: ArtifactPackageIdentity; manifest: Record<string, unknown> } {
  try {
    const contents = readPackageContents(packagePath)
    const manifest = JSON.parse(contents) as Record<string, unknown>
    return {
      identity: stripUndefined({
        name: stringValue(manifest.name) ?? fallbackName,
        version: stringValue(manifest.version),
        source: stripUndefined({
          ref: stringValue(manifest.gitHeadRef) ?? process.env.WP_CODEBOX_SOURCE_REF ?? process.env.GITHUB_REF_NAME ?? process.env.GITHUB_REF,
          sha: stringValue(manifest.gitHead) ?? process.env.WP_CODEBOX_SOURCE_SHA ?? process.env.GITHUB_SHA,
          digest: { algorithm: "sha256" as const, value: createHash("sha256").update(contents).digest("hex") },
        }),
      }) as ArtifactPackageIdentity,
      manifest,
    }
  } catch {
    return { identity: { name: fallbackName }, manifest: {} }
  }
}

function readPackageContents(packagePath: string): string {
  return readFileSync(packageRequire.resolve(packagePath), "utf8")
}

function packageDependencyVersion(manifest: Record<string, unknown>, name: string): string | undefined {
  return stringValue(recordValue(manifest.dependencies)?.[name])
    ?? stringValue(recordValue(manifest.devDependencies)?.[name])
    ?? stringValue(recordValue(manifest.peerDependencies)?.[name])
}

function recipeStepMetadata(step: WorkspaceRecipe["workflow"]["steps"][number]): { command: string; args: string[] } {
  return { command: step.command, args: step.args ?? [] }
}

function effectiveRecipePreview(recipePreview: RuntimePreviewSpec | undefined, options: RecipeRunOptions): RuntimePreviewSpec {
  return stripUndefined({
    publicUrl: options.previewPublicUrl ?? recipePreview?.publicUrl ?? options.previewLease?.public_url ?? options.previewLease?.preview_public_url,
    siteUrl: recipePreview?.siteUrl ?? options.previewLease?.site_url,
    port: options.previewPort ?? recipePreview?.port,
    bind: options.previewBind ?? recipePreview?.bind,
    lease: options.previewLease ?? recipePreview?.lease,
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
        externalServices: recipeExternalServiceBoundarySummaries(recipe),
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
        externalServices: recipeExternalServiceBoundarySummaries(recipe),
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
  return loadAs === "mu-plugin" ? `/wordpress/wp-content/mu-plugins/contained-runtime/${slug}` : `/wordpress/wp-content/plugins/${slug}`
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
