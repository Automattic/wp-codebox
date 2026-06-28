import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { benchRunCode } from "./bench-command-handlers.js"

import {
  artifactFileDigest,
  resolveArtifactPath,
  WORDPRESS_HOTSPOTS_SCHEMA,
  createRuntime,
  createRuntimeEpisode,
  createWordPressRuntimeCheckpoint,
  executeFuzzSuite,
  openWordPressAdminPage,
  openWordPressEditor,
  probeWordPressBrowser,
  readWordPressDatabase,
  requestWordPressRest,
  restoreWordPressRuntimeCheckpoint,
  renderWordPressBlock,
  exerciseWordPressBlock,
  RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES,
  WORDPRESS_DB_OPERATION_SCHEMA,
  planBrowserRandomWalk,
  runWordPressCrudOperation,
  runWordPressBrowserAction,
  runWordPressPhp,
  runWordPressWpCli,
  normalizeWordPressDbOperation,
  visitWordPressPage,
  wordpressHotspotsArtifact,
  wordpressRuntimeDiscoveryToCoveragePlan,
  deleteBoundaryArtifact,
  isRestMutationMethod,
  mutationArtifactDigest,
  mutationIsolationArtifact,
  type ArtifactBundle,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactSpec,
  type ExecutionResult,
  type ExecutionSpec,
  type FuzzSuiteCommandExecutor,
  type FuzzSuiteContract,
  type FuzzSuiteArtifactRef,
  type FuzzSuiteCaseResetResult,
  type FuzzSuiteResetExecutor,
  type FuzzSuiteResultEnvelope,
  type FuzzSuiteRuntimeActionExecutor,
  type FuzzSuiteRuntimeActionExecutionInput,
  type FuzzSuiteRuntimeWorkloadExecutor,
  type FuzzSuiteRunOptions,
  type ObservationSpec,
  type PerformanceObservation,
  type Runtime,
  type RuntimeActionObservation,
  type RuntimeCreateSpec,
  type RuntimeEpisode,
  type RuntimeEpisodeActionSpec,
  type RuntimeEpisodeContentDigest,
  type RuntimeEpisodeTraceRef,
  type RuntimeEpisodeSpec,
  type RuntimeEpisodeStepResult,
  type Snapshot,
  type WordPressHotspotObservationInput,
} from "@automattic/wp-codebox-core/public"
export {
  collectWordPressArtifacts,
  discoverWordPressRuntime,
  executeFuzzSuite,
  executeWordPressRestMatrix,
  wordpressHotspotsArtifact,
  createWordPressRuntimeCheckpoint,
  inventoryWordPressAdminPages,
  inventoryWordPressDatabase,
  inventoryWordPressFrontendUrls,
  inventoryWordPressRestRoutes,
  listWordPressRuntimeCheckpoints,
  loadWordPressAdminPage,
  loadWordPressFrontendPage,
  observeWordPressRestPerformance,
  openWordPressAdminPage,
  openWordPressEditor,
  probeWordPressBrowser,
  readWordPressDatabase,
  requestWordPressRest,
  restoreWordPressRuntimeCheckpoint,
  renderWordPressBlock,
  exerciseWordPressBlock,
  runWordPressCrudOperation,
  runWordPressBrowserAction,
  runWordPressPhp,
  runWordPressWpCli,
  setWordPressPluginState,
  setupWordPressPlugin,
  setupWordPressTheme,
  visitWordPressPage,
  type RuntimeActionObservation,
  type WordPressAdminPageOptions,
  type WordPressBrowserActionOptions,
  type WordPressBrowserProbeOptions,
  type WordPressCrudOperationOptions,
  type WordPressBlockExerciseOptions,
  type WordPressDatabaseReadOperation,
  type WordPressDatabaseReadOptions,
  type WordPressEditorOpenOptions,
  type WordPressPageOptions,
  type WordPressPageLoadOptions,
  type WordPressPhpOptions,
  type WordPressPluginSetupOptions,
  type WordPressPluginStateOptions,
  type WordPressRestRequestOptions,
  type WordPressRuntimeActionEpisode,
  type WordPressRuntimeArtifactSource,
  type WordPressRuntimeDiscoveryOptions,
  type WordPressRuntimeDiscoveryCoveragePlanOptions,
  type WordPressRuntimeInventoryOptions,
  type WordPressRestPerformanceObservationOptions,
  type WordPressRuntimeCheckpointListOptions,
  type WordPressRuntimeCheckpointOptions,
  type WordPressRuntimeCheckpointRestoreOptions,
  type WordPressThemeSetupOptions,
  type WordPressWpCliOptions,
  type WordPressHotspotsArtifact,
  type WordPressHotspotsInput,
  type WordPressHotspotEntry,
  type WordPressHotspotIdentifier,
  type WordPressHotspotMetric,
} from "@automattic/wp-codebox-core"
import { browserArtifactMetrics, type BrowserArtifactMetricsResult } from "./browser-metrics.js"
import { createPlaygroundRuntimeBackend, type PlaygroundRuntimeBackendOptions } from "./playground-runtime.js"

export type WordPressRuntimeSpec = Omit<RuntimeCreateSpec, "backend"> & {
  backend?: "wordpress-playground"
}

export type WordPressEpisodeSpec = Omit<RuntimeEpisodeSpec, "runtime"> & {
  runtime: WordPressRuntimeSpec
}

export interface WordPressRuntimeActionHooks {
  onActionStart?: (action: RuntimeEpisodeActionSpec, index: number) => void | Promise<void>
  onActionFinish?: (result: RuntimeEpisodeStepResult, index: number) => void | Promise<void>
}

export interface WordPressPageLoadActionOptions {
  surface?: "admin" | "frontend"
  path?: string
  url?: string
  method?: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  capture?: { queries?: boolean }
  enableQueryCapture?: boolean
  user?: string
  session?: string
  captureDiagnostics?: string[]
}

export interface WordPressFuzzSuiteExecutionOptions extends Omit<FuzzSuiteRunOptions, "executor" | "runtimeActionExecutor" | "runtimeWorkloadExecutor" | "resetExecutor" | "runnerCapabilities"> {
  artifactBundles?: Array<Pick<ArtifactBundle, "id" | "directory">>
}
type WordPressFuzzSuiteResetEpisode = Pick<RuntimeEpisode, "reset" | "step"> & Partial<Pick<RuntimeEpisode, "restoreSnapshot">>

export interface WordPressFuzzSuiteResetExecutorOptions {
  artifactBundles?: Array<Pick<ArtifactBundle, "id" | "directory">>
}

export async function createWordPressRuntime(spec: WordPressRuntimeSpec, options: PlaygroundRuntimeBackendOptions = {}): Promise<Runtime> {
  return createRuntime(wordPressRuntimeCreateSpec(spec), createPlaygroundRuntimeBackend(options))
}

export async function createWordPressEpisode(spec: WordPressEpisodeSpec, options: PlaygroundRuntimeBackendOptions = {}): Promise<RuntimeEpisode> {
  return createRuntimeEpisode({
    ...spec,
    runtime: wordPressRuntimeCreateSpec(spec.runtime),
  }, createPlaygroundRuntimeBackend(options))
}

export async function runWordPressEpisodeActions(
  episode: Pick<RuntimeEpisode, "step">,
  actions: readonly RuntimeEpisodeActionSpec[],
  options: WordPressRuntimeActionHooks & { observation?: ObservationSpec | false } = {},
): Promise<RuntimeEpisodeStepResult[]> {
  const results: RuntimeEpisodeStepResult[] = []

  for (const [index, action] of actions.entries()) {
    await options.onActionStart?.(action, index)
    const result = await episode.step(action, options.observation)
    await options.onActionFinish?.(result, index)
    results.push(result)
  }

  return results
}

