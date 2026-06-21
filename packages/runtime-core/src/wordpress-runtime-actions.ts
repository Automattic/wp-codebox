import { runRuntimeAction, type RuntimeActionObservation, type RuntimeBrowserAction, type RuntimeBrowserProbeAction, type RuntimeEditorOpenAction, type RuntimePhpAction, type RuntimeRestRequestAction, type RuntimeWpCliAction } from "./runtime-action-adapter.js"
import type { ArtifactSpec } from "./artifact-manifest.js"
import type { ArtifactBundle, Runtime, RuntimeCommandDiagnosticsCaptureSpec, RuntimeEpisode } from "./runtime-contracts.js"

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

export function collectWordPressArtifacts(source: WordPressRuntimeArtifactSource, spec?: ArtifactSpec): Promise<ArtifactBundle> {
  return source.collectArtifacts(spec)
}

export type { RuntimeActionObservation }
