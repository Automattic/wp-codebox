import { createHash } from "node:crypto"

import {
  WORDPRESS_HOTSPOTS_SCHEMA,
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
  wordpressHotspotsArtifact,
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
  type PerformanceObservation,
  type Runtime,
  type RuntimeActionObservation,
  type RuntimeCreateSpec,
  type RuntimeEpisode,
  type RuntimeEpisodeActionSpec,
  type RuntimeEpisodeSpec,
  type RuntimeEpisodeStepResult,
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
      const steps = [...workloadSteps(workload.before, workload), ...workloadSteps(workload.steps, workload), ...workloadSteps(workload.after, workload)]
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
      pushHotspotObservation(hotspotObservations, performanceObservationFromRuntimeAction(observation), runtimeActionArtifactRefs(observation))
      return observation
    },
    runtimeWorkloadExecutor: async (input) => {
      const execution = await runtimeWorkloadExecutor.executeRuntimeWorkload(input)
      const observations = performanceObservationsFromWorkloadExecution(execution)
      if (observations.length === 0) {
        pushHotspotObservation(hotspotObservations, performanceObservationFromExecution({ command: execution.command, args: execution.args }, execution), executionArtifactRefs(execution))
      } else {
        for (const observation of observations) {
          pushHotspotObservation(hotspotObservations, observation, executionArtifactRefs(execution))
        }
      }
      return execution
    },
    resetExecutor: createWordPressFuzzSuiteResetExecutor(episode),
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
  const content = `${JSON.stringify(artifact, null, 2)}\n`
  const ref: FuzzSuiteArtifactRef = {
    path: "files/wordpress-hotspots.json",
    kind: "wordpress-hotspots",
    contentType: "application/json",
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
    name: "wordpress-hotspots",
    metadata: { schema: WORDPRESS_HOTSPOTS_SCHEMA, source: "executeWordPressFuzzSuite" },
  }

  return {
    ...result,
    artifactRefs: dedupeFuzzSuiteArtifactRefs([...result.artifactRefs, ref]),
    metadata: {
      ...result.metadata,
      artifacts: {
        ...(recordValue(result.metadata?.artifacts) ?? {}),
        wordpressHotspots: artifact,
      },
    },
  }
}

function pushHotspotObservation(out: WordPressHotspotObservationInput[], observation: PerformanceObservation | undefined, artifactRefs: FuzzSuiteArtifactRef[] = []): void {
  if (!observation) return
  out.push({
    observation,
    artifactRefs: artifactRefs.map((ref) => ({ path: ref.path, kind: ref.kind, contentType: ref.contentType, sha256: ref.sha256, bytes: ref.bytes, name: ref.name, metadata: ref.metadata })),
  })
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
  return raw.flatMap((item) => isPerformanceObservation(item) ? [item] : [])
}

function normalizeObservationDatabase(input: Record<string, unknown> | undefined): PerformanceObservation["database"] | undefined {
  if (!input) return undefined
  const queryCount = numberValue(input.queryCount ?? input.query_count ?? input.queries)
  const totalTimeMs = numberValue(input.totalTimeMs ?? input.total_time_ms ?? input.queryTimeMs ?? input.query_time_ms)
  return queryCount !== undefined || totalTimeMs !== undefined ? { queryCount, totalTimeMs } : input as PerformanceObservation["database"]
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

function workloadSteps(value: unknown, workload: Record<string, unknown>): Array<{ command: string; args?: string[]; timeoutMs?: number; allowFailure?: boolean; advisory?: boolean }> {
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
