import {
  createRuntime,
  createRuntimeEpisode,
  type ArtifactBundle,
  type ArtifactSpec,
  type ObservationSpec,
  type Runtime,
  type RuntimeCreateSpec,
  type RuntimeEpisode,
  type RuntimeEpisodeActionSpec,
  type RuntimeEpisodeSpec,
  type RuntimeEpisodeStepResult,
} from "@automattic/wp-codebox-core/public"
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

export async function collectWordPressRuntimeArtifacts(runtime: Pick<Runtime, "collectArtifacts">, spec?: ArtifactSpec): Promise<ArtifactBundle> {
  return runtime.collectArtifacts(spec)
}

export async function collectWordPressEpisodeArtifacts(episode: Pick<RuntimeEpisode, "collectArtifacts">, spec?: ArtifactSpec): Promise<ArtifactBundle> {
  return episode.collectArtifacts(spec)
}

export async function collectBrowserArtifactMetrics(bundleDirectory: string): Promise<BrowserArtifactMetricsResult> {
  return browserArtifactMetrics(bundleDirectory)
}

export { browserArtifactMetrics, createPlaygroundRuntimeBackend }
export type { BrowserArtifactMetricsResult, PlaygroundRuntimeBackendOptions }

function wordPressRuntimeCreateSpec(spec: WordPressRuntimeSpec): RuntimeCreateSpec {
  return {
    ...spec,
    backend: "wordpress-playground",
  }
}