export function createWordPressFuzzSuiteRuntimeActionExecutor(episode: Pick<RuntimeEpisode, "step">): FuzzSuiteRuntimeActionExecutor {
  return {
    async executeRuntimeAction(input) {
      const { action } = input
      if (action.type === "wp_cli") {
        return runWordPressWpCli(episode, action)
      }
      if (action.type === "php") {
        return runWordPressPhp(episode, action)
      }
      if (action.type === "rest_request") {
        if (isRestMutationMethod(action.method ?? "GET")) {
          return executeRollbackSafeRestMutation(episode, { ...input, action })
        }
        return requestWordPressRest(episode, action)
      }
      if (action.type === "crud_operation") {
        const step = await runWordPressCrudOperation(episode, action, action.timeout_ms)
        return {
          schema: "wp-codebox/runtime-action-observation/v1",
          type: action.type,
          status: "ok",
          action,
          data: { stepId: step.id, executionId: step.execution.id, mappedCommand: step.execution.command, args: step.execution.args, exitCode: step.execution.exitCode },
          observedAt: new Date().toISOString(),
          step,
          artifactRefs: step.observation?.artifactRefs,
          digest: { algorithm: "sha256", value: step.execution.command },
        }
      }
      if (action.type === "db_operation") {
        if (action.operation === "write") {
          return executeRollbackSafeDbMutation(episode, { ...input, action })
        }
        const step = await readWordPressDatabase(episode, { ...action, operation: action.operation as "schema" | "read" | "inspect" | "query-summary" }, action.timeout_ms)
        return {
          schema: "wp-codebox/runtime-action-observation/v1",
          type: action.type,
          status: "ok",
          action,
          data: { stepId: step.id, executionId: step.execution.id, mappedCommand: step.execution.command, args: step.execution.args, exitCode: step.execution.exitCode },
          observedAt: new Date().toISOString(),
          step,
          artifactRefs: step.observation?.artifactRefs,
          digest: { algorithm: "sha256", value: step.execution.command },
        }
      }
      if (action.type === "browser") {
        return runWordPressBrowserAction(episode, action)
      }
      if (action.type === "random_walk") {
        const plan = planBrowserRandomWalk(action as unknown as Record<string, unknown>)
        if (plan.status === "unsupported") {
          throw new Error(`Browser random walk is unsupported: ${plan.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`)
        }
        const step = await episode.step({
          kind: "browser",
          command: "wordpress.browser-actions",
          args: [`steps-json=${JSON.stringify(plan.steps)}`, ...(action.capture?.length ? [`capture=${action.capture.join(",")}`] : [])],
          ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
          operation: "random_walk",
        }, { type: "browser-result" })
        return {
          schema: "wp-codebox/runtime-action-observation/v1",
          type: action.type,
          status: "ok",
          action,
          data: { operation: "random_walk", mappedCommand: step.execution.command, args: step.execution.args, exitCode: step.execution.exitCode, stdout: parseJsonRecord(step.execution.stdout) ?? step.execution.stdout, stderr: step.execution.stderr, executionId: step.execution.id, stepId: step.id, randomWalk: plan },
          observedAt: new Date().toISOString(),
          step,
          artifactRefs: step.observation?.artifactRefs,
          digest: digestRuntimeActionObservationData({ operation: "random_walk", args: step.execution.args, exitCode: step.execution.exitCode }),
        }
      }
      if (action.type === "browser_probe") {
        return probeWordPressBrowser(episode, action)
      }
      if (action.type === "editor_open") {
        return openWordPressEditor(episode, action)
      }
      if (action.type === "admin_page") {
        return openWordPressAdminPage(episode, action)
      }
      if (action.type === "page") {
        return visitWordPressPage(episode, action)
      }
      throw new Error(`Unsupported WordPress fuzz runtime-action type: ${action.type}`)
    },
  }
}

async function executeRollbackSafeDbMutation(
  episode: Pick<RuntimeEpisode, "step">,
  input: FuzzSuiteRuntimeActionExecutionInput & { action: Extract<FuzzSuiteRuntimeActionExecutionInput["action"], { type: "db_operation" }> },
): Promise<RuntimeActionObservation> {
  const operation = normalizeWordPressDbOperation({
    schema: WORDPRESS_DB_OPERATION_SCHEMA,
    ...input.action,
    operation: "write",
    options: { ...(input.action.options ?? {}), allowWrites: true, resetIsolated: true },
    metadata: { ...(input.action.metadata ?? {}), resetIsolated: true, affectedRowsMayBeZeroOrUnknown: true },
  })
  const target = operation.resource?.table ?? operation.query?.table ?? "database"
  const mutation = typeof operation.options?.mutation === "string" ? operation.options.mutation.toUpperCase() : "WRITE"
  const checkpointName = mutationCheckpointName(input.suite.id, input.case.id, input.caseIndex)
  const createStep = await createWordPressRuntimeCheckpoint(episode, {
    name: checkpointName,
    metadata: { suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex, target, operation: "db_operation", mutation },
  })
  if (createStep.execution.exitCode !== 0) {
    throw new Error(`Checkpoint create failed for rollback-isolated DB mutation ${input.case.id}: ${createStep.execution.stderr}`)
  }
  const step = await episode.step({ kind: "command", command: "wordpress.db-operation", args: [`operation-json=${JSON.stringify(operation)}`], ...(input.action.timeout_ms !== undefined ? { timeoutMs: input.action.timeout_ms } : {}) }, { type: "command-result" })
  const restoreStep = await restoreWordPressRuntimeCheckpoint(episode, checkpointName)
  const stdout = parseJsonRecord(step.execution.stdout) ?? step.execution.stdout
  const resultMetadata = recordValue(recordValue(stdout)?.metadata)
  const artifact = mutationIsolationArtifact({
    operation: "db_operation",
    target,
    method: mutation,
    checkpointName,
    beforeCheckpoint: mutationStepEvidence(createStep, "created"),
    afterObservation: mutationStepEvidence(step, "observed"),
    restore: mutationStepEvidence(restoreStep, restoreStep.execution.exitCode === 0 ? "passed" : "failed"),
    affectedIdentifiers: undefined,
    metadata: { suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex, affectedRows: resultMetadata?.affectedRows ?? null, affectedRowsMayBeZeroOrUnknown: true },
  })
  const artifactWithRef = { ...artifact, artifactPath: `files/mutation-isolation/${input.case.id}.json`, persisted: false }
  const content = `${JSON.stringify(artifactWithRef, null, 2)}\n`
  const artifactWithDigest = { ...artifactWithRef, sha256: mutationArtifactDigest(artifactWithRef), bytes: Buffer.byteLength(content) }
  const data = {
    operation,
    mappedCommand: step.execution.command,
    args: step.execution.args,
    exitCode: step.execution.exitCode,
    stdout,
    stderr: step.execution.stderr,
    executionId: step.execution.id,
    stepId: step.id,
    mutationIsolationArtifact: artifactWithDigest,
    mutation: { target, kind: mutation, affectedRows: resultMetadata?.affectedRows ?? null, affectedRowsMayBeZeroOrUnknown: true },
  }
  return {
    schema: "wp-codebox/runtime-action-observation/v1",
    type: input.action.type,
    status: "ok",
    action: input.action,
    data,
    observedAt: new Date().toISOString(),
    step,
    artifactRefs: step.observation?.artifactRefs,
    digest: digestRuntimeActionObservationData(data),
  }
}

export function createWordPressFuzzSuiteCommandExecutor(episode: Pick<RuntimeEpisode, "step">): FuzzSuiteCommandExecutor {
  return {
    async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
      const step = await episode.step({ kind: "command", ...spec }, { type: "command-result" })
      return step.execution
    },
  }
}

