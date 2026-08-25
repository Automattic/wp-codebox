import { access } from "node:fs/promises"
import { join } from "node:path"
import { artifactManifestFile } from "@automattic/wp-codebox-core"
import { normalizeJsonValue } from "@automattic/wp-codebox-core/internals"
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
} from "@automattic/wp-codebox-core"
import { ArtifactBundleBuilder } from "./artifact-bundle-builder.js"
import { redactArtifactFiles } from "./artifact-bundle-writer.js"
import type { ArtifactRedactor } from "./artifacts.js"
import { browserManifestFiles as browserArtifactManifestFiles, browserRedactionPaths, browserReviewSummary as browserArtifactReviewSummary, type BrowserArtifact } from "./browser-artifacts.js"
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
  browserProbes: BrowserArtifact[]
  commands: ExecutionResult[]
  createdAt: string
  events: LifecycleEvent[]
  info: () => Promise<RuntimeInfo>
  mounts: MountSpec[]
  observations: ObservationResult[]
  pluginChecks: PluginCheckArtifact[]
  previewInfo: (createdAt: string, holdSeconds: number, commands: ExecutionResult[]) => Promise<ArtifactPreview | undefined>
  recordArtifactsCollected: (bundleId: string, createdAt: string, artifactSpec: ArtifactSpec) => void
  runtimeId: string
  snapshots: Snapshot[]
  spec: RuntimeCreateSpec
  themeChecks: ThemeCheckArtifact[]
}, artifactSpec: ArtifactSpec = {}): Promise<ArtifactBundle> {
  const { probes, missing } = await availableBrowserArtifacts(artifactRoot, browserProbes)
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
    browserReviewSummary: () => browserArtifactReviewSummary(probes),
    browserArtifacts: () => probes,
    additionalArtifactDiagnostics: () => missing,
    captureMountedFiles: (filesDirectory, redactor) => captureMountedFiles(filesDirectory, mounts, redactor),
    captureMountDiffs: (filesDirectory, redactor) => captureMountDiffs(artifactRoot, filesDirectory, mounts, redactor),
    redactBrowserArtifacts: (redactor) => redactBrowserArtifacts(artifactRoot, probes, redactor),
    redactPluginCheckArtifacts: (redactor) => redactPluginCheckArtifacts(artifactRoot, pluginChecks, redactor),
    redactThemeCheckArtifacts: (redactor) => redactThemeCheckArtifacts(artifactRoot, themeChecks, redactor),
    browserManifestFiles: () => browserArtifactManifestFiles(artifactRoot, probes),
    pluginCheckArtifactPaths: () => pluginChecks.map((check) => check.files.normalized),
    themeCheckArtifactPaths: () => themeChecks.map((check) => check.files.normalized),
    observationManifestFiles: () => observationManifestFiles(artifactRoot, observations),
    pluginCheckManifestFiles: () => pluginCheckManifestFiles(artifactRoot, pluginChecks),
    themeCheckManifestFiles: () => themeCheckManifestFiles(artifactRoot, themeChecks),
    formatRuntimeLog: () => formatRuntimeLog(events),
    formatCommandsLog: (artifactCommands) => formatCommandsLog(artifactCommands),
    recordArtifactsCollected,
  }).build(artifactSpec)
}

async function availableBrowserArtifacts(artifactRoot: string, probes: BrowserArtifact[]): Promise<{ probes: BrowserArtifact[]; missing: unknown[] }> {
  const available: BrowserArtifact[] = []
  const missing: unknown[] = []
  for (const probe of probes) {
    const files = { ...probe.files }
    const fileRecord = files as Record<string, unknown>
    for (const [key, value] of Object.entries(probe.files)) {
      const paths = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
      const existing: string[] = []
      for (const path of paths) {
        try {
          await access(join(artifactRoot, path))
          existing.push(path)
        } catch (error) {
          if (!isMissingFileError(error)) throw error
          missing.push({
            type: "artifact-missing",
            severity: "warning",
            code: "browser-capture-not-materialized",
            message: `Optional browser capture was not materialized: ${path}`,
            source: "browser-artifact-collection",
            path,
            details: { browserArtifactType: probe.artifactType, field: key },
          })
        }
      }
      if (Array.isArray(value)) {
        if (existing.length > 0) fileRecord[key] = existing
        else delete fileRecord[key]
      } else if (existing.length > 0) {
        fileRecord[key] = existing[0]
      } else {
        delete fileRecord[key]
      }
    }
    available.push({ ...probe, files, summary: { ...probe.summary, screenshot: Boolean(files.screenshot) } } as BrowserArtifact)
  }
  return { probes: available, missing }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")
}

export function formatRuntimeLog(events: LifecycleEvent[]): string {
  return events.map((event) => `[${event.timestamp}] ${event.type} ${JSON.stringify(normalizeJsonValue(event.data ?? {}))}`).join("\n") + "\n"
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
  return observations.flatMap((observation) => observation.artifactManifestFiles ??
    (observation.artifactRefs ?? [])
      .filter((ref): ref is RuntimeEpisodeTraceRef & { path: string } => typeof ref.path === "string" && ref.path.length > 0)
      .map((ref) => artifactManifestFile(join(artifactRoot, ref.path), ref.kind, ref.path.endsWith(".json") ? "application/json" : "text/plain")),
  )
}

async function redactBrowserArtifacts(artifactRoot: string, browserProbes: BrowserArtifact[], redactor: ArtifactRedactor): Promise<void> {
  for (const probe of browserProbes) {
    await redactArtifactFiles(artifactRoot, browserRedactionPaths(probe), redactor)
  }
}
