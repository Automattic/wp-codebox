import {
  createRuntime,
  createRuntimeEpisode,
  executeFuzzSuite,
  openWordPressAdminPage,
  openWordPressEditor,
  probeWordPressBrowser,
  readWordPressDatabase,
  requestWordPressRest,
  RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES,
  runWordPressCrudOperation,
  runWordPressBrowserAction,
  runWordPressPhp,
  runWordPressWpCli,
  visitWordPressPage,
  type ArtifactBundle,
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
  type FuzzSuiteRuntimeWorkloadExecutor,
  type FuzzSuiteRunOptions,
  type ObservationSpec,
  type Runtime,
  type RuntimeCreateSpec,
  type RuntimeEpisode,
  type RuntimeEpisodeActionSpec,
  type RuntimeEpisodeSpec,
  type RuntimeEpisodeStepResult,
} from "@automattic/wp-codebox-core/public"
export {
  collectWordPressArtifacts,
  discoverWordPressRuntime,
  executeFuzzSuite,
  executeWordPressRestMatrix,
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
  type WordPressRuntimeInventoryOptions,
  type WordPressRestPerformanceObservationOptions,
  type WordPressRuntimeCheckpointListOptions,
  type WordPressRuntimeCheckpointOptions,
  type WordPressRuntimeCheckpointRestoreOptions,
  type WordPressThemeSetupOptions,
  type WordPressWpCliOptions,
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

export type WordPressFuzzSuiteExecutionOptions = Omit<FuzzSuiteRunOptions, "executor" | "runtimeActionExecutor" | "runtimeWorkloadExecutor" | "resetExecutor" | "runnerCapabilities">

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
    async executeRuntimeAction({ action }) {
      if (action.type === "wp_cli") {
        return runWordPressWpCli(episode, action)
      }
      if (action.type === "php") {
        return runWordPressPhp(episode, action)
      }
      if (action.type === "rest_request") {
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
          throw new Error("Unsupported WordPress fuzz runtime-action type: db_operation write")
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

export function createWordPressFuzzSuiteCommandExecutor(episode: Pick<RuntimeEpisode, "step">): FuzzSuiteCommandExecutor {
  return {
    async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
      const step = await episode.step({ kind: "command", ...spec }, { type: "command-result" })
      return step.execution
    },
  }
}

export function createWordPressFuzzSuiteRuntimeWorkloadExecutor(episode: Pick<RuntimeEpisode, "step">): FuzzSuiteRuntimeWorkloadExecutor {
  return {
    async executeRuntimeWorkload({ workload, case: fuzzCase }) {
      const steps = [...workloadSteps(workload.before), ...workloadSteps(workload.steps), ...workloadSteps(workload.after)]
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
      const workloadResult = { schema: "wp-codebox/wordpress-workload-run-result/v1", caseId: fuzzCase.id, steps: executions.length, exitCode: failed ? failed.exitCode : 0 }
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
        artifactRefs: executions.flatMap((execution) => execution.artifactRefs ?? []),
      }
    },
  }
}

export function createWordPressFuzzSuiteResetExecutor(episode: Pick<RuntimeEpisode, "reset" | "step">): FuzzSuiteResetExecutor {
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
        return {
          mode: policy.mode,
          status: "unsupported",
          snapshotRef: policy.snapshotRef ?? policy.snapshot_ref,
          fixtureRefs,
          diagnostics: [{
            severity: "error",
            code: "fuzz_suite_snapshot_restore_unsupported",
            caseId: fuzzCase.id,
            message: "The public Playground episode facade cannot restore arbitrary snapshotRef values; use checkpoint-per-case for same-run runtime restoration.",
          }],
          metadata: { resetPerformed: false, restorePerformed: false, supportedResetModes: ["none", "checkpoint-per-case"] },
        }
      }
      return { mode: "none", status: "not-required" }
    },
  }
}

export function executeWordPressFuzzSuite(
  episode: Pick<RuntimeEpisode, "reset" | "step">,
  suite: FuzzSuiteContract,
  options: WordPressFuzzSuiteExecutionOptions = {},
): Promise<FuzzSuiteResultEnvelope> {
  return executeFuzzSuite(suite, {
    ...options,
    executor: createWordPressFuzzSuiteCommandExecutor(episode),
    runtimeActionExecutor: createWordPressFuzzSuiteRuntimeActionExecutor(episode),
    runtimeWorkloadExecutor: createWordPressFuzzSuiteRuntimeWorkloadExecutor(episode),
    resetExecutor: createWordPressFuzzSuiteResetExecutor(episode),
    runnerCapabilities: RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES,
    metadata: {
      ...options.metadata,
      runnerMode: "runtime-backed",
      runtimeBackend: "wordpress-playground",
    },
  })
}

function workloadSteps(value: unknown): Array<{ command: string; args?: string[]; timeoutMs?: number; allowFailure?: boolean; advisory?: boolean }> {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return []
    }
    const record = step as Record<string, unknown>
    if (typeof record.command !== "string" || record.command.trim() === "") {
      return []
    }
    return [{
      command: record.command,
      args: Array.isArray(record.args) ? record.args.map(String) : undefined,
      timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : typeof record.timeout_ms === "number" ? record.timeout_ms : undefined,
      allowFailure: record.allowFailure === true || record.allow_failure === true,
      advisory: record.advisory === true,
    }]
  })
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
