import { runRuntimeAction, type RuntimeActionObservation, type RuntimeAdminPageAction, type RuntimeBrowserAction, type RuntimeBrowserProbeAction, type RuntimeEditorOpenAction, type RuntimePageAction, type RuntimePhpAction, type RuntimeRestRequestAction, type RuntimeWordPressPluginSetupAction, type RuntimeWordPressPluginStateAction, type RuntimeWordPressThemeSetupAction, type RuntimeWpCliAction } from "./runtime-action-adapter.js"
import type { ArtifactSpec } from "./artifact-manifest.js"
import type { FuzzSuiteContract, FuzzSuiteResultEnvelope } from "./fuzz-suite-contracts.js"
import { runFuzzSuite, type FuzzSuiteRunOptions } from "./fuzz-suite-runner.js"
import { WORDPRESS_DB_OPERATION_SCHEMA, normalizeWordPressDbOperation, type WordPressDbOperation, type WordPressDbVerb } from "./wordpress-db-contracts.js"
import { WORDPRESS_CRUD_OPERATION_SCHEMA, normalizeWordPressCrudOperation, type WordPressCrudOperation } from "./wordpress-crud-contracts.js"
import { normalizeWordPressBlockExerciseInput, type WordPressBlockExerciseInput } from "./wordpress-block-exercise-contracts.js"
import type { PerformanceObservationCaptureRequest } from "./performance-observation.js"
import { runWordPressRestMatrix, type WordPressRestMatrixContract, type WordPressRestMatrixResultEnvelope } from "./rest-matrix-contracts.js"
import type { ArtifactBundle, Runtime, RuntimeCommandDiagnosticsCaptureSpec, RuntimeEpisode, RuntimeEpisodeStepResult } from "./runtime-contracts.js"
import type { WordPressRuntimeDiscoverySurface } from "./wordpress-runtime-discovery-contracts.js"

export type WordPressRuntimeActionEpisode = Pick<RuntimeEpisode, "step">
export type WordPressRuntimeArtifactSource = Pick<Runtime, "collectArtifacts"> | Pick<RuntimeEpisode, "collectArtifacts">

export type WordPressWpCliOptions = Omit<RuntimeWpCliAction, "type">
export type WordPressPhpOptions = Omit<RuntimePhpAction, "type" | "diagnostics"> & {
  diagnostics?: RuntimeCommandDiagnosticsCaptureSpec
}
export type WordPressRestRequestOptions = Omit<RuntimeRestRequestAction, "type">
export type WordPressBrowserActionOptions = Omit<RuntimeBrowserAction, "type">
export type WordPressBrowserProbeOptions = Omit<RuntimeBrowserProbeAction, "type">
export type WordPressEditorOpenOptions = Omit<RuntimeEditorOpenAction, "type">
export type WordPressAdminPageOptions = Omit<RuntimeAdminPageAction, "type">
export type WordPressPageOptions = Omit<RuntimePageAction, "type">

export type WordPressPluginSetupOptions = Omit<RuntimeWordPressPluginSetupAction, "type">
export type WordPressPluginStateOptions = Omit<RuntimeWordPressPluginStateAction, "type">
export type WordPressThemeSetupOptions = Omit<RuntimeWordPressThemeSetupAction, "type">

export interface WordPressRuntimeDiscoveryOptions {
  surfaces?: readonly WordPressRuntimeDiscoverySurface[]
  timeoutMs?: number
}

export interface WordPressRuntimeInventoryOptions {
  timeoutMs?: number
}

export interface WordPressRestPerformanceObservationOptions {
  method?: string
  path: string
  params?: Record<string, unknown>
  user?: string
  session?: string
  queryFingerprintLimit?: number
  queryLengthLimit?: number
  hookSampleLimit?: number
  hookLimit?: number
  timeoutMs?: number
  capture?: PerformanceObservationCaptureRequest
  enableQueryCapture?: boolean
}