async function executeRollbackSafeRestMutation(
  episode: Pick<RuntimeEpisode, "step">,
  input: FuzzSuiteRuntimeActionExecutionInput & { action: Extract<FuzzSuiteRuntimeActionExecutionInput["action"], { type: "rest_request" }> },
): Promise<RuntimeActionObservation> {
  const method = (input.action.method ?? "GET").toUpperCase()
  const target = input.action.path
  const checkpointName = mutationCheckpointName(input.suite.id, input.case.id, input.caseIndex)
  const createStep = await createWordPressRuntimeCheckpoint(episode, {
    name: checkpointName,
    metadata: { suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex, target, method, operation: "rest_request" },
  })
  if (createStep.execution.exitCode !== 0) {
    throw new Error(`Checkpoint create failed for rollback-isolated REST mutation ${input.case.id}: ${createStep.execution.stderr}`)
  }
  const observation = await requestWordPressRest(episode, input.action)
  const restoreStep = await restoreWordPressRuntimeCheckpoint(episode, checkpointName)
  const status = restObservationStatus(observation)
  const affectedIdentifiers = restMutationAffectedIdentifiers(observation)
  const baseArtifact = {
    operation: "rest_request" as const,
    target,
    method,
    status,
    checkpointName,
    beforeCheckpoint: mutationStepEvidence(createStep, "created"),
    afterObservation: mutationStepEvidence(observation.step, "observed"),
    restore: mutationStepEvidence(restoreStep, restoreStep.execution.exitCode === 0 ? "passed" : "failed"),
    affectedIdentifiers,
    metadata: { suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex },
  }
  const artifact = method === "DELETE" ? deleteBoundaryArtifact(baseArtifact) : mutationIsolationArtifact(baseArtifact)
  const artifactWithRef = {
    ...artifact,
    artifactPath: method === "DELETE" ? `files/delete-boundaries/${input.case.id}.json` : `files/mutation-isolation/${input.case.id}.json`,
    persisted: false,
  }
  const content = `${JSON.stringify(artifactWithRef, null, 2)}\n`
  const artifactWithDigest = {
    ...artifactWithRef,
    sha256: mutationArtifactDigest(artifactWithRef),
    bytes: Buffer.byteLength(content),
  }
  const data = {
    ...observation.data,
    ...(method === "DELETE" ? { deleteBoundaryArtifact: artifactWithDigest } : { mutationIsolationArtifact: artifactWithDigest }),
  }

  return {
    ...observation,
    data,
    artifactRefs: observation.artifactRefs,
    digest: digestRuntimeActionObservationData(data),
  }
}

export function createWordPressFuzzSuiteRuntimeWorkloadExecutor(episode: Pick<RuntimeEpisode, "step">): FuzzSuiteRuntimeWorkloadExecutor {
  return {
    async executeRuntimeWorkload({ workload, case: fuzzCase }) {
      const steps = [...workloadSteps(workload.before, workload, fuzzCase), ...workloadSteps(workload.steps, workload, fuzzCase), ...workloadSteps(workload.after, workload, fuzzCase)]
      const startedAt = new Date().toISOString()
      const executions: ExecutionResult[] = []
      for (const step of steps) {
        const result = await episode.step({ kind: "command", command: step.command, args: step.args, timeoutMs: step.timeoutMs }, { type: "command-result" })
        executions.push(result.execution)
        if (result.execution.exitCode !== 0 && !step.allowFailure && !step.advisory) {
          break
        }
      }
      const failed = executions.find((execution) => execution.exitCode !== 0)
      const last = executions[executions.length - 1]
      const observations = executions.flatMap((execution) => {
        const nested = performanceObservationsFromWorkloadExecution(execution)
        if (nested.length > 0) {
          return nested
        }
        const observation = performanceObservationFromExecution({ command: execution.command, args: execution.args }, execution)
        return observation ? [observation] : []
      })
      const workloadResult = { schema: "wp-codebox/wordpress-workload-run-result/v1", caseId: fuzzCase.id, steps: executions.length, exitCode: failed ? failed.exitCode : 0, observations: observations.length > 0 ? observations : undefined }
      return {
        id: `wordpress-run-workload-${fuzzCase.id}`,
        command: "wordpress.run-workload",
        args: [`steps=${steps.length}`],
        exitCode: failed ? failed.exitCode : 0,
        stdout: JSON.stringify(workloadResult),
        stderr: failed?.stderr ?? "",
        result: { schema: "wp-codebox/runtime-command-result/v1", status: failed ? "error" : "ok", json: workloadResult },
        startedAt,
        finishedAt: last?.finishedAt ?? new Date().toISOString(),
        artifactRefs: executions.flatMap((execution) => [...(execution.artifactRefs ?? []), ...workloadResultArtifactRefs(execution)]),
      }
    },
  }
}

