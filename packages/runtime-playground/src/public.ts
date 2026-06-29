import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { benchRunCode } from "./bench-command-handlers.js"

import {
  ArtifactBundleWriter,
  artifactFileDigest,
  artifactStoragePath,
  resolveArtifactPath,
  WORDPRESS_HOTSPOTS_SCHEMA,
  QUERY_OBSERVATION_SCHEMA,
  createRuntime,
  createRuntimeEpisode,
  createWordPressRuntimeCheckpoint,
  describeWordPressExecutionSurfaces,
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
  queryObservationArtifact,
  wordpressRuntimeDiscoveryToCoveragePlan,
  fuzzArtifactBundleContract,
  fuzzMinimizeUnsupportedCapability,
  fuzzReplayCaseRef,
  invokeWordPressCronEvent,
  invokeWordPressHook,
  invokeWordPressWpCli,
  runtimeArtifactStorageDescriptor,
  deleteBoundaryArtifact,
  isRestMutationMethod,
  mutationArtifactDigest,
  mutationIsolationArtifact,
  sandboxIsolationProof,
  sandboxIsolationProofDigest,
  wordpressRollbackArtifact,
  wordpressDbWriteSetArtifact,
  WORDPRESS_DB_WRITE_SET_ARTIFACT_KIND,
  WORDPRESS_DB_WRITE_SET_SCHEMA,
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
  type FuzzReplayCaseRef,
  type FuzzSuiteResetExecutor,
  type FuzzSuiteResultEnvelope,
  type FuzzSuiteRuntimeActionExecutor,
  type FuzzSuiteRuntimeActionExecutionInput,
  type FuzzSuiteRuntimeWorkloadExecutor,
  type FuzzSuiteRunOptions,
  type ObservationSpec,
  type PerformanceObservation,
  type Runtime,
  type RuntimeArtifactStorageDescriptor,
  type RuntimeArtifactStorageInput,
  type RuntimeActionObservation,
  type RuntimeCreateSpec,
  type RuntimeEpisode,
  type RuntimeEpisodeActionSpec,
  type RuntimeEpisodeContentDigest,
  type RuntimeEpisodeTraceRef,
  type RuntimeEpisodeSpec,
  type RuntimeEpisodeStepResult,
  type Snapshot,
  type WordPressRollbackArtifact,
  type WordPressHotspotObservationInput,
  type QueryObservationArtifact,
  type QueryObservationFingerprint,
  type QueryObservationOperation,
  type QueryObservationTableRef,
  type DisposableDestructiveSandboxBoundaryEvidence,
  type DisposableSandboxTeardownEvidence,
  type SandboxIsolationProof,
  type SandboxIsolationProofStepEvidence,
  type WordPressDbWriteSetArtifact,
  type WordPressDbWriteSetEntry,
} from "@automattic/wp-codebox-core/public"
export {
  collectWordPressArtifacts,
  describeWordPressExecutionSurfaces,
  discoverWordPressRuntime,
  executeFuzzSuite,
  executeWordPressRestMatrix,
  wordpressHotspotsArtifact,
  createWordPressRuntimeCheckpoint,
  inventoryWordPressAdminPages,
  inventoryWordPressDatabase,
  inventoryWordPressFrontendUrls,
  inventoryWordPressRestRoutes,
  invokeWordPressCronEvent,
  invokeWordPressHook,
  invokeWordPressWpCli,
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
  type WordPressExecutionSurfaceOptions,
  type WordPressInvokeCronEventOptions,
  type WordPressInvokeHookOptions,
  type WordPressInvokeWpCliOptions,
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
  type QueryObservationArtifact,
  type QueryObservationFingerprint,
  type QueryObservationDuplicateGroup,
  type QueryObservationTableRef,
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
  artifactStorage?: RuntimeArtifactStorageInput | RuntimeArtifactStorageDescriptor
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
          return executeDisposableSandboxRestMutation(episode, { ...input, action })
        }
        return requestWordPressRest(episode, action)
      }
      if (action.type === "crud_operation") {
        if (action.operation === "create" || action.operation === "update" || action.operation === "delete") {
          return executeDisposableSandboxCrudMutation(episode, { ...input, action })
        }
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
          return executeDisposableSandboxDbMutation(episode, { ...input, action })
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
      if (action.type === "wordpress_hook") {
        const step = await invokeWordPressHook(episode, {
          hook: action.hook,
          args: action.args,
          mutates: action.mutates,
          capability: action.capability,
          destructiveBoundary: action.destructive_boundary,
          timeoutMs: action.timeout_ms,
        })
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
      if (action.type === "wordpress_cron_event") {
        const step = await invokeWordPressCronEvent(episode, {
          hook: action.hook,
          operation: action.operation,
          args: action.args,
          timestamp: action.timestamp,
          mutates: action.mutates,
          capability: action.capability,
          destructiveBoundary: action.destructive_boundary,
          timeoutMs: action.timeout_ms,
        })
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

async function executeDisposableSandboxDbMutation(
  episode: Pick<RuntimeEpisode, "step">,
  input: FuzzSuiteRuntimeActionExecutionInput & { action: Extract<FuzzSuiteRuntimeActionExecutionInput["action"], { type: "db_operation" }> },
): Promise<RuntimeActionObservation> {
  const sandboxBoundary = requireDisposableDestructiveSandboxBoundary(input.suite)
  const operation = normalizeWordPressDbOperation({
    schema: WORDPRESS_DB_OPERATION_SCHEMA,
    ...input.action,
    operation: "write",
    options: { ...(input.action.options ?? {}), destructivePermission: true },
    metadata: { ...(input.action.metadata ?? {}), disposableSandboxBoundary: sandboxBoundary, affectedRowsMayBeZeroOrUnknown: true },
  })
  const target = operation.resource?.table ?? operation.query?.table ?? "database"
  const mutation = typeof operation.options?.mutation === "string" ? operation.options.mutation.toUpperCase() : "WRITE"
  const step = await episode.step({ kind: "command", command: "wordpress.db-operation", args: [`operation-json=${JSON.stringify(operation)}`], ...(input.action.timeout_ms !== undefined ? { timeoutMs: input.action.timeout_ms } : {}) }, { type: "command-result" })
  const stdout = parseJsonRecord(step.execution.stdout) ?? step.execution.stdout
  const resultMetadata = recordValue(recordValue(stdout)?.metadata)
  const sandboxProof = disposableSandboxMutationProof({ operation: "db_operation", target, method: mutation, step, sandboxBoundary, suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex })
  const artifact = mutationIsolationArtifact({
    operation: "db_operation",
    target,
    method: mutation,
    sandboxBoundary,
    destructivePermission: true,
    mutationBoundary: { permission: "destructive", containment: "disposable-sandbox", artifactEvidence: "captured" },
    teardown: disposableSandboxTeardownEvidence(sandboxBoundary),
    afterObservation: mutationStepEvidence(step, "observed"),
    affectedIdentifiers: undefined,
    metadata: { suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex, sandboxIsolationProof: sandboxProof, affectedRows: resultMetadata?.affectedRows ?? null, affectedRowsMayBeZeroOrUnknown: true },
  })
  const artifactWithRef = { ...artifact, artifactPath: `files/mutation-isolation/${input.case.id}.json`, persisted: false }
  const content = `${JSON.stringify(artifactWithRef, null, 2)}\n`
  const artifactWithDigest = { ...artifactWithRef, sha256: mutationArtifactDigest(artifactWithRef), bytes: Buffer.byteLength(content) }
  const dbWriteSetArtifact = dbWriteSetArtifactFromCommandResult({ result: stdout, suiteId: input.suite.id, caseId: input.case.id, action: "db_operation", target, artifactPath: `files/db-write-sets/${input.case.id}.json`, artifactRefs: fuzzSuiteStepArtifactRefs(step) })
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
    ...(dbWriteSetArtifact ? { dbWriteSetArtifact } : {}),
    sandboxIsolationProof: sandboxProof,
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

async function executeDisposableSandboxCrudMutation(
  episode: Pick<RuntimeEpisode, "step">,
  input: FuzzSuiteRuntimeActionExecutionInput & { action: Extract<FuzzSuiteRuntimeActionExecutionInput["action"], { type: "crud_operation" }> },
): Promise<RuntimeActionObservation> {
  const sandboxBoundary = requireDisposableDestructiveSandboxBoundary(input.suite)
  const target = crudTarget(input.action)
  const action = { ...input.action, options: { ...(input.action.options ?? {}), destructivePermission: true }, metadata: { ...(input.action.metadata ?? {}), disposableSandboxBoundary: sandboxBoundary } }
  const step = await runWordPressCrudOperation(episode, action, input.action.timeout_ms)
  const stdout = parseJsonRecord(step.execution.stdout)
  const sandboxProof = disposableSandboxMutationProof({ operation: "crud_operation", target, method: input.action.operation.toUpperCase(), step, sandboxBoundary, suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex })
  const artifact = mutationIsolationArtifact({
    operation: "crud_operation",
    target,
    method: input.action.operation.toUpperCase(),
    sandboxBoundary,
    destructivePermission: true,
    mutationBoundary: { permission: "destructive", containment: "disposable-sandbox", artifactEvidence: "captured" },
    teardown: disposableSandboxTeardownEvidence(sandboxBoundary),
    afterObservation: mutationStepEvidence(step, "observed"),
    affectedIdentifiers: crudAffectedIdentifiers(input.action, stdout),
    metadata: { suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex, sandboxIsolationProof: sandboxProof },
  })
  const artifactWithRef = { ...artifact, artifactPath: `files/mutation-isolation/${input.case.id}.json`, persisted: false }
  const content = `${JSON.stringify(artifactWithRef, null, 2)}\n`
  const artifactWithDigest = { ...artifactWithRef, sha256: mutationArtifactDigest(artifactWithRef), bytes: Buffer.byteLength(content) }
  const dbWriteSetArtifact = dbWriteSetArtifactFromCommandResult({ result: stdout, suiteId: input.suite.id, caseId: input.case.id, action: "crud_operation", target, artifactPath: `files/db-write-sets/${input.case.id}.json`, artifactRefs: fuzzSuiteStepArtifactRefs(step) })
  const data = {
    stepId: step.id,
    executionId: step.execution.id,
    mappedCommand: step.execution.command,
    args: step.execution.args,
    exitCode: step.execution.exitCode,
    stdout: stdout ?? step.execution.stdout,
    stderr: step.execution.stderr,
    mutationIsolationArtifact: artifactWithDigest,
    ...(dbWriteSetArtifact ? { dbWriteSetArtifact } : {}),
    sandboxIsolationProof: sandboxProof,
  }
  return { schema: "wp-codebox/runtime-action-observation/v1", type: input.action.type, status: "ok", action: input.action, data, observedAt: new Date().toISOString(), step, artifactRefs: step.observation?.artifactRefs, digest: digestRuntimeActionObservationData(data) }
}

interface RollbackCaptureSpecInput {
  operation: string
  target: string
  action: object
  table?: string
  object?: { kind: string; id?: string | number; type?: string }
  options?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

interface RollbackCaptureSpec {
  schema: "wp-codebox/wordpress-rollback-capture-request/v1"
  operation: string
  target: string
  options: string[]
  tables: Array<{ table: string; where?: Record<string, unknown>; limit: number }>
  objects: Array<{ kind: string; id?: string | number; type?: string }>
}

function rollbackCaptureSpec(input: RollbackCaptureSpecInput): RollbackCaptureSpec {
  const configured = recordValue(input.options?.rollbackCapture ?? input.options?.rollback_capture ?? input.metadata?.rollbackCapture ?? input.metadata?.rollback_capture)
  const actionRecord = input.action as Record<string, unknown>
  const optionNames = stringList(configured?.options ?? configured?.optionNames ?? configured?.option_names)
  const tableSpecs = arrayValue(configured?.tables).flatMap((item) => {
    const record = recordValue(item)
    const table = stringValue(record?.table)
    return table ? [{ table, where: recordValue(record?.where), limit: boundedLimit(record?.limit) }] : []
  })
  const objectSpecs = arrayValue(configured?.objects).flatMap((item) => {
    const record = recordValue(item)
    const kind = stringValue(record?.kind)
    return kind ? [{ kind, id: scalarId(record?.id), type: stringValue(record?.type) }] : []
  })
  const affectedObjects = arrayValue(input.metadata?.affectedIdentifiers).flatMap((item) => {
    const record = recordValue(item)
    const kind = stringValue(record?.kind) ?? restPathObject(input.target)?.kind
    const id = scalarId(record?.id)
    return kind && id !== undefined ? [{ kind, id }] : []
  })
  const restObject = input.operation === "rest_request" ? restPathObject(input.target) : undefined
  const inferredOptions = input.object?.kind === "option" && typeof input.object.id === "string" ? [input.object.id] : []
  const query = recordValue(actionRecord.query)
  const tables = [
    ...tableSpecs,
    ...(input.table ? [{ table: input.table, where: recordValue(query?.where), limit: boundedLimit(query?.limit) }] : []),
  ]
  const objects = [...objectSpecs, ...affectedObjects, ...(input.object ? [input.object] : []), ...(restObject ? [restObject] : [])]
  return {
    schema: "wp-codebox/wordpress-rollback-capture-request/v1",
    operation: input.operation,
    target: input.target,
    options: [...new Set([...optionNames, ...inferredOptions])].sort(),
    tables: dedupeTableSpecs(tables),
    objects: dedupeObjectSpecs(objects),
  }
}

async function captureWordPressRollbackState(episode: Pick<RuntimeEpisode, "step">, caseId: string, phase: "before" | "after" | "restore", spec: RollbackCaptureSpec, timeoutMs: number | undefined): Promise<RuntimeEpisodeStepResult> {
  return episode.step({
    kind: "command",
    command: "wordpress.run-php",
    args: [`code=${wordpressRollbackCapturePhp(spec, phase)}`],
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    metadata: { caseId, phase, schema: spec.schema },
  }, { type: "command-result" })
}

function rollbackArtifactFromCaptures(input: { operation: string; target: string; beforeStep: RuntimeEpisodeStepResult; afterStep: RuntimeEpisodeStepResult; restoreStep: RuntimeEpisodeStepResult; restoreCommandStep: RuntimeEpisodeStepResult; metadata: Record<string, unknown> }): WordPressRollbackArtifact {
  const before = parseRollbackCapture(input.beforeStep)
  const after = parseRollbackCapture(input.afterStep)
  const restored = parseRollbackCapture(input.restoreStep)
  const options = diffNamedRecords(recordValue(before?.options), recordValue(after?.options), recordValue(restored?.options)).map((entry) => ({ name: entry.name, changed: entry.changed, before: entry.before, after: entry.after, restored: entry.restored, restoreMatchesBefore: entry.restoreMatchesBefore }))
  const tables = diffNamedRecords(recordValue(before?.tables), recordValue(after?.tables), recordValue(restored?.tables)).map((entry) => ({ table: entry.name, changed: entry.changed, before: entry.before, after: entry.after, restored: entry.restored, restoreMatchesBefore: entry.restoreMatchesBefore }))
  const objects = diffNamedRecords(recordValue(before?.objects), recordValue(after?.objects), recordValue(restored?.objects)).map((entry) => {
    const [kind, id] = entry.name.split(":", 2)
    return { kind, id, changed: entry.changed, before: entry.before, after: entry.after, restored: entry.restored, restoreMatchesBefore: entry.restoreMatchesBefore }
  })
  const restoreCommandPassed = input.restoreCommandStep.execution.exitCode === 0
  const capturePassed = input.beforeStep.execution.exitCode === 0 && input.afterStep.execution.exitCode === 0 && input.restoreStep.execution.exitCode === 0
  const allRestored = [...options, ...tables, ...objects].every((entry) => entry.restoreMatchesBefore)
  const evidenceExists = options.length + tables.length + objects.length > 0
  const restoredOk = restoreCommandPassed && capturePassed && evidenceExists && allRestored
  const diagnostics = [
    ...(!evidenceExists ? [{ severity: "error" as const, code: "rollback-evidence-missing", message: "Rollback capture produced no supported option, table, or object evidence." }] : []),
    ...(!capturePassed ? [{ severity: "error" as const, code: "rollback-capture-failed", message: "Rollback capture command failed.", metadata: { beforeExitCode: input.beforeStep.execution.exitCode, afterExitCode: input.afterStep.execution.exitCode, restoreExitCode: input.restoreStep.execution.exitCode } }] : []),
    ...(restoreCommandPassed && !allRestored ? [{ severity: "error" as const, code: "rollback-restore-validation-failed", message: "Post-restore capture does not match the before capture." }] : []),
  ]
  return wordpressRollbackArtifact({
    operation: input.operation,
    target: input.target,
    lifecycle: {
      before: { ...mutationStepEvidence(input.beforeStep, input.beforeStep.execution.exitCode === 0 ? "captured" : "failed"), capture: before },
      after: { ...mutationStepEvidence(input.afterStep, input.afterStep.execution.exitCode === 0 ? "captured" : "failed"), capture: after },
      restore: { ...mutationStepEvidence(input.restoreStep, input.restoreStep.execution.exitCode === 0 ? "restored" : "failed"), capture: restored },
    },
    result: { status: restoredOk ? "passed" : "failed", restored: restoredOk, validation: restoredOk ? "matched-before" : evidenceExists ? "mismatch" : "not-validated" },
    diff: { options, tables, objects },
    changedOptions: options.filter((entry) => entry.changed).map((entry) => entry.name),
    changedTables: tables.filter((entry) => entry.changed).map((entry) => entry.table),
    changedObjects: objects.filter((entry) => entry.changed).map((entry) => ({ kind: entry.kind, id: entry.id ?? `${entry.kind}:unknown`, source: "rollback-diff" })),
    diagnostics,
    metadata: input.metadata,
  })
}

function parseRollbackCapture(step: RuntimeEpisodeStepResult): Record<string, unknown> | undefined {
  return recordValue(step.execution.result?.json) ?? parseJsonRecord(step.execution.stdout)
}

function diffNamedRecords(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, restored: Record<string, unknown> | undefined): Array<{ name: string; changed: boolean; before?: unknown; after?: unknown; restored?: unknown; restoreMatchesBefore: boolean }> {
  const names = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {}), ...Object.keys(restored ?? {})])].sort()
  return names.map((name) => {
    const beforeValue = before?.[name]
    const afterValue = after?.[name]
    const restoredValue = restored?.[name]
    return { name, changed: stableJson(beforeValue) !== stableJson(afterValue), before: beforeValue, after: afterValue, restored: restoredValue, restoreMatchesBefore: stableJson(beforeValue) === stableJson(restoredValue) }
  })
}

function wordpressRollbackCapturePhp(spec: RollbackCaptureSpec, phase: string): string {
  const encoded = Buffer.from(JSON.stringify({ ...spec, phase }), "utf8").toString("base64")
  return `/* wp-codebox/wordpress-rollback-capture-request/v1 */\n$__wp_codebox_spec = json_decode(base64_decode('${encoded}'), true);\n$__wp_codebox_out = array('schema' => 'wp-codebox/wordpress-rollback-capture/v1', 'phase' => $__wp_codebox_spec['phase'], 'target' => $__wp_codebox_spec['target'], 'options' => array(), 'tables' => array(), 'objects' => array(), 'diagnostics' => array());\n$__wp_codebox_alloptions = wp_load_alloptions();\nforeach ((array) ($__wp_codebox_spec['options'] ?? array()) as $__name) { $__exists = array_key_exists($__name, $__wp_codebox_alloptions) || null !== get_option($__name, null); $__wp_codebox_out['options'][$__name] = array('exists' => $__exists, 'value' => get_option($__name, null)); }\nglobal $wpdb;\nforeach ((array) ($__wp_codebox_spec['tables'] ?? array()) as $__table_spec) { $__table = preg_replace('/[^A-Za-z0-9_]/', '', (string) ($__table_spec['table'] ?? '')); if ('' === $__table) { continue; } $__where = (array) ($__table_spec['where'] ?? array()); $__limit = max(1, min(50, (int) ($__table_spec['limit'] ?? 25))); $__clauses = array(); $__values = array(); foreach ($__where as $__key => $__value) { if (! is_scalar($__value) && null !== $__value) { continue; } $__clauses[] = preg_replace('/[^A-Za-z0-9_]/', '', (string) $__key) . ' = %s'; $__values[] = (string) $__value; } $__sql = 'SELECT * FROM ' . $__table . (count($__clauses) ? ' WHERE ' . implode(' AND ', $__clauses) : '') . ' ORDER BY 1 LIMIT ' . $__limit; $__rows = empty($__values) ? $wpdb->get_results($__sql, ARRAY_A) : $wpdb->get_results($wpdb->prepare($__sql, $__values), ARRAY_A); $__wp_codebox_out['tables'][$__table] = array('rows' => is_array($__rows) ? $__rows : array(), 'row_count' => is_array($__rows) ? count($__rows) : 0); }\nforeach ((array) ($__wp_codebox_spec['objects'] ?? array()) as $__object) { $__kind = (string) ($__object['kind'] ?? ''); $__id = $__object['id'] ?? null; $__key = $__kind . ':' . (null === $__id ? 'unknown' : (string) $__id); if ('post' === $__kind && $__id) { $__post = get_post($__id, ARRAY_A); $__wp_codebox_out['objects'][$__key] = $__post ? array('exists' => true, 'value' => $__post, 'meta' => get_post_meta($__id)) : array('exists' => false); } elseif ('term' === $__kind && $__id) { $__term = get_term($__id, (string) ($__object['type'] ?? '')); $__wp_codebox_out['objects'][$__key] = (! is_wp_error($__term) && $__term) ? array('exists' => true, 'value' => (array) $__term, 'meta' => get_term_meta($__id)) : array('exists' => false); } elseif ('user' === $__kind && $__id) { $__user = get_user_by('id', $__id); $__wp_codebox_out['objects'][$__key] = $__user ? array('exists' => true, 'value' => $__user->to_array(), 'meta' => get_user_meta($__id)) : array('exists' => false); } elseif ('comment' === $__kind && $__id) { $__comment = get_comment($__id, ARRAY_A); $__wp_codebox_out['objects'][$__key] = $__comment ? array('exists' => true, 'value' => $__comment, 'meta' => get_comment_meta($__id)) : array('exists' => false); } elseif ('option' === $__kind && is_string($__id)) { $__exists = array_key_exists($__id, $__wp_codebox_alloptions) || null !== get_option($__id, null); $__wp_codebox_out['objects'][$__key] = array('exists' => $__exists, 'value' => get_option($__id, null)); } }\necho wp_json_encode($__wp_codebox_out, JSON_UNESCAPED_SLASHES) . "\\n";`
}

function crudTarget(action: object): string {
  const resource = recordValue((action as Record<string, unknown>).resource)
  return [stringValue(resource?.kind), stringValue(resource?.type), scalarId(resource?.id)].filter((value) => value !== undefined).join(":") || "crud-object"
}

function crudCaptureObject(action: object, result?: Record<string, unknown>): { kind: string; id?: string | number; type?: string } | undefined {
  const resource = recordValue((action as Record<string, unknown>).resource)
  const kind = stringValue(resource?.kind)
  if (!kind) return undefined
  const resultItem = recordValue(result?.item) ?? recordValue(result?.data) ?? result
  return { kind, type: stringValue(resource?.type), id: scalarId(resource?.id ?? resultItem?.id) }
}

function crudAffectedIdentifiers(action: object, result?: Record<string, unknown>) {
  const object = crudCaptureObject(action, result)
  return object?.id !== undefined ? [{ kind: object.kind, id: object.id, source: "crud-result" }] : undefined
}

function restPathObject(path: string): { kind: string; id?: string | number; type?: string } | undefined {
  const match = path.match(/^\/wp\/v2\/(posts|pages|users|comments|categories|tags)\/(\d+)/)
  if (!match) return undefined
  const [, collection, id] = match
  const kind = collection === "users" ? "user" : collection === "comments" ? "comment" : collection === "categories" || collection === "tags" ? "term" : "post"
  return { kind, id: Number(id), type: collection === "categories" ? "category" : collection === "tags" ? "post_tag" : collection === "pages" ? "page" : collection === "posts" ? "post" : undefined }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []))] : []
}

