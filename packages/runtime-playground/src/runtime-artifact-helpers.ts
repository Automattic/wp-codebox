import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { artifactManifestFile } from "@chubes4/wp-codebox-core"
import type {
  ArtifactBundle,
  ArtifactManifestFile,
  ArtifactPreview,
  ArtifactSpec,
  ExecutionResult,
  LifecycleEvent,
  MountSpec,
  ObservationResult,
  RuntimeCreateSpec,
  RuntimeEpisodeTraceRef,
  RuntimeInfo,
  Snapshot,
} from "@chubes4/wp-codebox-core"
import { ArtifactBundleBuilder } from "./artifact-bundle-builder.js"
import type { ArtifactRedactor } from "./artifacts.js"
import { browserManifestFiles as browserArtifactManifestFiles, browserRedactionPaths, browserReviewSummary as browserArtifactReviewSummary, type BrowserProbeArtifact } from "./browser-artifacts.js"
import { pluginCheckManifestFiles, redactPluginCheckArtifacts, redactThemeCheckArtifacts, themeCheckManifestFiles, type PluginCheckArtifact, type ThemeCheckArtifact } from "./check-artifacts.js"
import { captureMountDiffs, captureMountedFiles } from "./mounted-artifact-capture.js"

export async function collectPlaygroundArtifacts({
  artifactRoot,
  browserProbes,
  commands,
  createdAt,
  events,
  info,
  mounts,
  observations,
  pluginChecks,
  previewInfo,
  recordArtifactsCollected,
  runtimeId,
  snapshots,
  spec,
  themeChecks,
}: {
  artifactRoot: string
  browserProbes: BrowserProbeArtifact[]
  commands: ExecutionResult[]
  createdAt: string
  events: LifecycleEvent[]
  info: () => Promise<RuntimeInfo>
  mounts: MountSpec[]
  observations: ObservationResult[]
  pluginChecks: PluginCheckArtifact[]
  previewInfo: (createdAt: string, holdSeconds: number) => Promise<ArtifactPreview | undefined>
  recordArtifactsCollected: (bundleId: string, createdAt: string, artifactSpec: ArtifactSpec) => void
  runtimeId: string
  snapshots: Snapshot[]
  spec: RuntimeCreateSpec
  themeChecks: ThemeCheckArtifact[]
}, artifactSpec: ArtifactSpec = {}): Promise<ArtifactBundle> {
  return new ArtifactBundleBuilder({
    artifactRoot,
    runtimeId,
    runtimeCreatedAt: createdAt,
    spec,
    mounts,
    commands,
    observations,
    snapshots,
    events,
    info,
    previewInfo,
    browserReviewSummary: () => browserArtifactReviewSummary(browserProbes),
    browserArtifacts: () => browserProbes,
    captureMountedFiles: (filesDirectory, redactor) => captureMountedFiles(filesDirectory, mounts, redactor),
    captureMountDiffs: (filesDirectory, redactor) => captureMountDiffs(artifactRoot, filesDirectory, mounts, redactor),
    redactBrowserArtifacts: (redactor) => redactBrowserArtifacts(artifactRoot, browserProbes, redactor),
    redactPluginCheckArtifacts: (redactor) => redactPluginCheckArtifacts(artifactRoot, pluginChecks, redactor),
    redactThemeCheckArtifacts: (redactor) => redactThemeCheckArtifacts(artifactRoot, themeChecks, redactor),
    browserManifestFiles: () => browserArtifactManifestFiles(artifactRoot, browserProbes),
    pluginCheckArtifactPaths: () => pluginChecks.map((check) => check.files.normalized),
    themeCheckArtifactPaths: () => themeChecks.map((check) => check.files.normalized),
    observationManifestFiles: () => observationManifestFiles(artifactRoot, observations),
    pluginCheckManifestFiles: () => pluginCheckManifestFiles(artifactRoot, pluginChecks),
    themeCheckManifestFiles: () => themeCheckManifestFiles(artifactRoot, themeChecks),
    formatRuntimeLog: () => formatRuntimeLog(events),
    formatCommandsLog: () => formatCommandsLog(commands),
    recordArtifactsCollected,
  }).build(artifactSpec)
}

export function formatRuntimeLog(events: LifecycleEvent[]): string {
  return events.map((event) => `[${event.timestamp}] ${event.type} ${JSON.stringify(event.data ?? {})}`).join("\n") + "\n"
}

export function formatCommandsLog(commands: ExecutionResult[]): string {
  return (
    commands
      .map((command) => {
        const header = `[${command.startedAt}] ${command.command} ${command.args.join(" ")}`.trim()
        const output = [command.stdout, command.stderr].filter(Boolean).join("\n")
        return `${header}\nexitCode=${command.exitCode}\n${output}`
      })
      .join("\n---\n") + "\n"
  )
}

function observationManifestFiles(artifactRoot: string, observations: ObservationResult[]): ArtifactManifestFile[] {
  return observations.flatMap((observation) =>
    (observation.artifactRefs ?? [])
      .filter((ref): ref is RuntimeEpisodeTraceRef & { path: string } => typeof ref.path === "string" && ref.path.length > 0)
      .map((ref) => artifactManifestFile(join(artifactRoot, ref.path), ref.kind, ref.path.endsWith(".json") ? "application/json" : "text/plain")),
  )
}

async function redactBrowserArtifacts(artifactRoot: string, browserProbes: BrowserProbeArtifact[], redactor: ArtifactRedactor): Promise<void> {
  for (const probe of browserProbes) {
    for (const path of browserRedactionPaths(probe)) {
      const absolutePath = join(artifactRoot, path)
      try {
        await writeFile(absolutePath, redactor.redact(path, await readFile(absolutePath, "utf8")))
      } catch {
        // Browser capture is best-effort; preserve artifact collection if a file vanished.
      }
    }
  }
}