export function createWordPressFuzzSuiteResetExecutor(episode: WordPressFuzzSuiteResetEpisode, options: WordPressFuzzSuiteResetExecutorOptions = {}): FuzzSuiteResetExecutor {
  let checkpointCreated = false
  return {
    async resetFuzzSuiteCase({ suite, case: fuzzCase, caseIndex, policy }): Promise<FuzzSuiteCaseResetResult> {
      const checkpointName = policy.checkpointName ?? policy.checkpoint_name ?? `${suite.id}-baseline`
      const fixtureRefs = policy.fixtureRefs ?? policy.fixture_refs
      if (policy.mode === "checkpoint-per-case") {
        const artifactRefs: FuzzSuiteArtifactRef[] = []
        if (!checkpointCreated) {
          const createStep = await episode.step({
            kind: "command",
            command: "wp-codebox.checkpoint-create",
            args: [
              `name=${checkpointName}`,
              `metadata-json=${JSON.stringify({ suiteId: suite.id, caseId: fuzzCase.id, caseIndex, fixtureRefs, ...policy.metadata })}`,
            ],
          }, { type: "command-result" })
          artifactRefs.push(...fuzzSuiteStepArtifactRefs(createStep))
          checkpointCreated = createStep.execution.exitCode === 0
          if (!checkpointCreated) {
            return { mode: policy.mode, status: "failed", checkpointName, fixtureRefs, artifactRefs, diagnostics: [{ severity: "error", code: "fuzz_suite_checkpoint_create_failed", caseId: fuzzCase.id, message: `Checkpoint create failed for fuzz suite ${suite.id}.`, metadata: { executionId: createStep.execution.id, stderr: createStep.execution.stderr } }] }
          }
        }
        const restoreStep = await episode.step({ kind: "command", command: "wp-codebox.checkpoint-restore", args: [`name=${checkpointName}`] }, { type: "command-result" })
        artifactRefs.push(...fuzzSuiteStepArtifactRefs(restoreStep))
        return {
          mode: policy.mode,
          status: restoreStep.execution.exitCode === 0 ? "passed" : "failed",
          checkpointName,
          fixtureRefs,
          artifactRefs,
          diagnostics: restoreStep.execution.exitCode === 0 ? [] : [{ severity: "error", code: "fuzz_suite_checkpoint_restore_failed", caseId: fuzzCase.id, message: `Checkpoint restore failed for fuzz suite case ${fuzzCase.id}.`, metadata: { executionId: restoreStep.execution.id, stderr: restoreStep.execution.stderr } }],
        }
      }
      if (policy.mode === "restore-snapshot") {
        const snapshotRef = policy.snapshotRef ?? policy.snapshot_ref
        if (!snapshotRef) {
          return {
            mode: policy.mode,
            status: "failed",
            fixtureRefs,
            diagnostics: [{
              severity: "error",
              code: "fuzz_suite_snapshot_ref_missing",
              caseId: fuzzCase.id,
              message: `Fuzz suite case ${fuzzCase.id} uses restore-snapshot reset policy without a snapshotRef.`,
            }],
            metadata: { resetPerformed: false, restorePerformed: false },
          }
        }
        const sameRuntimeSnapshotRef = isSameRuntimeSnapshotRef(snapshotRef)
        const externalSnapshot = !sameRuntimeSnapshotRef ? await externalSnapshotFromArtifactRef(snapshotRef, options) : undefined
        if (!sameRuntimeSnapshotRef && externalSnapshot && !externalSnapshot.snapshot) {
          const unsupportedReason = externalSnapshot.unsupportedReason ?? "external-snapshot-artifact-restore-unavailable"
          return {
            mode: policy.mode,
            status: "unsupported",
            snapshotRef,
            fixtureRefs,
            diagnostics: [{
              severity: "error",
              code: "fuzz_suite_snapshot_ref_unsupported",
              caseId: fuzzCase.id,
              message: externalSnapshot.message ?? `Snapshot ref ${snapshotRef} is not a same-runtime snapshot id or supported local snapshot artifact ref.`,
              metadata: { snapshotRef, supportedSnapshotRef: "same-runtime snapshot id or artifact:<bundle-id>/files/...", unsupportedReason, ...externalSnapshot.metadata },
            }],
            metadata: { resetPerformed: false, restorePerformed: false, supportedSnapshotRef: "same-runtime snapshot id or artifact:<bundle-id>/files/...", unsupportedReason, ...externalSnapshot.metadata },
          }
        }
        if (episode.restoreSnapshot) {
          try {
            const restoreInput = externalSnapshot?.snapshot ?? snapshotRef
            const restored = await episode.restoreSnapshot(restoreInput)
            return {
              mode: policy.mode,
              status: "passed",
              snapshotRef,
              fixtureRefs,
              artifactRefs: fuzzSuiteSnapshotArtifactRefs(restored),
              diagnostics: [],
              metadata: { resetPerformed: true, restorePerformed: true, snapshotId: restored.id, semantics: restored.semantics, ...(externalSnapshot?.metadata ? { externalSnapshot: externalSnapshot.metadata } : {}) },
            }
          } catch (error) {
            return {
              mode: policy.mode,
              status: "failed",
              snapshotRef,
              fixtureRefs,
              diagnostics: [{
                severity: "error",
                code: "fuzz_suite_snapshot_restore_failed",
                caseId: fuzzCase.id,
                message: error instanceof Error ? error.message : String(error),
                metadata: { snapshotRef },
              }],
              metadata: { resetPerformed: false, restorePerformed: false, snapshotRef },
            }
          }
        }
        return {
          mode: policy.mode,
          status: "unsupported",
          snapshotRef,
          fixtureRefs,
          diagnostics: [{
            severity: "error",
            code: "fuzz_suite_snapshot_restore_unsupported",
            caseId: fuzzCase.id,
            message: "The supplied runtime episode cannot restore snapshot refs; provide a RuntimeEpisode with restoreSnapshot support, or use checkpoint-per-case for same-run runtime restoration.",
            metadata: { snapshotRef, supportedResetModes: ["none", "checkpoint-per-case"], runtimePrimitiveRequired: "snapshot-restore" },
          }],
          metadata: { resetPerformed: false, restorePerformed: false, supportedResetModes: ["none", "checkpoint-per-case"], unsupportedReason: "snapshot-restore-primitive-unavailable" },
        }
      }
      return { mode: "none", status: "not-required" }
    },
  }
}

export function executeWordPressFuzzSuite(
  episode: WordPressFuzzSuiteResetEpisode,
  suite: FuzzSuiteContract,
  options: WordPressFuzzSuiteExecutionOptions = {},
): Promise<FuzzSuiteResultEnvelope> {
  const hotspotObservations: WordPressHotspotObservationInput[] = []
  const commandExecutor = createWordPressFuzzSuiteCommandExecutor(episode)
  const runtimeActionExecutor = createWordPressFuzzSuiteRuntimeActionExecutor(episode)
  const runtimeWorkloadExecutor = createWordPressFuzzSuiteRuntimeWorkloadExecutor(episode)

  return executeFuzzSuite(suite, {
    ...options,
    executor: async (spec) => {
      const execution = await commandExecutor.execute(spec)
      pushHotspotObservation(hotspotObservations, performanceObservationFromExecution(spec, execution), executionArtifactRefs(execution))
      return execution
    },
    runtimeActionExecutor: async (input) => {
      const observation = await runtimeActionExecutor.executeRuntimeAction(input)
      pushHotspotObservation(hotspotObservations, performanceObservationFromRuntimeAction(observation), runtimeActionArtifactRefs(observation), { caseId: input.case.id, targetId: input.target.id ?? input.target.entrypoint, phase: input.action.type })
      return observation
    },
    runtimeWorkloadExecutor: async (input) => {
      const execution = await runtimeWorkloadExecutor.executeRuntimeWorkload(input)
      const observations = performanceObservationsFromWorkloadExecution(execution)
      if (observations.length === 0) {
        pushHotspotObservation(hotspotObservations, performanceObservationFromExecution({ command: execution.command, args: execution.args }, execution), executionArtifactRefs(execution), { caseId: input.case.id, targetId: input.target.id ?? input.target.entrypoint, phase: input.target.entrypoint ?? input.target.kind })
      } else {
        for (const observation of observations) {
          pushHotspotObservation(hotspotObservations, observation, executionArtifactRefs(execution), { caseId: input.case.id, targetId: input.target.id ?? input.target.entrypoint, phase: input.target.entrypoint ?? input.target.kind })
        }
      }
      return execution
    },
    resetExecutor: createWordPressFuzzSuiteResetExecutor(episode, { artifactBundles: options.artifactBundles }),
    runnerCapabilities: RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES,
    metadata: {
      ...options.metadata,
      runnerMode: "runtime-backed",
      runtimeBackend: "wordpress-playground",
    },
  }).then((result) => resultWithWordPressHotspotsArtifact(result, hotspotObservations))
}

function resultWithWordPressHotspotsArtifact(result: FuzzSuiteResultEnvelope, observations: WordPressHotspotObservationInput[]): FuzzSuiteResultEnvelope {
  const artifact = wordpressHotspotsArtifact({
    generatedAt: new Date().toISOString(),
    source: "executeWordPressFuzzSuite",
    observations,
    fuzzResult: result,
    artifactRefs: result.artifactRefs,
    metadata: { suiteId: result.suite.id, runnerMode: result.metadata?.runnerMode },
  })
  const observationSet = fuzzObservationSetArtifact(result, observations)
  const hotspotSet = fuzzHotspotSetArtifact(result, observationSet.observations)
  const content = `${JSON.stringify(artifact, null, 2)}\n`
  const observationContent = `${JSON.stringify(observationSet, null, 2)}\n`
  const hotspotContent = `${JSON.stringify(hotspotSet, null, 2)}\n`
  const artifactMetadata = {
    wordpressHotspots: inlineArtifactMetadata("wordpress-hotspots", WORDPRESS_HOTSPOTS_SCHEMA, content),
    fuzzObservationSet: inlineArtifactMetadata("fuzz-observation-set", "wp-codebox/fuzz-observation-set/v1", observationContent),
    fuzzHotspotSet: inlineArtifactMetadata("fuzz-hotspot-set", "wp-codebox/fuzz-hotspot-set/v1", hotspotContent),
  }
  const artifactRefs = dedupeFuzzSuiteArtifactRefs(result.artifactRefs)
  const linkedMetadataArtifacts = {
    ...(recordValue(result.metadata?.artifacts) ?? {}),
    ...artifactMetadata,
  }
  const resultArtifactContent = `${JSON.stringify({ ...result, artifactRefs, metadata: { ...result.metadata, artifacts: linkedMetadataArtifacts } }, null, 2)}\n`
  const resultMetadata = inlineArtifactMetadata("fuzz-suite-result", result.schema, resultArtifactContent)

  return {
    ...result,
    artifactRefs,
    metadata: {
      ...result.metadata,
      artifacts: {
        ...linkedMetadataArtifacts,
        fuzzResult: resultMetadata,
      },
    },
  }
}