export interface WordPressRuntimeCheckpointOptions {
  name: string
  metadata?: Record<string, unknown>
  snapshotIncludeWpContent?: readonly string[]
  snapshotExcludeWpContent?: readonly string[]
  snapshotDatabaseTables?: readonly string[]
  snapshotExcludeDatabaseTables?: readonly string[]
  snapshotOptionNames?: readonly string[]
  snapshotPostTypes?: readonly string[]
  timeoutMs?: number
}

export interface WordPressRuntimeCheckpointRestoreOptions {
  name: string
  timeoutMs?: number
}

export interface WordPressRuntimeCheckpointListOptions {
  timeoutMs?: number
}

export type WordPressCrudOperationOptions = Omit<WordPressCrudOperation, "schema"> & {
  schema?: typeof WORDPRESS_CRUD_OPERATION_SCHEMA
}

export type WordPressDatabaseReadOperation = Extract<WordPressDbVerb, "schema" | "read" | "inspect" | "query-summary">

export type WordPressDatabaseReadOptions = Omit<WordPressDbOperation, "schema" | "operation"> & {
  schema?: typeof WORDPRESS_DB_OPERATION_SCHEMA
  operation?: WordPressDatabaseReadOperation
}

export type WordPressBlockExerciseOptions = Partial<WordPressBlockExerciseInput> & { blockName: string }

export interface WordPressPageLoadOptions {
  path?: string
  url?: string
  method?: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  user?: string
  session?: string
  captureDiagnostics?: readonly string[]
  capture?: PerformanceObservationCaptureRequest
  enableQueryCapture?: boolean
  timeoutMs?: number
}

export function runWordPressWpCli(episode: WordPressRuntimeActionEpisode, command: string | WordPressWpCliOptions): Promise<RuntimeActionObservation> {
  const action = typeof command === "string" ? { command } : command
  return runRuntimeAction(episode as RuntimeEpisode, { type: "wp_cli", ...action })
}

export function runWordPressPhp(episode: WordPressRuntimeActionEpisode, code: string | WordPressPhpOptions): Promise<RuntimeActionObservation> {
  const action = typeof code === "string" ? { code } : code
  return runRuntimeAction(episode as RuntimeEpisode, { type: "php", ...action })
}

export function requestWordPressRest(episode: WordPressRuntimeActionEpisode, request: WordPressRestRequestOptions): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "rest_request", ...request })
}

export function runWordPressBrowserAction(episode: WordPressRuntimeActionEpisode, action: WordPressBrowserActionOptions): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "browser", ...action })
}

export function probeWordPressBrowser(episode: WordPressRuntimeActionEpisode, probe: WordPressBrowserProbeOptions): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "browser_probe", ...probe })
}

export function openWordPressEditor(episode: WordPressRuntimeActionEpisode, target: WordPressEditorOpenOptions): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "editor_open", ...target })
}

export function openWordPressAdminPage(episode: WordPressRuntimeActionEpisode, page: WordPressAdminPageOptions): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "admin_page", ...page })
}

export function visitWordPressPage(episode: WordPressRuntimeActionEpisode, page: WordPressPageOptions): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "page", ...page })
}

export function setupWordPressPlugin(episode: WordPressRuntimeActionEpisode, options: WordPressPluginSetupOptions = {}): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "wordpress_plugin_setup", ...options })
}

export function setWordPressPluginState(episode: WordPressRuntimeActionEpisode, options: WordPressPluginStateOptions): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "wordpress_plugin_state", ...options })
}

export function setupWordPressTheme(episode: WordPressRuntimeActionEpisode, options: WordPressThemeSetupOptions = {}): Promise<RuntimeActionObservation> {
  return runRuntimeAction(episode as RuntimeEpisode, { type: "wordpress_theme_setup", ...options })
}

export function discoverWordPressRuntime(episode: WordPressRuntimeActionEpisode, options: WordPressRuntimeDiscoveryOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.runtime-discovery", [
    ...(options.surfaces?.length ? [`surface=${options.surfaces.join(",")}`] : []),
  ], options.timeoutMs)
}

export function inventoryWordPressRestRoutes(episode: WordPressRuntimeActionEpisode, options: WordPressRuntimeInventoryOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.rest-route-inventory", [], options.timeoutMs)
}

