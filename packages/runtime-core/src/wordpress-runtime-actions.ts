import { runRuntimeAction, type RuntimeActionObservation, type RuntimeAdminPageAction, type RuntimeBrowserAction, type RuntimeBrowserProbeAction, type RuntimeEditorOpenAction, type RuntimePageAction, type RuntimePhpAction, type RuntimeRestRequestAction, type RuntimeWpCliAction } from "./runtime-action-adapter.js"
import type { ArtifactSpec } from "./artifact-manifest.js"
import type { FuzzSuiteContract, FuzzSuiteResultEnvelope } from "./fuzz-suite-contracts.js"
import { runFuzzSuite, type FuzzSuiteRunOptions } from "./fuzz-suite-runner.js"
import { WORDPRESS_DB_OPERATION_SCHEMA, normalizeWordPressDbOperation, type WordPressDbOperation, type WordPressDbVerb } from "./wordpress-db-contracts.js"
import { WORDPRESS_CRUD_OPERATION_SCHEMA, normalizeWordPressCrudOperation, type WordPressCrudOperation } from "./wordpress-crud-contracts.js"
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

export interface WordPressRuntimeDiscoveryOptions {
  surfaces?: readonly WordPressRuntimeDiscoverySurface[]
  timeoutMs?: number
}

export interface WordPressRuntimeInventoryOptions {
  timeoutMs?: number
}

export type WordPressCrudOperationOptions = Omit<WordPressCrudOperation, "schema"> & {
  schema?: typeof WORDPRESS_CRUD_OPERATION_SCHEMA
}

export type WordPressDatabaseReadOperation = Extract<WordPressDbVerb, "schema" | "read" | "query-summary">

export type WordPressDatabaseReadOptions = Omit<WordPressDbOperation, "schema" | "operation"> & {
  schema?: typeof WORDPRESS_DB_OPERATION_SCHEMA
  operation?: WordPressDatabaseReadOperation
}

export interface WordPressPageLoadOptions {
  path?: string
  url?: string
  method?: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  user?: string
  session?: string
  captureDiagnostics?: readonly string[]
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

export function inventoryWordPressFrontendUrls(episode: WordPressRuntimeActionEpisode, options: WordPressRuntimeInventoryOptions = {}): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.frontend-url-inventory", [], options.timeoutMs)
}

export function runWordPressCrudOperation(episode: WordPressRuntimeActionEpisode, operation: WordPressCrudOperationOptions, timeoutMs?: number): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.crud-operation", [`operation-json=${JSON.stringify(normalizeWordPressCrudOperation({ schema: WORDPRESS_CRUD_OPERATION_SCHEMA, ...operation }))}`], timeoutMs)
}

export function readWordPressDatabase(episode: WordPressRuntimeActionEpisode, operation: WordPressDatabaseReadOptions = {}, timeoutMs?: number): Promise<RuntimeEpisodeStepResult> {
  return runWordPressCommand(episode, "wordpress.db-operation", [`operation-json=${JSON.stringify(normalizeWordPressDbOperation({ schema: WORDPRESS_DB_OPERATION_SCHEMA, operation: operation.operation ?? "read", ...operation }))}`], timeoutMs)
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
  ]
}