function pushHotspotObservation(out: WordPressHotspotObservationInput[], observation: PerformanceObservation | undefined, artifactRefs: FuzzSuiteArtifactRef[] = [], metadata: Record<string, unknown> = {}): void {
  if (!observation) return
  out.push({
    observation,
    artifactRefs: artifactRefs.map((ref) => ({ path: ref.path, kind: ref.kind, contentType: ref.contentType, sha256: ref.sha256, bytes: ref.bytes, name: ref.name, metadata: ref.metadata })),
    metadata,
  })
}

function inlineArtifactMetadata(kind: string, schema: string, content: string): Record<string, unknown> {
  return {
    kind,
    contentType: "application/json",
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
    name: kind,
    persisted: false,
    metadata: { schema, source: "executeWordPressFuzzSuite", storage: "inline-metadata" },
  }
}

function fuzzObservationSetArtifact(result: FuzzSuiteResultEnvelope, observations: WordPressHotspotObservationInput[]): { schema: string; generated_at: string; source: string; observations: Array<Record<string, unknown>>; summary: Record<string, unknown>; metadata: Record<string, unknown> } {
  const flattened = observations.flatMap((input) => fuzzObservations(input))
  return {
    schema: "wp-codebox/fuzz-observation-set/v1",
    generated_at: new Date().toISOString(),
    source: "wp-codebox",
    observations: flattened,
    summary: {
      total: flattened.length,
      families: countByString(flattened, "family"),
      metrics: countByString(flattened, "metric"),
    },
    metadata: { suite_id: result.suite.id, runner: "wp-codebox", runner_mode: result.metadata?.runnerMode },
  }
}

function fuzzHotspotSetArtifact(result: FuzzSuiteResultEnvelope, observations: Array<Record<string, unknown>>): { schema: string; generated_at: string; source: string; hotspots: Array<Record<string, unknown>>; summary: Record<string, unknown>; metadata: Record<string, unknown> } {
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const observation of observations) {
    const key = [stringValue(observation.case_id), stringValue(observation.target_id), stringValue(observation.subject), stringValue(observation.metric)].join("|")
    grouped.set(key, [...(grouped.get(key) ?? []), observation])
  }
  const scored = [...grouped.values()].map((items) => {
    const first = items[0] ?? {}
    const value = items.reduce((sum, item) => sum + (numberValue(item.value) ?? 0), 0)
    return {
      family: first.family,
      case_id: first.case_id,
      target_id: first.target_id,
      operation_id: first.operation_id,
      phase: first.phase,
      subject: first.subject,
      metric: first.metric,
      value,
      unit: first.unit,
      score: fuzzHotspotScore(stringValue(first.metric), value),
      sample_count: items.reduce((sum, item) => sum + (numberValue(item.sample_count) ?? 1), 0),
      metadata: { sources: items.length },
    }
  }).sort((a, b) => b.score - a.score || String(a.subject).localeCompare(String(b.subject)))
  const maxScore = scored[0]?.score ?? 0
  const hotspots = scored.map((item, index) => ({ ...item, rank: index + 1, relative_score: maxScore > 0 ? Number((item.score / maxScore).toFixed(6)) : 0 }))
  return {
    schema: "wp-codebox/fuzz-hotspot-set/v1",
    generated_at: new Date().toISOString(),
    source: "wp-codebox",
    hotspots,
    summary: { total: hotspots.length, families: countByString(hotspots, "family"), max_score: maxScore },
    metadata: { suite_id: result.suite.id, runner: "wp-codebox", runner_mode: result.metadata?.runnerMode },
  }
}

function fuzzObservations(input: WordPressHotspotObservationInput): Array<Record<string, unknown>> {
  const observation = input.observation
  const metadata = recordValue(input.metadata) ?? {}
  const common = {
    case_id: stringValue(metadata.caseId) ?? stringValue(observation.metadata?.caseId),
    target_id: stringValue(metadata.targetId) ?? observation.target,
    operation_id: observation.command,
    phase: stringValue(metadata.phase) ?? observation.kind,
    subject: observation.target ?? observation.command ?? observation.kind ?? "observation",
    metadata: { source: observation.source, execution_id: stringValue(observation.metadata?.executionId) },
  }
  return [
    fuzzObservation(common, "timing", "duration-ms", observation.timing?.durationMs, "ms"),
    fuzzObservation(common, "database", "query-count", observation.database?.queryCount, "count"),
    fuzzObservation(common, "database", "query-time-ms", observation.database?.totalTimeMs, "ms"),
    fuzzObservation(common, "memory", "memory-delta-bytes", observation.memory?.deltaBytes, "bytes"),
    fuzzObservation(common, "network", "network-failures", observation.network?.failures, "count"),
    ...Object.entries(observation.browser?.metrics ?? {}).map(([name, value]) => fuzzObservation({ ...common, subject: `${common.subject}:${name}` }, "browser", name, value, undefined)),
  ].filter((item): item is Record<string, unknown> => Boolean(item))
}

function fuzzObservation(common: Record<string, unknown>, family: string, metric: string, value: unknown, unit: string | undefined): Record<string, unknown> | undefined {
  const number = numberValue(value)
  if (number === undefined || number <= 0) return undefined
  return {
    family,
    case_id: common.case_id,
    target_id: common.target_id,
    operation_id: common.operation_id,
    phase: common.phase,
    subject: common.subject,
    metric,
    value: number,
    unit,
    sample_count: 1,
    metadata: common.metadata,
  }
}

function fuzzHotspotScore(metric: string | undefined, value: number): number {
  if (metric === "query-count") return value * 10
  if (metric === "network-failures") return value * 100
  if (metric === "memory-delta-bytes") return value / 1024 / 1024
  return value
}

function countByString(items: Array<Record<string, unknown>>, key: string): Record<string, number> {
  return items.reduce<Record<string, number>>((summary, item) => {
    const value = stringValue(item[key])
    if (value) summary[value] = (summary[value] ?? 0) + 1
    return summary
  }, {})
}

function performanceObservationFromRuntimeAction(observation: RuntimeActionObservation): PerformanceObservation | undefined {
  if (observation.performance) {
    const command = observation.performance.command ?? observation.step?.execution.command
    return {
      ...observation.performance,
      command,
      source: observation.performance.source ?? observationSource(command),
      kind: observation.performance.kind ?? observationKind(command, observation.performance.target),
    }
  }
  return performanceObservationFromExecution({ command: observation.step?.execution.command, args: observation.step?.execution.args }, observation.step?.execution, observation.action.type)
}