export function inventoryWordPressAdminPages(episode: WordPressRuntimeActionEpisode, options: WordPressRuntimeInventoryOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.admin-page-inventory", [], options.timeoutMs)
}

export function inventoryWordPressDatabase(episode: WordPressRuntimeActionEpisode, options: WordPressRuntimeInventoryOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.inventory-database", [], options.timeoutMs)
}

export function observeWordPressRestPerformance(episode: WordPressRuntimeActionEpisode, options: WordPressRestPerformanceObservationOptions): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.rest-performance-observation", [
    ...(options.method ? [`method=${options.method}`] : []),
    `path=${options.path}`,
    ...(options.params ? [`params-json=${JSON.stringify(options.params)}`] : []),
    ...(options.user ? [`user=${options.user}`] : []),
    ...(options.session ? [`session=${options.session}`] : []),
    ...(options.queryFingerprintLimit !== undefined ? [`query-fingerprint-limit=${options.queryFingerprintLimit}`] : []),
    ...(options.queryLengthLimit !== undefined ? [`query-length-limit=${options.queryLengthLimit}`] : []),
    ...(options.hookSampleLimit !== undefined ? [`hook-sample-limit=${options.hookSampleLimit}`] : []),
    ...(options.hookLimit !== undefined ? [`hook-limit=${options.hookLimit}`] : []),
    ...captureArgs(options),
  ], options.timeoutMs)
}

export function createWordPressRuntimeCheckpoint(episode: WordPressRuntimeActionEpisode, options: WordPressRuntimeCheckpointOptions): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wp-codebox.checkpoint-create", [
    `name=${options.name}`,
    ...(options.metadata ? [`metadata-json=${JSON.stringify(options.metadata)}`] : []),
    ...runtimeCheckpointSnapshotScopeArgs(options),
  ], options.timeoutMs)
}

export function restoreWordPressRuntimeCheckpoint(episode: WordPressRuntimeActionEpisode, options: string | WordPressRuntimeCheckpointRestoreOptions): Promise<RuntimeEpisodeStepResult> {
  const checkpoint = typeof options === "string" ? { name: options } : options
  return runWordPressCommand(episode, "wp-codebox.checkpoint-restore", [`name=${checkpoint.name}`], checkpoint.timeoutMs)
}

export function listWordPressRuntimeCheckpoints(episode: WordPressRuntimeActionEpisode, options: WordPressRuntimeCheckpointListOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wp-codebox.checkpoint-list", [], options.timeoutMs)
}

export function inventoryWordPressFrontendUrls(episode: WordPressRuntimeActionEpisode, options: WordPressRuntimeInventoryOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.frontend-url-inventory", [], options.timeoutMs)
}

export function runWordPressCrudOperation(episode: WordPressRuntimeActionEpisode, operation: WordPressCrudOperationOptions, timeoutMs?: number): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.crud-operation", [`operation-json=${JSON.stringify(normalizeWordPressCrudOperation({ schema: WORDPRESS_CRUD_OPERATION_SCHEMA, ...operation }))}`], timeoutMs)
}

export function readWordPressDatabase(episode: WordPressRuntimeActionEpisode, operation: WordPressDatabaseReadOptions = {}, timeoutMs?: number): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.db-operation", [`operation-json=${JSON.stringify(normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: operation.operation ?? "read", ...operation }))}`], timeoutMs)
}

export function renderWordPressBlock(episode: WordPressRuntimeActionEpisode, input: WordPressBlockExerciseOptions, timeoutMs?: number): Promise<RuntimeEpisodeStepResult> {
  const normalized = normalizeWordPressBlockExerciseInput({ ...input, mode: "render" })
  return runWordPressCommand(episode, "wordpress.block-render", blockExerciseArgs(normalized), timeoutMs)
}

export function exerciseWordPressBlock(episode: WordPressRuntimeActionEpisode, input: WordPressBlockExerciseOptions, timeoutMs?: number): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.block-exercise", blockExerciseArgs(normalizeWordPressBlockExerciseInput(input)), timeoutMs)
}