function scalarId(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(50, Math.trunc(value))) : 25
}

function dedupeTableSpecs(tables: RollbackCaptureSpec["tables"]): RollbackCaptureSpec["tables"] {
  const seen = new Set<string>()
  return tables.filter((table) => {
    const key = `${table.table}:${stableJson(table.where ?? {})}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeObjectSpecs(objects: RollbackCaptureSpec["objects"]): RollbackCaptureSpec["objects"] {
  const seen = new Set<string>()
  return objects.filter((object) => {
    const key = `${object.kind}:${object.type ?? ""}:${object.id ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function dbWriteSetArtifactFromCommandResult(input: { result: unknown; suiteId: string; caseId: string; action: string; target: string; artifactPath: string; artifactRefs?: FuzzSuiteArtifactRef[] }): (WordPressDbWriteSetArtifact & { artifactPath: string; persisted: false; sha256: string; bytes: number }) | undefined {
  const result = recordValue(input.result)
  const stdout = recordValue(result?.stdout)
  const metadata = recordValue(result?.metadata)
  const stdoutMetadata = recordValue(stdout?.metadata)
  const performance = recordValue(result?.performance ?? stdout?.performance)
  const database = recordValue(performance?.database)
  const candidate = recordValue(metadata?.dbWriteSet ?? metadata?.db_write_set ?? stdoutMetadata?.dbWriteSet ?? stdoutMetadata?.db_write_set ?? result?.dbWriteSet ?? result?.db_write_set ?? stdout?.dbWriteSet ?? stdout?.db_write_set ?? database?.dbWriteSet ?? database?.db_write_set)
  const entries = dbWriteSetEntries(candidate?.entries ?? database?.writeSet ?? database?.write_set)
  if (entries.length === 0) return undefined
  const repeatedWrites = dbWriteSetEntries(candidate?.repeatedWrites ?? candidate?.repeated_writes ?? database?.repeatedWrites ?? database?.repeated_writes).filter((entry) => (entry.repeatedWritesToSameKey ?? 0) > 1)
  const artifact = wordpressDbWriteSetArtifact({
    suiteId: input.suiteId,
    caseId: input.caseId,
    action: input.action,
    target: input.target,
    entries,
    repeatedWrites,
    artifactRefs: input.artifactRefs,
    metadata: stripUndefined({ source: "runtime-command-result", resultStatus: stringValue(result?.status), command: stringValue(result?.command), queryCount: typeof database?.queryCount === "number" ? database.queryCount : undefined, writeSetTruncated: candidate?.metadata ? recordValue(candidate.metadata)?.writeSetTruncated : database?.writeSetTruncated }),
  })
  const artifactWithRef = { ...artifact, artifactPath: input.artifactPath, persisted: false as const }
  const content = `${JSON.stringify(artifactWithRef, null, 2)}\n`
  return { ...artifactWithRef, sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) }
}

function dbWriteSetEntries(value: unknown): WordPressDbWriteSetEntry[] {
  return arrayValue(value).flatMap((item) => {
    const entry = recordValue(item)
    const table = stringValue(entry?.table)
    const operation = stringValue(entry?.operation)?.toLowerCase()
    if (!table || (operation !== "insert" && operation !== "update" && operation !== "delete" && operation !== "replace")) return []
    return [stripUndefined({
      table,
      operation: operation as WordPressDbWriteSetEntry["operation"],
      rowsAffected: nullableNumber(entry?.rowsAffected ?? entry?.rows_affected),
      rowCountBefore: nullableNumber(entry?.rowCountBefore ?? entry?.row_count_before),
      rowCountAfter: nullableNumber(entry?.rowCountAfter ?? entry?.row_count_after),
      resource: recordValue(entry?.resource),
      object: recordValue(entry?.object) as WordPressDbWriteSetEntry["object"],
      key: stringValue(entry?.key),
      repeatedWritesToSameKey: typeof entry?.repeatedWritesToSameKey === "number" ? entry.repeatedWritesToSameKey : (typeof entry?.repeated_writes_to_same_key === "number" ? entry.repeated_writes_to_same_key : undefined),
      source: recordValue(entry?.source),
      metadata: recordValue(entry?.metadata),
    })]
  })
}

export function createWordPressFuzzSuiteCommandExecutor(episode: Pick<RuntimeEpisode, "step">): FuzzSuiteCommandExecutor {
  return {
    async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
      const step = await episode.step({ kind: "command", ...spec }, { type: "command-result" })
      return step.execution
    },
  }
}

function requireDisposableDestructiveSandboxBoundary(suite: FuzzSuiteContract): DisposableDestructiveSandboxBoundaryEvidence {
  const boundary = recordValue(suite.metadata?.disposableSandboxBoundary)
  const teardown = stringValue(boundary?.teardown)
  if (boundary?.disposable !== true || boundary?.destructivePermission !== true || !teardown) {
    throw new Error("Destructive WordPress fuzz mutations require suite.metadata.disposableSandboxBoundary with disposable=true, destructivePermission=true, and teardown=discard or destroy.")
  }
  if (teardown !== "discard" && teardown !== "destroy") {
    throw new Error("Destructive WordPress fuzz mutations require disposable sandbox teardown=discard or destroy.")
  }
  return stripUndefined({
    disposable: true,
    destructivePermission: true,
    teardown,
    backend: stringValue(boundary.backend) ?? "wordpress-playground",
    environment: stringValue(boundary.environment) ?? "wordpress",
    hostAccess: stringValue(boundary.hostAccess) ?? "declared-mounts-only",
    metadata: recordValue(boundary.metadata),
  }) as DisposableDestructiveSandboxBoundaryEvidence
}

function disposableSandboxTeardownEvidence(boundary: DisposableDestructiveSandboxBoundaryEvidence): DisposableSandboxTeardownEvidence {
  const intent = boundary.teardown === "destroy" ? "destroy" : "discard"
  return {
    intent,
    status: "intended" as const,
    evidence: "Disposable WP Codebox sandbox will be discarded after the fuzz run.",
    metadata: { backend: boundary.backend, hostAccess: boundary.hostAccess },
  }
}

function disposableSandboxMutationProof(input: { operation: string; target: string; method: string; step: RuntimeEpisodeStepResult; sandboxBoundary: DisposableDestructiveSandboxBoundaryEvidence; suiteId: string; caseId: string; caseIndex: number }): SandboxIsolationProof {
  const proof = sandboxIsolationProof({
    status: input.step.execution.exitCode === 0 ? "passed" : "failed",
    baseline: { status: "created", command: "wp-codebox.disposable-sandbox-boundary", metadata: input.sandboxBoundary as unknown as Record<string, unknown> },
    mutation: mutationStepEvidence(input.step, "mutated") as SandboxIsolationProofStepEvidence & { status: "mutated" },
    diff: { status: "not-required-disposable-sandbox", changed: true, metadata: { reason: "Disposable sandbox boundary is the destructive mutation proof; rollback validation is optional debug metadata." } },
    runtimeBoundary: {
      backend: input.sandboxBoundary.backend ?? "wordpress-playground",
      environment: input.sandboxBoundary.environment ?? "wordpress",
      disposable: true,
      hostAccess: "declared-mounts-only",
      destroy: { status: input.sandboxBoundary.teardown === "destroy" ? "destroyed" : "discarded", command: "wp-codebox.disposable-sandbox-teardown", metadata: { intent: input.sandboxBoundary.teardown } },
    },
    artifacts: [{ path: `files/sandbox-isolation/${input.caseId}-proof.json`, kind: "sandbox-isolation-proof" }],
    metadata: { suiteId: input.suiteId, caseId: input.caseId, caseIndex: input.caseIndex, operation: input.operation, target: input.target, method: input.method },
  })
  const artifactPath = `files/sandbox-isolation/${input.caseId}-proof.json`
  const proofWithRef = { ...proof, artifactPath }
  const content = `${JSON.stringify(proofWithRef, null, 2)}\n`
  return { ...proofWithRef, sha256: sandboxIsolationProofDigest(proofWithRef), bytes: Buffer.byteLength(content) }
}

async function executeDisposableSandboxRestMutation(
  episode: Pick<RuntimeEpisode, "step">,
  input: FuzzSuiteRuntimeActionExecutionInput & { action: Extract<FuzzSuiteRuntimeActionExecutionInput["action"], { type: "rest_request" }> },
): Promise<RuntimeActionObservation> {
  const sandboxBoundary = requireDisposableDestructiveSandboxBoundary(input.suite)
  const method = (input.action.method ?? "GET").toUpperCase()
  const target = input.action.path
  const observation = await requestWordPressRest(episode, { ...input.action, capture: { ...(input.action.capture ?? {}), queries: true }, enableQueryCapture: true })
  if (!observation.step) {
    throw new Error(`Destructive REST mutation ${input.case.id} did not return runtime step evidence.`)
  }
  const affectedIdentifiers = restMutationAffectedIdentifiers(observation)
  const status = restObservationStatus(observation)
  const sandboxProof = disposableSandboxMutationProof({ operation: "rest_request", target, method, step: observation.step, sandboxBoundary, suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex })
  const baseArtifact = {
    operation: "rest_request" as const,
    target,
    method,
    status,
    sandboxBoundary,
    destructivePermission: true as const,
    mutationBoundary: { permission: "destructive" as const, containment: "disposable-sandbox" as const, artifactEvidence: "captured" as const },
    teardown: disposableSandboxTeardownEvidence(sandboxBoundary),
    afterObservation: mutationStepEvidence(observation.step, "observed"),
    affectedIdentifiers,
    metadata: { suiteId: input.suite.id, caseId: input.case.id, caseIndex: input.caseIndex, sandboxIsolationProof: sandboxProof },
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
  const dbWriteSetArtifact = dbWriteSetArtifactFromCommandResult({ result: observation.data, suiteId: input.suite.id, caseId: input.case.id, action: "rest_request", target, artifactPath: `files/db-write-sets/${input.case.id}.json`, artifactRefs: observation.step ? fuzzSuiteStepArtifactRefs(observation.step) : undefined })
  const data = {
    ...observation.data,
    ...(method === "DELETE" ? { deleteBoundaryArtifact: artifactWithDigest } : { mutationIsolationArtifact: artifactWithDigest }),
    ...(dbWriteSetArtifact ? { dbWriteSetArtifact } : {}),
    sandboxIsolationProof: sandboxProof,
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
      const steps = [...await workloadSteps(workload.before, workload, fuzzCase), ...await workloadSteps(workload.steps, workload, fuzzCase), ...await workloadSteps(workload.after, workload, fuzzCase)]
      const startedAt = new Date().toISOString()
      const executions: ExecutionResult[] = []
      for (const [stepIndex, step] of steps.entries()) {
        const result = await episode.step({ kind: "command", command: step.command, args: step.args, timeoutMs: step.timeoutMs, metadata: stripUndefined({ ...step.metadata, phase: step.phase, phaseIndex: step.phaseIndex, workloadStepIndex: stepIndex }) }, { type: "command-result" })
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
      const workloadResult = { schema: "wp-codebox/wordpress-workload-run-result/v1", caseId: fuzzCase.id, steps: executions.length, phases: steps.slice(0, executions.length).map((step, index) => stripUndefined({ index, phase: step.phase, command: step.command })), exitCode: failed ? failed.exitCode : 0, observations: observations.length > 0 ? observations : undefined }
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
  const playgroundSuite = {
    ...suite,
    metadata: stripUndefined({
      ...suite.metadata,
      disposableSandboxBoundary: recordValue(suite.metadata?.disposableSandboxBoundary) ?? {
        disposable: true,
        destructivePermission: true,
        teardown: "discard",
        backend: "wordpress-playground",
        hostAccess: "declared-mounts-only",
      },
    }),
  }

  return executeFuzzSuite(playgroundSuite, {
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
  }).then((result) => resultWithWordPressHotspotsArtifact(result, hotspotObservations, options))
}

async function resultWithWordPressHotspotsArtifact(result: FuzzSuiteResultEnvelope, observations: WordPressHotspotObservationInput[], options: WordPressFuzzSuiteExecutionOptions = {}): Promise<FuzzSuiteResultEnvelope> {
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
  const queryObservations = queryObservationArtifactsFromFuzzResult(result)
  const durableBundle = options.artifactStorage
    ? await writeFuzzArtifactBundle({ result, artifact, observationSet, hotspotSet, queryObservations, content, observationContent, hotspotContent, artifactStorage: options.artifactStorage })
    : undefined
  const artifactMetadata = {
    wordpressHotspots: durableBundle?.wordpressHotspots ?? inlineArtifactMetadata("wordpress-hotspots", WORDPRESS_HOTSPOTS_SCHEMA, content),
    fuzzObservationSet: durableBundle?.fuzzObservationSet ?? inlineArtifactMetadata("fuzz-observation-set", "wp-codebox/fuzz-observation-set/v1", observationContent),
    fuzzHotspotSet: durableBundle?.fuzzHotspotSet ?? inlineArtifactMetadata("fuzz-hotspot-set", "wp-codebox/fuzz-hotspot-set/v1", hotspotContent),
    queryObservations: durableBundle?.queryObservations ?? inlineQueryObservationMetadata(queryObservations),
    fuzzBundle: durableBundle?.contract,
  }
  const artifactRefs = dedupeFuzzSuiteArtifactRefs([...(result.artifactRefs ?? []), ...(durableBundle?.artifactRefs ?? [])])
  const linkedMetadataArtifacts = {
    ...(recordValue(result.metadata?.artifacts) ?? {}),
    ...artifactMetadata,
  }
  const resultArtifactContent = `${JSON.stringify({ ...result, artifactRefs, metadata: { ...result.metadata, artifacts: linkedMetadataArtifacts } }, null, 2)}\n`
  const resultMetadata = durableBundle ? await durableBundle.writeResult(resultArtifactContent) : inlineArtifactMetadata("fuzz-suite-result", result.schema, resultArtifactContent)

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

async function writeFuzzArtifactBundle(input: {
  result: FuzzSuiteResultEnvelope
  artifact: unknown
  observationSet: unknown
  hotspotSet: unknown
  queryObservations: QueryObservationArtifact[]
  content: string
  observationContent: string
  hotspotContent: string
  artifactStorage: RuntimeArtifactStorageInput | RuntimeArtifactStorageDescriptor
}) {
  const storage = runtimeArtifactStorageDescriptor(input.artifactStorage)
  const bundlePath = `fuzz/${safeArtifactSegment(input.result.suite.id)}`
  const bundleDirectory = resolveArtifactPath(storage.root, [storage.pathPrefix, bundlePath].filter(Boolean).join("/")).absolutePath
  const writer = new ArtifactBundleWriter(bundleDirectory)
  const artifactRefs: FuzzSuiteArtifactRef[] = []

  const wordpressHotspots = await writeFuzzJsonArtifact(writer, storage, bundlePath, "files/hotspots/wordpress-hotspots.json", "wordpress-hotspots", WORDPRESS_HOTSPOTS_SCHEMA, input.content, input.artifact)
  const fuzzObservationSet = await writeFuzzJsonArtifact(writer, storage, bundlePath, "files/hotspots/fuzz-observations.json", "fuzz-observation-set", "wp-codebox/fuzz-observation-set/v1", input.observationContent, input.observationSet)
  const fuzzHotspotSet = await writeFuzzJsonArtifact(writer, storage, bundlePath, "files/hotspots/fuzz-hotspots.json", "fuzz-hotspot-set", "wp-codebox/fuzz-hotspot-set/v1", input.hotspotContent, input.hotspotSet)
  const caseStreamContent = input.result.cases.map((item) => JSON.stringify(item)).join("\n") + (input.result.cases.length > 0 ? "\n" : "")
  const caseResultStream = await writeFuzzJsonArtifact(writer, storage, bundlePath, "files/cases/case-results.ndjson", "fuzz-case-result-stream", "wp-codebox/fuzz-case-result-stream/v1", caseStreamContent, undefined, "application/x-ndjson")
  const replayCaseRefs: FuzzReplayCaseRef[] = []
  const queryObservationArtifacts: Array<ReturnType<typeof queryObservationArtifactMetadata>> = []

  artifactRefs.push(wordpressHotspots.ref, fuzzObservationSet.ref, fuzzHotspotSet.ref, caseResultStream.ref)

  for (const [index, observation] of input.queryObservations.entries()) {
    const path = `files/query-observations/${safeArtifactSegment(observation.caseId ?? "case")}-${index + 1}.json`
    const content = `${JSON.stringify(observation, null, 2)}\n`
    const written = await writeFuzzJsonArtifact(writer, storage, bundlePath, path, "query-observation", QUERY_OBSERVATION_SCHEMA, content, observation)
    artifactRefs.push(written.ref)
    queryObservationArtifacts.push(queryObservationArtifactMetadata(observation, written.ref))
  }

  for (const fuzzCase of input.result.cases) {
    const dbWriteSet = recordValue(fuzzCase.metadata?.dbWriteSet)
    const caseArtifactRefs = [...(fuzzCase.artifactRefs ?? [])]
    if (dbWriteSet) {
      const path = `files/db-write-sets/${safeArtifactSegment(fuzzCase.id)}.json`
      const content = `${JSON.stringify({ ...dbWriteSet, artifactPath: path, persisted: true }, null, 2)}\n`
      const written = await writeFuzzJsonArtifact(writer, storage, bundlePath, path, WORDPRESS_DB_WRITE_SET_ARTIFACT_KIND, WORDPRESS_DB_WRITE_SET_SCHEMA, content, dbWriteSet)
      artifactRefs.push(written.ref)
      caseArtifactRefs.push(written.ref)
      fuzzCase.artifactRefs = dedupeFuzzSuiteArtifactRefs(caseArtifactRefs)
      fuzzCase.metadata = { ...fuzzCase.metadata, dbWriteSet: { ...dbWriteSet, artifactPath: written.ref.path, persisted: true, sha256: written.ref.sha256, bytes: written.ref.bytes } }
    }
    const replayInput = {
      schema: "wp-codebox/fuzz-replay-case-input/v1",
      suite: input.result.suite,
      case: fuzzCase,
      replay: recordValue(fuzzCase.metadata?.replay),
      artifactRefs: fuzzCase.artifactRefs ?? [],
      reset: fuzzCase.reset,
    }
    const content = `${JSON.stringify(replayInput, null, 2)}\n`
    const path = `files/replay-cases/${safeArtifactSegment(fuzzCase.id)}.json`
    const replayArtifact = await writeFuzzJsonArtifact(writer, storage, bundlePath, path, "fuzz-replay-case", "wp-codebox/fuzz-replay-case-input/v1", content, replayInput)
    artifactRefs.push(replayArtifact.ref)
    replayCaseRefs.push(fuzzReplayCaseRef({
      caseId: fuzzCase.id,
      path: replayArtifact.ref.path,
      sha256: replayArtifact.ref.sha256,
      bytes: replayArtifact.ref.bytes,
      target: fuzzCase.target,
      status: fuzzCase.status,
      metadata: { storage: "runtime-artifact-layout" },
    }))
  }

  const createdAt = new Date().toISOString()
  const manifestInput: ArtifactManifest = {
    id: `${input.result.suite.id}-fuzz-artifacts`,
    contentDigest: { algorithm: "sha256", inputs: [], value: "0".repeat(64) },
    createdAt,
    runtime: { id: "wordpress-playground", backend: "wordpress-playground", environment: { kind: "wordpress", name: "WordPress" }, createdAt, status: "created" },
    files: [],
  }
  const manifest = await writer.writeManifest(manifestInput)
  const manifestRef = fuzzArtifactRef(storage, bundlePath, "manifest.json", "manifest", "application/json", manifest.files.find((file) => file.path === "manifest.json")?.sha256.value)
  artifactRefs.push(manifestRef)

  const resultPath = "result/fuzz-suite-result.json"
  const contract = fuzzArtifactBundleContract({
    suiteId: input.result.suite.id,
    path: artifactStoragePath(storage, bundlePath),
    manifestPath: manifestRef.path,
    resultRef: fuzzArtifactRef(storage, bundlePath, resultPath, "fuzz-suite-result", "application/json"),
    caseResultStreamRef: caseResultStream.ref,
    replayCaseRefs,
    hotspotRefs: [wordpressHotspots.ref, fuzzObservationSet.ref, fuzzHotspotSet.ref],
    minimize: fuzzMinimizeUnsupportedCapability({ reason: "Fuzz case minimization is not implemented by this runner contract yet.", requiredArtifacts: replayCaseRefs.map((ref) => ref.path) }),
    artifactRefs,
    metadata: { storage: stripUndefined({ schema: storage.schema, pathPrefix: storage.pathPrefix, publicUrlRoot: storage.publicUrlRoot }) },
  })

  return {
    contract,
    artifactRefs,
    wordpressHotspots: wordpressHotspots.metadata,
    fuzzObservationSet: fuzzObservationSet.metadata,
    fuzzHotspotSet: fuzzHotspotSet.metadata,
    queryObservations: {
      kind: "query-observation-set",
      persisted: true,
      count: queryObservationArtifacts.length,
      metadata: { schema: QUERY_OBSERVATION_SCHEMA, source: "executeWordPressFuzzSuite", storage: "runtime-artifact-layout" },
      observations: queryObservationArtifacts,
    },
    writeResult: async (content: string) => {
      const written = await writeFuzzJsonArtifact(writer, storage, bundlePath, resultPath, "fuzz-suite-result", input.result.schema, content, undefined)
      contract.resultRef = written.ref
      await writer.writeManifest(manifest)
      return written.metadata
    },
  }
}

async function writeFuzzJsonArtifact(writer: ArtifactBundleWriter, storage: RuntimeArtifactStorageDescriptor, bundlePath: string, path: string, kind: string, schema: string, content: string, value?: unknown, contentType = "application/json") {
  await writer.write(path, content, { kind, contentType, provenance: { source: "executeWordPressFuzzSuite", operation: kind } })
  const digest = artifactFileDigest(content)
  const bytes = Buffer.byteLength(content)
  const ref = fuzzArtifactRef(storage, bundlePath, path, kind, contentType, digest.value, bytes)
  return {
    ref,
    metadata: stripUndefined({ ...ref, name: kind, persisted: true, metadata: { schema, source: "executeWordPressFuzzSuite", storage: "runtime-artifact-layout" }, value }),
  }
}

function fuzzArtifactRef(storage: RuntimeArtifactStorageDescriptor, bundlePath: string, path: string, kind: string, contentType: string, sha256?: string, bytes?: number): FuzzSuiteArtifactRef {
  const artifactPath = artifactStoragePath(storage, [bundlePath, path].filter(Boolean).join("/"))
  return stripUndefined({
    path: artifactPath,
    kind,
    contentType,
    sha256,
    bytes,
    name: kind,
    metadata: stripUndefined({ storage: "runtime-artifact-layout", publicUrl: storage.publicUrlRoot ? `${storage.publicUrlRoot}/${artifactPath}` : undefined }),
  })
}

function queryObservationArtifactsFromFuzzResult(result: FuzzSuiteResultEnvelope): QueryObservationArtifact[] {
  return result.cases.flatMap((fuzzCase) => {
    const execution = recordValue(fuzzCase.metadata?.execution)
    const executionResult = recordValue(execution?.result)
    const json = recordValue(executionResult?.json)
    const command = stringValue(execution?.command)
    const target = fuzzCase.target?.id ?? fuzzCase.target?.entrypoint ?? stringValue(json?.path ?? json?.route ?? json?.url)
    const direct = queryObservationFromDatabaseRecord({ result, fuzzCase, command, target, database: recordValue(recordValue(json?.performance)?.database) ?? recordValue(json?.database) ?? recordValue(json?.metrics), source: "fuzz-case-execution" })
    return [direct, ...queryObservationsFromBenchResult({ result, fuzzCase, command, target, json })].filter((item): item is QueryObservationArtifact => Boolean(item))
  })
}

function queryObservationFromDatabaseRecord(input: { result: FuzzSuiteResultEnvelope; fuzzCase: FuzzSuiteResultEnvelope["cases"][number]; command?: string; target?: string; database?: Record<string, unknown>; source: string }): QueryObservationArtifact | undefined {
  const database = input.database
  if (!database) return undefined
  const queryCount = numberValue(database.queryCount ?? database.query_count ?? database.queries)
  const totalTimeMs = nullableNumber(database.totalTimeMs ?? database.total_time_ms ?? database.queryTimeMs ?? database.query_time_ms)
  const fingerprints = arrayValue(database.fingerprints ?? database.queryFingerprints ?? database.query_fingerprints).flatMap(normalizeQueryFingerprint)
  if (queryCount === undefined && totalTimeMs === undefined && fingerprints.length === 0) return undefined
  return queryObservationArtifact({
    generatedAt: new Date().toISOString(),
    source: input.source,
    suiteId: input.result.suite.id,
    caseId: input.fuzzCase.id,
    actionId: stringValue(recordValue(input.fuzzCase.metadata?.replay)?.executionId),
    command: input.command,
    target: input.target,
    status: stringValue(database.status) === "unavailable" ? "unavailable" : "captured",
    reason: stringValue(database.reason),
    queryCount,
    totalTimeMs,
    fingerprints,
    artifactRefs: input.fuzzCase.artifactRefs?.map((ref) => ({ path: ref.path, kind: ref.kind, contentType: ref.contentType, sha256: ref.sha256, bytes: ref.bytes, name: ref.name, metadata: ref.metadata })),
    metadata: { runner: "wp-codebox", timingStatus: stringValue(database.timingStatus ?? database.timing_status), timingReason: stringValue(database.timingReason ?? database.timing_reason) },
  })
}

function queryObservationsFromBenchResult(input: { result: FuzzSuiteResultEnvelope; fuzzCase: FuzzSuiteResultEnvelope["cases"][number]; command?: string; target?: string; json?: Record<string, unknown> }): QueryObservationArtifact[] {
  if (input.json?.schema !== "wp-codebox/bench-results/v1") return []
  const out: QueryObservationArtifact[] = []
  for (const scenario of arrayValue(input.json.scenarios)) {
    const scenarioRecord = recordValue(scenario)
    const profile = recordValue(recordValue(scenarioRecord?.artifacts)?.["rest-db-query-profile"])
    if (profile?.schema !== "wp-codebox/wordpress-rest-db-query-profile/v1") continue
    for (const profileCase of arrayValue(profile.cases)) {
      const caseRecord = recordValue(profileCase)
      const summary = recordValue(caseRecord?.summary)
      const database = {
        status: "captured",
        queryCount: numberValue(summary?.query_count),
        totalTimeMs: numberValue(summary?.total_time_ms),
        fingerprints: arrayValue(caseRecord?.queries ?? caseRecord?.fingerprints ?? caseRecord?.samples),
      }
      const observation = queryObservationFromDatabaseRecord({
        result: input.result,
        fuzzCase: input.fuzzCase,
        command: input.command ?? "wordpress.run-workload",
        target: stringValue(caseRecord?.path) ?? stringValue(caseRecord?.route) ?? input.target,
        database,
        source: "rest-db-query-profiler",
      })
      if (observation) {
        out.push({ ...observation, metadata: { ...observation.metadata, scenarioId: stringValue(scenarioRecord?.id), profileCaseId: stringValue(caseRecord?.case_id) } })
      }
    }
  }
  return out
}

function normalizeQueryFingerprint(value: unknown): QueryObservationFingerprint[] {
  const record = recordValue(value)
  if (!record) return []
  const fingerprint = stringValue(record.fingerprint ?? record.sql ?? record.query)
  if (!fingerprint) return []
  const operation = normalizeQueryOperation(stringValue(record.operation) ?? queryOperationFromFingerprint(fingerprint))
  return [{
    fingerprint,
    hash: stringValue(record.hash),
    count: numberValue(record.count) ?? 1,
    operation,
    tables: normalizeQueryTables(record.tables, operation, fingerprint),
    sampleMs: nullableNumber(record.sampleMs ?? record.sample_ms),
    totalTimeMs: nullableNumber(record.totalTimeMs ?? record.total_time_ms),
    caller: stringValue(record.caller ?? record.source),
    rowCount: nullableNumber(record.rowCount ?? record.row_count),
    rowsAffected: nullableNumber(record.rowsAffected ?? record.rows_affected ?? record.affectedRows ?? record.affected_rows),
  }]
}

function normalizeQueryTables(input: unknown, operation: QueryObservationOperation | undefined, fingerprint: string): QueryObservationTableRef[] {
  const fromInput = arrayValue(input).flatMap((item): QueryObservationTableRef[] => {
    const record = recordValue(item)
    const name = typeof item === "string" ? item : stringValue(record?.name ?? record?.table)
    return name ? [{ name, source: (stringValue(record?.source) as QueryObservationTableRef["source"] | undefined) ?? "recorder", operation: normalizeQueryOperation(stringValue(record?.operation)) ?? operation }] : []
  })
  return fromInput.length > 0 ? fromInput : queryTablesFromFingerprint(fingerprint, operation)
}

function queryTablesFromFingerprint(fingerprint: string, operation: QueryObservationOperation | undefined): QueryObservationTableRef[] {
  const tables = new Set<string>()
  for (const pattern of [/\bfrom\s+`?([a-zA-Z0-9_]+)`?/gi, /\bjoin\s+`?([a-zA-Z0-9_]+)`?/gi, /\binto\s+`?([a-zA-Z0-9_]+)`?/gi, /\bupdate\s+`?([a-zA-Z0-9_]+)`?/gi, /\btable\s+`?([a-zA-Z0-9_]+)`?/gi]) {
    for (const match of fingerprint.matchAll(pattern)) {
      if (match[1]) tables.add(match[1])
    }
  }
  return [...tables].map((name) => ({ name, source: "fingerprint" as const, operation }))
}

function queryOperationFromFingerprint(fingerprint: string): QueryObservationOperation | undefined {
  return normalizeQueryOperation(fingerprint.trim().split(/\s+/, 1)[0])
}

function normalizeQueryOperation(value: string | undefined): QueryObservationOperation | undefined {
  const operation = value?.toLowerCase()
  return operation && ["select", "insert", "update", "delete", "replace", "create", "alter", "drop", "truncate"].includes(operation) ? operation as QueryObservationOperation : operation ? "other" : undefined
}

function queryObservationArtifactMetadata(observation: QueryObservationArtifact, ref: FuzzSuiteArtifactRef): Record<string, unknown> {
  return stripUndefined({ caseId: observation.caseId, actionId: observation.actionId, command: observation.command, target: observation.target, queryCount: observation.queryCount, totalTimeMs: observation.totalTimeMs, ref })
}

function inlineQueryObservationMetadata(observations: QueryObservationArtifact[]): Record<string, unknown> {
  return {
    kind: "query-observation-set",
    persisted: false,
    count: observations.length,
    metadata: { schema: QUERY_OBSERVATION_SCHEMA, source: "executeWordPressFuzzSuite", storage: "inline-metadata" },
    observations: observations.map((observation) => stripUndefined({ caseId: observation.caseId, actionId: observation.actionId, command: observation.command, target: observation.target, queryCount: observation.queryCount, totalTimeMs: observation.totalTimeMs })),
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

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : numberValue(value)
}

function numericRecord(value: Record<string, unknown>): Record<string, number> | undefined {
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

async function workloadSteps(value: unknown, workload: Record<string, unknown>, fuzzCase?: unknown): Promise<Array<{ command: string; args?: string[]; timeoutMs?: number; allowFailure?: boolean; advisory?: boolean; phase?: string; phaseIndex?: number; metadata?: Record<string, unknown> }>> {
  if (!Array.isArray(value)) {
    return []
  }
  const commandSteps = (await Promise.all(value.map(async (step) => {
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
    const phpWorkloadPath = parsedArgs.path ?? parsedArgs.file ?? ""
    const phpWorkloadSource = phpWorkloadStep ? await readableTextFile(phpWorkloadPath) : undefined
    return [{
      command: phpWorkloadStep ? "wordpress.run-php" : record.command,
      args: phpWorkloadStep ? [`code=${wordpressWorkloadPhpWrapper(phpWorkloadPath, workload, parsedArgs, phpWorkloadSource)}`] : args,
      timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : typeof record.timeout_ms === "number" ? record.timeout_ms : undefined,
      allowFailure: record.allowFailure === true || record.allow_failure === true,
      advisory: record.advisory === true,
      phase: stringValue(record.phase),
      phaseIndex: numberValue(record.phaseIndex ?? record.phase_index),
      metadata: recordValue(record.metadata),
    }]
  }))).flat()
  if (commandSteps.length > 0) {
    return commandSteps
  }
  if (value.some((step) => step && typeof step === "object" && !Array.isArray(step) && typeof (step as Record<string, unknown>).type === "string")) {
    return [{ command: "wordpress.run-php", args: [`code=${typedWorkloadRunnerCode(workload, fuzzCase)}`] }]
  }
  return []
}

async function readableTextFile(path: string): Promise<string | undefined> {
  if (path.trim() === "") {
    return undefined
  }
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
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

function wordpressWorkloadPhpWrapper(path: string, workload: Record<string, unknown>, args: Record<string, string>, source?: string): string {
  const normalizedArgs: Record<string, string> = { ...args, path }
  delete normalizedArgs.file
  const encodedInput = Buffer.from(JSON.stringify(wordpressWorkloadPhpWrapperInput(workload)), "utf8").toString("base64")
  const encodedArgs = Buffer.from(JSON.stringify(normalizedArgs), "utf8").toString("base64")
  const encodedSource = typeof source === "string" ? Buffer.from(source, "utf8").toString("base64") : undefined
  const callableLoader = encodedSource ? `$__wp_codebox_workload_file = tempnam(sys_get_temp_dir(), 'wp-codebox-workload-');\nif (false === $__wp_codebox_workload_file) { throw new RuntimeException('Unable to create temporary PHP workload file.'); }\nfile_put_contents($__wp_codebox_workload_file, base64_decode('${encodedSource}'));\n$__wp_codebox_workload_callable = require $__wp_codebox_workload_file;\nunlink($__wp_codebox_workload_file);` : `$__wp_codebox_workload_callable = require ${JSON.stringify(path)};`
  return `$__wp_codebox_workload_input = json_decode(base64_decode('${encodedInput}'), true);\n$__wp_codebox_workload_args = json_decode(base64_decode('${encodedArgs}'), true);\n${callableLoader}\nif (!is_callable($__wp_codebox_workload_callable)) { throw new RuntimeException('PHP workload file must return a callable.'); }\n$__wp_codebox_workload_result = $__wp_codebox_workload_callable(is_array($__wp_codebox_workload_input) ? $__wp_codebox_workload_input : array(), is_array($__wp_codebox_workload_args) ? $__wp_codebox_workload_args : array());\nif (is_array($__wp_codebox_workload_result) || is_object($__wp_codebox_workload_result)) { echo json_encode($__wp_codebox_workload_result, JSON_UNESCAPED_SLASHES) . "\\n"; } elseif (false === $__wp_codebox_workload_result) { exit(1); }`
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

export function wordpressSimulatedAdminPageLoadAction(options: WordPressPageLoadActionOptions = {}): RuntimeEpisodeActionSpec {
  return { command: "wordpress.simulated-admin-page-load", args: pageLoadActionArgs(options) }
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