function performanceObservationFromExecution(spec: Partial<ExecutionSpec>, execution: ExecutionResult | undefined, source?: string): PerformanceObservation | undefined {
  if (!execution) return undefined
  const json = recordValue(execution.result?.json) ?? parseJsonRecord(execution.stdout)
  const performance = recordValue(json?.performance)
  const timing = recordValue(performance?.timing) ?? recordValue(json?.timing)
  const startedMs = Date.parse(execution.startedAt)
  const finishedMs = Date.parse(execution.finishedAt)
  const durationMs = numberValue(timing?.durationMs ?? timing?.duration_ms ?? json?.durationMs ?? json?.duration_ms) ?? (Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : undefined)
  const database = normalizeObservationDatabase(recordValue(performance?.database) ?? recordValue(json?.database) ?? recordValue(json?.metrics))
  const browser = normalizeObservationBrowser(recordValue(performance?.browser) ?? recordValue(json?.browser) ?? recordValue(json?.metrics))
  const network = recordValue(performance?.network) as PerformanceObservation["network"] | undefined
  const specRecord = spec as Record<string, unknown>
  const target = stringValue(json?.path ?? json?.route ?? json?.url ?? specRecord.path ?? execution.command)
  const command = stringValue(spec.command ?? execution.command)
  const observation: PerformanceObservation = {
    schema: "wp-codebox/performance-observation/v1",
    command,
    target,
    source: source ?? observationSource(command),
    kind: observationKind(command, target),
    timing: durationMs !== undefined ? { startedAt: execution.startedAt, finishedAt: execution.finishedAt, durationMs } : undefined,
    database,
    browser,
    network,
    artifactRefs: executionArtifactRefs(execution).map((ref) => ({ path: ref.path, kind: ref.kind, digest: ref.sha256 ? { algorithm: "sha256", value: ref.sha256 } : undefined })),
    metadata: { executionId: execution.id },
  }
  return hasObservationMetrics(observation) ? observation : undefined
}

function performanceObservationsFromWorkloadExecution(execution: ExecutionResult): PerformanceObservation[] {
  const json = recordValue(execution.result?.json) ?? parseJsonRecord(execution.stdout)
  const raw = arrayValue(json?.observations ?? json?.performanceObservations ?? json?.performance_observations)
  return [
    ...raw.flatMap((item) => isPerformanceObservation(item) ? [item] : []),
    ...performanceObservationsFromBenchResult(json, execution),
  ]
}

function performanceObservationsFromBenchResult(json: Record<string, unknown> | undefined, execution: ExecutionResult): PerformanceObservation[] {
  if (json?.schema !== "wp-codebox/bench-results/v1") return []
  const observations: PerformanceObservation[] = []
  for (const scenario of arrayValue(json.scenarios)) {
    const scenarioRecord = recordValue(scenario)
    const profile = recordValue(recordValue(scenarioRecord?.artifacts)?.["rest-db-query-profile"])
    if (profile?.schema !== "wp-codebox/wordpress-rest-db-query-profile/v1") continue
    for (const profileCase of arrayValue(profile.cases)) {
      const caseRecord = recordValue(profileCase)
      const summary = recordValue(caseRecord?.summary)
      const queryCount = numberValue(summary?.query_count)
      const totalTimeMs = numberValue(summary?.total_time_ms)
      const path = stringValue(caseRecord?.path) ?? stringValue(caseRecord?.case_id) ?? "rest-db-query-profile"
      const observation: PerformanceObservation = {
        schema: "wp-codebox/performance-observation/v1",
        command: "wordpress.run-workload",
        target: path,
        source: "rest-db-query-profiler",
        kind: "rest-request",
        database: queryCount !== undefined || totalTimeMs !== undefined ? { queryCount, totalTimeMs } : undefined,
        metadata: { executionId: execution.id, scenarioId: stringValue(scenarioRecord?.id), caseId: stringValue(caseRecord?.case_id) },
      }
      if (hasObservationMetrics(observation)) {
        observations.push(observation)
      }
    }
  }
  return observations
}

function normalizeObservationDatabase(input: Record<string, unknown> | undefined): PerformanceObservation["database"] | undefined {
  if (!input) return undefined
  const queryCount = numberValue(input.queryCount ?? input.query_count ?? input.queries)
  const rawTotalTimeMs = input.totalTimeMs ?? input.total_time_ms ?? input.queryTimeMs ?? input.query_time_ms
  const totalTimeMs = rawTotalTimeMs === null ? null : numberValue(rawTotalTimeMs)
  const timingStatus = stringValue(input.timingStatus ?? input.timing_status)
  const timingReason = stringValue(input.timingReason ?? input.timing_reason)
  return queryCount !== undefined || totalTimeMs !== undefined || timingStatus !== undefined ? { queryCount, totalTimeMs, timingStatus, timingReason } : input as PerformanceObservation["database"]
}

function normalizeObservationBrowser(input: Record<string, unknown> | undefined): PerformanceObservation["browser"] | undefined {
  if (!input) return undefined
  const metrics = numericRecord(recordValue(input.metrics) ?? input)
  return metrics && Object.keys(metrics).length > 0 ? { metrics } : undefined
}

function executionArtifactRefs(execution: ExecutionResult): FuzzSuiteArtifactRef[] {
  return (execution.artifactRefs ?? []).flatMap((ref) => {
    const path = ref.path ?? ref.artifactId ?? ref.id
    return path ? [{ path, kind: ref.kind, sha256: ref.digest?.algorithm === "sha256" ? ref.digest.value : undefined, metadata: { id: ref.id, artifactId: ref.artifactId, digest: ref.digest } }] : []
  })
}

function runtimeActionArtifactRefs(observation: RuntimeActionObservation): FuzzSuiteArtifactRef[] {
  return (observation.artifactRefs ?? []).flatMap((ref) => {
    const path = ref.path ?? ref.artifactId ?? ref.id
    return path ? [{ path, kind: ref.kind, sha256: ref.digest?.algorithm === "sha256" ? ref.digest.value : undefined, metadata: { id: ref.id, artifactId: ref.artifactId, digest: ref.digest } }] : []
  })
}

function observationSource(command: string | undefined): PerformanceObservation["source"] | undefined {
  if (command?.includes("browser")) return "browser"
  if (command?.includes("rest")) return "server-http"
  return "in-process"
}

function observationKind(command: string | undefined, target: string | undefined): PerformanceObservation["kind"] | undefined {
  if (command?.includes("rest")) return "rest-request"
  if (command?.includes("browser") || target?.startsWith("http")) return "browser-page-load"
  if (command?.includes("page-load")) return "server-page-load"
  return undefined
}

function hasObservationMetrics(observation: PerformanceObservation): boolean {
  return Boolean(observation.timing?.durationMs || observation.database?.queryCount || observation.database?.totalTimeMs || observation.network?.failures || Object.keys(observation.browser?.metrics ?? {}).length > 0)
}

function isPerformanceObservation(value: unknown): value is PerformanceObservation {
  return recordValue(value)?.schema === "wp-codebox/performance-observation/v1"
}

function dedupeFuzzSuiteArtifactRefs(refs: readonly FuzzSuiteArtifactRef[]): FuzzSuiteArtifactRef[] {
  const seen = new Set<string>()
  const out: FuzzSuiteArtifactRef[] = []
  for (const ref of refs) {
    if (!ref.path || seen.has(ref.path)) continue
    seen.add(ref.path)
    out.push(ref)
  }
  return out
}

function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    return recordValue(JSON.parse(text))
  } catch (_error) {
    return undefined
  }
}

function mutationCheckpointName(suiteId: string, caseId: string, caseIndex: number): string {
  return `mutation-${safeArtifactSegment(suiteId)}-${caseIndex}-${safeArtifactSegment(caseId)}`
}

function safeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "case"
}

function mutationStepEvidence(step: RuntimeEpisodeStepResult | undefined, status: string): { status: string; stepId?: string; executionId?: string; exitCode?: number; command?: string; artifactRefs?: FuzzSuiteArtifactRef[] } {
  return {
    status,
    stepId: step?.id,
    executionId: step?.execution.id,
    exitCode: step?.execution.exitCode,
    command: step?.execution.command,
    artifactRefs: step ? fuzzSuiteStepArtifactRefs(step) : undefined,
  }
}

function restObservationStatus(observation: RuntimeActionObservation): number | undefined {
  return numberValue(observation.data.status ?? recordValue(observation.data.stdout)?.status)
}