export function loadWordPressAdminPage(episode: WordPressRuntimeActionEpisode, page: WordPressPageLoadOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.admin-page-load", pageLoadArgs(page), page.timeoutMs)
}

export function loadWordPressFrontendPage(episode: WordPressRuntimeActionEpisode, page: WordPressPageLoadOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.frontend-page-load", pageLoadArgs(page), page.timeoutMs)
}

export function executeWordPressRestMatrix(matrix: WordPressRestMatrixContract, options: FuzzSuiteRunOptions = {}): Promise<WordPressRestMatrixResultEnvelope> {
  return runWordPressRestMatrix(matrix, options)
}

export function executeFuzzSuite(suite: FuzzSuiteContract, options: FuzzSuiteRunOptions = {}): Promise<FuzzSuiteResultEnvelope> {
  return runFuzzSuite(suite, options)
}

export function collectWordPressArtifacts(source: WordPressRuntimeArtifactSource, spec?: ArtifactSpec): Promise<ArtifactBundle> {
  return source.collectArtifacts(spec)
}

export type { RuntimeActionObservation }

function runWordPressCommand(episode: WordPressRuntimeActionEpisode, command: string, args: string[], timeoutMs?: number): Promise<RuntimeEpisodeStepResult> {
  return episode.step({ kind: "command", command, args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, { type: "command-result" })
}

function runtimeCheckpointSnapshotScopeArgs(options: WordPressRuntimeCheckpointOptions): string[] {
  return [
    ...(options.snapshotIncludeWpContent?.length ? [`snapshot-include-wp-content=${options.snapshotIncludeWpContent.join(",")}`] : []),
    ...(options.snapshotExcludeWpContent?.length ? [`snapshot-exclude-wp-content=${options.snapshotExcludeWpContent.join(",")}`] : []),
    ...(options.snapshotDatabaseTables?.length ? [`snapshot-database-tables=${options.snapshotDatabaseTables.join(",")}`] : []),
    ...(options.snapshotExcludeDatabaseTables?.length ? [`snapshot-exclude-database-tables=${options.snapshotExcludeDatabaseTables.join(",")}`] : []),
    ...(options.snapshotOptionNames?.length ? [`snapshot-option-names=${options.snapshotOptionNames.join(",")}`] : []),
    ...(options.snapshotPostTypes?.length ? [`snapshot-post-types=${options.snapshotPostTypes.join(",")}`] : []),
  ]
}

function pageLoadArgs(options: WordPressPageLoadOptions): string[] {
  return [
    ...(options.path ? [`path=${options.path}`] : []),
    ...(options.url ? [`url=${options.url}`] : []),
    ...(options.method ? [`method=${options.method}`] : []),
    ...(options.query ? [`query-json=${JSON.stringify(options.query)}`] : []),
    ...(options.body ? [`body-json=${JSON.stringify(options.body)}`] : []),
    ...(options.user ? [`user=${options.user}`] : []),
    ...(options.session ? [`session=${options.session}`] : []),
    ...(options.captureDiagnostics?.length ? [`capture-diagnostics=${options.captureDiagnostics.join(",")}`] : []),
    ...captureArgs(options),
  ]
}

function blockExerciseArgs(input: WordPressBlockExerciseInput): string[] {
  return [
    `block-name=${input.blockName}`,
    ...(input.attrs ? [`attrs-json=${JSON.stringify(input.attrs)}`] : []),
    ...(input.content !== undefined ? [`content=${input.content}`] : []),
    ...(input.markup !== undefined ? [`markup=${input.markup}`] : []),
    ...(input.mode ? [`mode=${input.mode}`] : []),
    ...(input.source ? [`source=${input.source}`] : []),
  ]
}

function captureArgs(options: { capture?: PerformanceObservationCaptureRequest; enableQueryCapture?: boolean }): string[] {
  const args: string[] = []
  if (options.capture && Object.keys(options.capture).length > 0) {
    args.push(`capture-json=${JSON.stringify(options.capture)}`)
  }
  if (typeof options.enableQueryCapture === "boolean") {
    args.push(`enable-query-capture=${options.enableQueryCapture ? "true" : "false"}`)
  }
  return args
}
