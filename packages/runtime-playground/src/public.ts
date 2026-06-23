import {
  createRuntime,
  createRuntimeEpisode,
  openWordPressAdminPage,
  openWordPressEditor,
  probeWordPressBrowser,
  requestWordPressRest,
  runWordPressCrudOperation,
  runWordPressBrowserAction,
  runWordPressPhp,
  runWordPressWpCli,
  visitWordPressPage,
  type ArtifactBundle,
  type ArtifactSpec,
  type FuzzSuiteRuntimeActionExecutor,
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
  inventoryWordPressAdminPages,
  inventoryWordPressFrontendUrls,
  inventoryWordPressRestRoutes,
  loadWordPressAdminPage,
  loadWordPressFrontendPage,
  openWordPressAdminPage,
  openWordPressEditor,
  probeWordPressBrowser,
  readWordPressDatabase,
  requestWordPressRest,
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
  user?: string
  session?: string
  captureDiagnostics?: string[]
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
    ...(options.user ? [`user=${options.user}`] : []),
    ...(options.session ? [`session=${options.session}`] : []),
    ...(options.captureDiagnostics?.length ? [`capture-diagnostics=${options.captureDiagnostics.join(",")}`] : []),
  ]
}