function restMutationAffectedIdentifiers(observation: RuntimeActionObservation): Array<{ kind?: string; id: string | number; source?: string }> | undefined {
  const data = recordValue(observation.data.body) ?? recordValue(observation.data.stdout)
  const id = data?.id
  if (typeof id === "string" || typeof id === "number") {
    return [{ id, source: "rest-response" }]
  }
  const deleted = recordValue(data?.deleted)
  const previous = recordValue(data?.previous)
  const previousId = previous?.id ?? deleted?.id
  if (typeof previousId === "string" || typeof previousId === "number") {
    return [{ id: previousId, source: "rest-response.previous" }]
  }
  return undefined
}

function digestRuntimeActionObservationData(data: Record<string, unknown>): RuntimeEpisodeContentDigest {
  return { algorithm: "sha256", value: createHash("sha256").update(JSON.stringify(data)).digest("hex") }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numericRecord(value: Record<string, unknown>): Record<string, number> | undefined {
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function workloadSteps(value: unknown, workload: Record<string, unknown>, fuzzCase?: unknown): Array<{ command: string; args?: string[]; timeoutMs?: number; allowFailure?: boolean; advisory?: boolean }> {
  if (!Array.isArray(value)) {
    return []
  }
  const commandSteps = value.flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return []
    }
    const record = step as Record<string, unknown>
    if (typeof record.command !== "string" || record.command.trim() === "") {
      return []
    }
    const args = Array.isArray(record.args) ? record.args.map(String) : undefined
    const parsedArgs = stepArgMap(args)
    const phpWorkloadStep = record.command === "wordpress.run-workload" && parsedArgs.type?.toLowerCase() === "php"
    return [{
      command: phpWorkloadStep ? "wordpress.run-php" : record.command,
      args: phpWorkloadStep ? [`code=${wordpressWorkloadPhpWrapper(parsedArgs.path ?? parsedArgs.file ?? "", workload, parsedArgs)}`] : args,
      timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : typeof record.timeout_ms === "number" ? record.timeout_ms : undefined,
      allowFailure: record.allowFailure === true || record.allow_failure === true,
      advisory: record.advisory === true,
    }]
  })
  if (commandSteps.length > 0) {
    return commandSteps
  }
  if (value.some((step) => step && typeof step === "object" && !Array.isArray(step) && typeof (step as Record<string, unknown>).type === "string")) {
    return [{ command: "wordpress.run-php", args: [`code=${typedWorkloadRunnerCode(workload, fuzzCase)}`] }]
  }
  return []
}

function typedWorkloadRunnerCode(workload: Record<string, unknown>, fuzzCase?: unknown): string {
  return benchRunCode({
    componentId: stringValue(workload.componentId) ?? stringValue(workload.component_id) ?? "wordpress-workload",
    pluginSlug: typedWorkloadPluginSlug(workload, fuzzCase),
    iterations: 1,
    warmupIterations: 0,
    dependencySlugs: [],
    env: recordValue(workload.runtime_env) ?? recordValue(workload.runtimeEnv) ?? {},
    bootstrapFiles: [],
    workloads: [workload],
    lifecycle: {},
    resetPolicy: {},
  })
}

function typedWorkloadPluginSlug(workload: Record<string, unknown>, fuzzCase?: unknown): string {
  const fuzzCaseRecord = recordValue(fuzzCase)
  const explicit = stringValue(workload.pluginSlug) ?? stringValue(workload.plugin_slug) ?? stringValue(recordValue(workload.metadata)?.plugin_slug) ?? stringValue(recordValue(fuzzCaseRecord?.metadata)?.plugin_slug)
  if (explicit) return explicit
  const metadata = recordValue(fuzzCaseRecord?.metadata)
  const caseMetadata = recordValue(metadata?.caseMetadata) ?? recordValue(metadata?.case_metadata) ?? metadata
  const activation = stringValue(recordValue(recordValue(recordValue(caseMetadata?.intent)?.plugin)?.activation)?.entrypoint) ?? stringValue(recordValue(recordValue(caseMetadata?.intent)?.plugin)?.activation)
  const slug = activation?.split("/")[0]?.trim()
  return slug || "wp-codebox-workload"
}

function stepArgMap(args: string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const arg of args ?? []) {
    const index = arg.indexOf("=")
    parsed[index === -1 ? arg : arg.slice(0, index)] = index === -1 ? "" : arg.slice(index + 1)
  }
  return parsed
}

function wordpressWorkloadPhpWrapper(path: string, workload: Record<string, unknown>, args: Record<string, string>): string {
  const normalizedArgs: Record<string, string> = { ...args, path }
  delete normalizedArgs.file
  const encodedInput = Buffer.from(JSON.stringify(wordpressWorkloadPhpWrapperInput(workload)), "utf8").toString("base64")
  const encodedArgs = Buffer.from(JSON.stringify(normalizedArgs), "utf8").toString("base64")
  return `$__wp_codebox_workload_input = json_decode(base64_decode('${encodedInput}'), true);\n$__wp_codebox_workload_args = json_decode(base64_decode('${encodedArgs}'), true);\n$__wp_codebox_workload_callable = require ${JSON.stringify(path)};\nif (!is_callable($__wp_codebox_workload_callable)) { throw new RuntimeException('PHP workload file must return a callable.'); }\n$__wp_codebox_workload_result = $__wp_codebox_workload_callable(is_array($__wp_codebox_workload_input) ? $__wp_codebox_workload_input : array(), is_array($__wp_codebox_workload_args) ? $__wp_codebox_workload_args : array());\nif (is_array($__wp_codebox_workload_result) || is_object($__wp_codebox_workload_result)) { echo json_encode($__wp_codebox_workload_result, JSON_UNESCAPED_SLASHES) . "\\n"; } elseif (false === $__wp_codebox_workload_result) { exit(1); }`
}

function wordpressWorkloadPhpWrapperInput(workload: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...workload }
  if (input.runtimeEnv === undefined && recordValue(input.runtime_env)) {
    input.runtimeEnv = input.runtime_env
  }
  if (input.runtime_env === undefined && recordValue(input.runtimeEnv)) {
    input.runtime_env = input.runtimeEnv
  }
  return input
}

function workloadResultArtifactRefs(execution: ExecutionResult): NonNullable<ExecutionResult["artifactRefs"]> {
  const json = recordValue(execution.result?.json) ?? parseJsonRecord(execution.stdout)
  return arrayValue(json?.artifactRefs ?? json?.artifact_refs ?? json?.artifacts).flatMap((ref) => recordValue(ref) ? [ref as NonNullable<ExecutionResult["artifactRefs"]>[number]] : [])
}

function fuzzSuiteStepArtifactRefs(step: RuntimeEpisodeStepResult): FuzzSuiteArtifactRef[] {
  return (step.execution.artifactRefs ?? []).flatMap((ref) => {
    const path = ref.path ?? ref.artifactId ?? ref.id
    return path ? [{
      path,
      kind: ref.kind,
      sha256: ref.digest?.algorithm === "sha256" ? ref.digest.value : undefined,
      metadata: { id: ref.id, artifactId: ref.artifactId, digest: ref.digest },
    }] : []
  })
}

function isSameRuntimeSnapshotRef(snapshotRef: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(snapshotRef)
}

interface ExternalSnapshotResolution {
  snapshot?: Snapshot
  unsupportedReason?: string
  message?: string
  metadata?: Record<string, unknown>
}

async function externalSnapshotFromArtifactRef(snapshotRef: string, options: WordPressFuzzSuiteResetExecutorOptions): Promise<ExternalSnapshotResolution> {
  if (/^https?:\/\//i.test(snapshotRef)) {
    return {
      unsupportedReason: "remote-snapshot-ref-unsupported",
      message: `Snapshot ref ${snapshotRef} is remote; restore-snapshot only supports trusted local artifact bundle refs.`,
    }
  }

  const match = /^artifact:([^/]+)\/(files\/.+)$/.exec(snapshotRef)
  if (!match) {
    return {
      unsupportedReason: "unsupported-snapshot-ref-format",
      message: `Snapshot ref ${snapshotRef} is not a supported local artifact snapshot ref.`,
    }
  }

  const [, bundleId, artifactPath] = match
  const bundle = options.artifactBundles?.find((candidate) => candidate.id === bundleId)
  if (!bundle) {
    return {
      unsupportedReason: "trusted-artifact-bundle-unavailable",
      message: `Snapshot ref ${snapshotRef} names artifact bundle ${bundleId}, but that bundle was not supplied as a trusted local artifact bundle.`,
      metadata: { bundleId, artifactPath },
    }
  }

  let absolutePath: string
  try {
    absolutePath = resolveArtifactPath(bundle.directory, artifactPath).absolutePath
  } catch (error) {
    return {
      unsupportedReason: "artifact-path-outside-bundle",
      message: error instanceof Error ? error.message : String(error),
      metadata: { bundleId, artifactPath },
    }
  }

  try {
    const payloadText = await readFile(absolutePath, "utf8")
    const manifestFile = await artifactManifestFileForPath(bundle.directory, artifactPath)
    const digest = artifactFileDigest(payloadText)
    if (manifestFile?.sha256 && manifestFile.sha256.value !== digest.value) {
      return {
        unsupportedReason: "snapshot-artifact-hash-mismatch",
        message: `Snapshot artifact ${artifactPath} does not match the SHA-256 recorded in ${bundleId}/manifest.json.`,
        metadata: { bundleId, artifactPath, expectedSha256: manifestFile.sha256.value, actualSha256: digest.value },
      }
    }

    const payload = JSON.parse(payloadText) as Record<string, unknown>
    if (payload.schema !== "wp-codebox/wordpress-runtime-snapshot/v1" || payload.compatibility === undefined) {
      return {
        unsupportedReason: "snapshot-artifact-schema-unsupported",
        message: `Snapshot artifact ${artifactPath} is not a wp-codebox/wordpress-runtime-snapshot/v1 artifact.`,
        metadata: { bundleId, artifactPath },
      }
    }

    const snapshotId = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : snapshotRef
    const createdAt = typeof payload.createdAt === "string" && payload.createdAt.length > 0 ? payload.createdAt : new Date(0).toISOString()
    const snapshot: Snapshot = {
      id: snapshotId,
      createdAt,
      semantics: "runtime-state-artifact",
      metadata: { artifact: { absolutePath }, artifactRef: snapshotRef },
      artifactRefs: [{ kind: "runtime-snapshot-artifact", id: snapshotRef, artifactId: snapshotRef, path: artifactPath, digest }],
    }

    return { snapshot, metadata: { bundleId, artifactPath, sha256: digest.value } }
  } catch (error) {
    return {
      unsupportedReason: "snapshot-artifact-unreadable",
      message: error instanceof Error ? error.message : String(error),
      metadata: { bundleId, artifactPath },
    }
  }
}

async function artifactManifestFileForPath(bundleDirectory: string, artifactPath: string): Promise<ArtifactManifestFile | undefined> {
  try {
    const manifestPath = resolveArtifactPath(bundleDirectory, "manifest.json").absolutePath
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ArtifactManifest
    return Array.isArray(manifest.files) ? manifest.files.find((file) => file.path === artifactPath) : undefined
  } catch {
    return undefined
  }
}

function fuzzSuiteSnapshotArtifactRefs(snapshot: { artifactRefs?: RuntimeEpisodeTraceRef[] }): FuzzSuiteArtifactRef[] {
  return (snapshot.artifactRefs ?? []).flatMap((ref) => {
    const path = ref.path ?? ref.artifactId ?? ref.id
    return path ? [{
      path,
      kind: ref.kind,
      sha256: ref.digest?.algorithm === "sha256" ? ref.digest.value : undefined,
      metadata: { id: ref.id, artifactId: ref.artifactId, digest: ref.digest },
    }] : []
  })
}

export async function collectWordPressRuntimeArtifacts(runtime: Pick<Runtime, "collectArtifacts">, spec?: ArtifactSpec): Promise<ArtifactBundle> {
  return runtime.collectArtifacts(spec)
}

export async function collectWordPressEpisodeArtifacts(episode: Pick<RuntimeEpisode, "collectArtifacts">, spec?: ArtifactSpec): Promise<ArtifactBundle> {
  return episode.collectArtifacts(spec)
}

export async function collectBrowserArtifactMetrics(bundleDirectory: string): Promise<BrowserArtifactMetricsResult> {
  return browserArtifactMetrics(bundleDirectory)
}

export function wordpressAdminPageLoadAction(options: WordPressPageLoadActionOptions = {}): RuntimeEpisodeActionSpec {
  return { command: "wordpress.admin-page-load", args: pageLoadActionArgs(options) }
}

export function wordpressSimulatedAdminPageLoadAction(options: WordPressPageLoadActionOptions = {}): RuntimeEpisodeActionSpec {
  return { command: "wordpress.simulated-admin-page-load", args: pageLoadActionArgs(options) }
}

export function wordpressFrontendPageLoadAction(options: WordPressPageLoadActionOptions = {}): RuntimeEpisodeActionSpec {
  return { command: "wordpress.frontend-page-load", args: pageLoadActionArgs(options) }
}

export function wordpressSimulatedFrontendPageLoadAction(options: WordPressPageLoadActionOptions = {}): RuntimeEpisodeActionSpec {
  return { command: "wordpress.simulated-frontend-page-load", args: pageLoadActionArgs(options) }
}

export function wordpressServerPageLoadAction(options: WordPressPageLoadActionOptions = {}): RuntimeEpisodeActionSpec {
  return { command: "wordpress.server-page-load", args: pageLoadActionArgs(options) }
}

export function wordpressBrowserPageLoadAction(options: WordPressPageLoadActionOptions = {}): RuntimeEpisodeActionSpec {
  return { command: "wordpress.browser-page-load", args: pageLoadActionArgs(options) }
}

export { browserArtifactMetrics, createPlaygroundRuntimeBackend }
export type { BrowserArtifactMetricsResult, PlaygroundRuntimeBackendOptions }

function wordPressRuntimeCreateSpec(spec: WordPressRuntimeSpec): RuntimeCreateSpec {
  return {
    ...spec,
    backend: "wordpress-playground",
  }
}

function pageLoadActionArgs(options: WordPressPageLoadActionOptions): string[] {
  return [
    ...(options.path ? [`path=${options.path}`] : []),
    ...(options.surface ? [`surface=${options.surface}`] : []),
    ...(options.url ? [`url=${options.url}`] : []),
    ...(options.method ? [`method=${options.method}`] : []),
    ...(options.query ? [`query-json=${JSON.stringify(options.query)}`] : []),
    ...(options.body ? [`body-json=${JSON.stringify(options.body)}`] : []),
    ...(options.capture && Object.keys(options.capture).length > 0 ? [`capture-json=${JSON.stringify(options.capture)}`] : []),
    ...(typeof options.enableQueryCapture === "boolean" ? [`enable-query-capture=${options.enableQueryCapture ? "true" : "false"}`] : []),
    ...(options.user ? [`user=${options.user}`] : []),
    ...(options.session ? [`session=${options.session}`] : []),
    ...(options.captureDiagnostics?.length ? [`capture-diagnostics=${options.captureDiagnostics.join(",")}`] : []),
  ]
}
