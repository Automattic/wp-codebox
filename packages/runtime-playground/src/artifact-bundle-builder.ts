import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import {
  buildRuntimeReferenceManifest,
  buildRuntimeReplayReferenceIndex,
  artifactFileDigest,
  artifactManifestFile,
  artifactManifestFileWithSha256,
  calculateArtifactManifestFileSha256,
  refreshArtifactManifestFileSha256s,
  type ArtifactEvidenceRef,
  type ArtifactBundle,
  type ArtifactDurablePreviewRef,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactViewerMetadata,
  type ArtifactPreview,
  type ArtifactPreviewBlocker,
  type ArtifactPreviewEvidence,
  type ArtifactPreviewSessionEvidence,
  type ArtifactPackageProvenance,
  type ArtifactReviewBrowserSummary,
  type ArtifactSpec,
  type BrowserStartupProgressEvent,
  type ExecutionResult,
  type LifecycleEvent,
  type MountSpec,
  type ObservationResult,
  type RuntimeCreateSpec,
  type RuntimeEpisodeTraceRef,
  type RuntimeInfo,
  type Snapshot,
} from "@automattic/wp-codebox-core"
import { normalizeJsonValue, stripUndefined } from "@automattic/wp-codebox-core/internals"
import type { BrowserArtifact } from "./browser-artifacts.js"
import {
  ArtifactRedactor,
  artifactContentDigest,
  buildArtifactDiagnostics,
  buildArtifactProvenance,
  buildArtifactReview,
  buildWorkspacePatchArtifact,
  buildBlueprintAfter,
  buildBlueprintAfterNotes,
  buildTestResults,
  serializeCapturedMountFiles,
  type CapturedMountFiles,
  type MountDiffsResult,
} from "./artifacts.js"
import { buildRuntimeReferenceIndex } from "./runtime-reference-index.js"
import { buildReplayableWordPressSiteBlueprint, buildReplayableWordPressSiteLimitations } from "./replayable-wordpress-site-bundle.js"
import { runtimeSnapshotPayload, type RuntimeSnapshotArtifact } from "./runtime-snapshot.js"
import { previewReviewerAccess } from "./preview-reviewer-access.js"

export interface ArtifactBundleBuilderSource {
  artifactRoot: string
  runtimeId: string
  runtimeCreatedAt: string
  spec: RuntimeCreateSpec
  mounts: MountSpec[]
  commands: ExecutionResult[]
  observations: ObservationResult[]
  snapshots: Snapshot[]
  events: LifecycleEvent[]
  info(): Promise<RuntimeInfo>
  previewInfo(createdAt: string, previewHoldSeconds: number | undefined, commands: ExecutionResult[]): Promise<ArtifactPreview | undefined>
  browserReviewSummary(): ArtifactReviewBrowserSummary | undefined
  browserArtifacts(): BrowserArtifact[]
  captureMountedFiles(filesDirectory: string, redactor: ArtifactRedactor): Promise<CapturedMountFiles>
  captureMountDiffs(filesDirectory: string, redactor: ArtifactRedactor): Promise<MountDiffsResult>
  redactBrowserArtifacts(redactor: ArtifactRedactor): Promise<void>
  redactPluginCheckArtifacts(redactor: ArtifactRedactor): Promise<void>
  redactThemeCheckArtifacts(redactor: ArtifactRedactor): Promise<void>
  browserManifestFiles(): ArtifactManifestFile[]
  pluginCheckArtifactPaths(): string[]
  themeCheckArtifactPaths(): string[]
  observationManifestFiles(): ArtifactManifestFile[]
  pluginCheckManifestFiles(): ArtifactManifestFile[]
  themeCheckManifestFiles(): ArtifactManifestFile[]
  formatRuntimeLog(): string
  formatCommandsLog(): string
  recordArtifactsCollected(bundleId: string, createdAt: string, spec: ArtifactSpec): void
}

export class ArtifactBundleBuilder {
  constructor(private readonly source: ArtifactBundleBuilderSource) {}

  async build(spec: ArtifactSpec = {}): Promise<ArtifactBundle> {
    const { source } = this
    await mkdir(source.artifactRoot, { recursive: true })
    const logsDirectory = join(source.artifactRoot, "logs")
    const filesDirectory = join(source.artifactRoot, "files")
    await mkdir(logsDirectory, { recursive: true })
    await mkdir(filesDirectory, { recursive: true })

    const createdAt = new Date().toISOString()
    const manifestPath = join(source.artifactRoot, "manifest.json")
    const metadataPath = join(source.artifactRoot, "metadata.json")
    const blueprintAfterPath = join(source.artifactRoot, "blueprint.after.json")
    const blueprintAfterNotesPath = join(source.artifactRoot, "blueprint.after-notes.json")
    const eventsPath = join(source.artifactRoot, "events.jsonl")
    const commandsPath = join(source.artifactRoot, "commands.jsonl")
    const observationsPath = join(source.artifactRoot, "observations.jsonl")
    const runtimeLogPath = join(logsDirectory, "runtime.log")
    const commandsLogPath = join(logsDirectory, "commands.log")
    const mountsPath = join(filesDirectory, "mounts.json")
    const capturedMountsPath = join(filesDirectory, "mounted-files.json")
    const diffsPath = join(filesDirectory, "diffs.json")
    const changedFilesPath = join(filesDirectory, "changed-files.json")
    const patchPath = join(filesDirectory, "patch.diff")
    const workspacePatchPath = join(filesDirectory, "workspace-patch.json")
    const diagnosticsPath = join(filesDirectory, "diagnostics.json")
    const testResultsPath = join(filesDirectory, "test-results.json")
    const reviewPath = join(filesDirectory, "review.json")
    const runtimeReferenceManifestPath = join(filesDirectory, "runtime-reference-manifest.json")
    const runtimeReferenceIndexPath = join(filesDirectory, "runtime-reference-index.json")
    const runtimeReplayReferenceIndexPath = join(filesDirectory, "runtime-replay-index.json")
    const previewEvidencePath = join(filesDirectory, "preview-evidence.json")
    const previewSessionEvidencePath = join(filesDirectory, "preview-session-evidence.json")
    const redactor = new ArtifactRedactor(source.spec.secretEnv)

    await source.redactBrowserArtifacts(redactor)
    await source.redactPluginCheckArtifacts(redactor)
    await source.redactThemeCheckArtifacts(redactor)

    const preview = heldPreviewWithExternalAccessBlockers(await source.previewInfo(createdAt, spec.previewHoldSeconds, source.commands), source.commands)
    const browser = source.browserReviewSummary()
    const runtime = await source.info()
    const durablePreview = await buildDurableArtifactPreview({
      artifactRoot: source.artifactRoot,
      createdAt,
      probes: source.browserArtifacts(),
      redactor,
    })
    const replaySnapshot = portableSiteReplaySnapshot(
      await firstRuntimeStateSnapshotPayload(source.snapshots),
      source.spec.environment.blueprint,
    )
    const runtimeSnapshots = spec.includeRuntimeSnapshotBundles ? source.snapshots : []
    const runtimeSnapshotFiles = runtimeSnapshots.flatMap((snapshot) =>
      (snapshot.artifactRefs ?? [])
        .filter((ref): ref is typeof ref & { path: string } => typeof ref.path === "string" && ref.path.length > 0)
        .map((ref) => artifactManifestFile(join(source.artifactRoot, ref.path), "runtime-snapshot", "application/json")),
    )
    const replayExportPackageFiles = replayExportPackageManifestFiles(source.artifactRoot, source.commands)
    const capturedMounts = await source.captureMountedFiles(filesDirectory, redactor)
    const { mountDiffs, changedFiles, patch, diagnostics: mountDiffDiagnostics } = await source.captureMountDiffs(filesDirectory, redactor)
    const changedFilesJson = redactor.redact("files/changed-files.json", `${JSON.stringify(changedFiles, null, 2)}\n`)
    const redactedPatch = redactor.redact("files/patch.diff", patch)
    const contentDigest = artifactContentDigest(changedFilesJson, redactedPatch)
    const bundleId = `artifact-bundle-sha256-${contentDigest}`
    const contentDigestMetadata = {
      algorithm: "sha256",
      inputs: ["files/changed-files.json", "files/patch.diff"],
      value: contentDigest,
    }
    const provenance = buildArtifactProvenance({
      runtime,
      context: source.spec.metadata ?? {},
      mounts: source.mounts,
    })
    const artifactBundleRef: RuntimeEpisodeTraceRef = {
      kind: "artifact-bundle",
      id: bundleId,
      digest: { algorithm: "sha256", value: contentDigest },
      path: "manifest.json",
    }
    const previewEvidence = buildPreviewEvidence({
      createdAt,
      runtime,
      preview,
      durablePreview: durablePreview?.preview,
      events: source.events,
      packages: provenance.packages,
      artifactBundleRef,
    })
    const previewSessionEvidenceRelativePath = relative(source.artifactRoot, previewSessionEvidencePath)
    const previewSessionEvidence = buildPreviewSessionEvidence({
      artifactId: bundleId,
      createdAt,
      runtime,
      preview,
      durablePreview: durablePreview?.preview,
      contentDigest,
      packages: provenance.packages,
      browser,
      paths: {
        manifest: relative(source.artifactRoot, manifestPath),
        review: relative(source.artifactRoot, reviewPath),
        runtimeEvents: relative(source.artifactRoot, eventsPath),
        runtimeLog: relative(source.artifactRoot, runtimeLogPath),
        runtimeReferenceManifest: relative(source.artifactRoot, runtimeReferenceManifestPath),
        runtimeReplayReferenceIndex: relative(source.artifactRoot, runtimeReplayReferenceIndexPath),
        durablePreview: durablePreview?.preview.manifest.path,
        browserSummary: browser ? browser.probes.find((probe) => probe.summaryFile)?.summaryFile ?? "files/browser/summary.json" : undefined,
      },
    })
    const previewSessionEvidenceJson = `${JSON.stringify(previewSessionEvidence, null, 2)}\n`
    const previewSessionEvidenceRef: ArtifactEvidenceRef = {
      path: previewSessionEvidenceRelativePath,
      kind: "preview-session-evidence",
      contentType: "application/json",
      sha256: artifactFileDigest(previewSessionEvidenceJson),
    }
    const metadata: Record<string, unknown> = {
      id: bundleId,
      contentDigest: contentDigestMetadata,
      createdAt,
      runtime,
      provenance,
      mounts: source.mounts,
      policy: source.spec.policy,
      context: source.spec.metadata ?? {},
      spec,
    }
    source.recordArtifactsCollected(bundleId, createdAt, spec)
    const diagnostics = buildArtifactDiagnostics(source.observations)
    diagnostics.diagnostics.push(...mountDiffDiagnostics)
    diagnostics.summary.total = diagnostics.diagnostics.length
    diagnostics.summary.error = diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length
    diagnostics.summary.warning = diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length
    diagnostics.summary.notice = diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === "notice").length
    diagnostics.summary.info = diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === "info").length
    diagnostics.status = diagnostics.summary.total > 0 ? "reported" : "clean"
    const testResults = buildTestResults()
    const review = buildArtifactReview({
      artifactId: bundleId,
      createdAt,
      provenance,
      changedFiles,
      patch: redactedPatch,
      contentDigest,
      runtimeCreatedAt: source.runtimeCreatedAt,
      mounts: source.mounts,
      preview,
      previewEvidencePath: "files/preview-evidence.json",
      previewSessionEvidencePath: previewSessionEvidenceRelativePath,
      browser,
      diagnosticsPath: "files/diagnostics.json",
    })
    const workspacePatch = buildWorkspacePatchArtifact({
      createdAt,
      provenance,
      mounts: source.mounts,
      mountDiffs,
      changedFiles,
      contentDigest,
    })
    const artifactFiles = {
      workspacePatch: relative(source.artifactRoot, workspacePatchPath),
      changedFiles: relative(source.artifactRoot, changedFilesPath),
      patch: relative(source.artifactRoot, patchPath),
      diagnostics: relative(source.artifactRoot, diagnosticsPath),
      testResults: relative(source.artifactRoot, testResultsPath),
      review: relative(source.artifactRoot, reviewPath),
      previewSessionEvidence: previewSessionEvidenceRelativePath,
      runtimeReferenceManifest: relative(source.artifactRoot, runtimeReferenceManifestPath),
      runtimeReferenceIndex: relative(source.artifactRoot, runtimeReferenceIndexPath),
      runtimeReplayReferenceIndex: relative(source.artifactRoot, runtimeReplayReferenceIndexPath),
      previewEvidence: relative(source.artifactRoot, previewEvidencePath),
      ...(durablePreview ? { durablePreview: durablePreview.preview.manifest.path } : {}),
      mountDiffs: relative(source.artifactRoot, diffsPath),
      ...(runtimeSnapshotFiles.length > 0 ? { runtimeSnapshots: runtimeSnapshotFiles.map((file) => relative(source.artifactRoot, file.path)) } : {}),
      ...(browser ? { browser: browser.probes.find((probe) => probe.summaryFile)?.summaryFile ?? "files/browser/summary.json" } : {}),
      ...(source.pluginCheckArtifactPaths().length > 0 ? { pluginChecks: source.pluginCheckArtifactPaths() } : {}),
      ...(source.themeCheckArtifactPaths().length > 0 ? { themeChecks: source.themeCheckArtifactPaths() } : {}),
    }
    metadata.artifacts = artifactFiles
    const partialBlueprintAfter = buildBlueprintAfter({
      environment: source.spec.environment,
      capturedMounts,
    })
    const partialBlueprintAfterNotes = buildBlueprintAfterNotes({
      createdAt,
      runtimeId: source.runtimeId,
      environment: source.spec.environment,
      mounts: source.mounts,
      capturedMounts,
    })
    const blueprintAfter = replaySnapshot
      ? buildReplayableWordPressSiteBlueprint(replaySnapshot, { landingPage: partialBlueprintAfter.landingPage as string | undefined })
      : partialBlueprintAfter
    const blueprintAfterNotes = replaySnapshot
      ? buildReplayableWordPressSiteLimitations(replaySnapshot, {
        source: {
          kind: "runtime-state-snapshot",
          runtimeId: source.runtimeId,
          snapshotId: replaySnapshot.id,
          diagnosticBlueprint: "files/blueprint.after.partial.json",
        },
      })
      : partialBlueprintAfterNotes
    const blueprintAfterViewer = blueprintAfterReplayViewerMetadata(replaySnapshot ? "replayable-runtime-state" : "partial")
    const partialBlueprintAfterPath = join(filesDirectory, "blueprint.after.partial.json")

    const manifestFiles: ArtifactManifestFile[] = [
      artifactManifestFile(manifestPath, "manifest", "application/json"),
      artifactManifestFile(metadataPath, "metadata", "application/json"),
      artifactManifestFile(blueprintAfterPath, "blueprint-after", "application/json", undefined, cloneArtifactViewerMetadata(blueprintAfterViewer)),
      artifactManifestFile(blueprintAfterNotesPath, "blueprint-after-notes", "application/json"),
      ...(replaySnapshot ? [artifactManifestFile(partialBlueprintAfterPath, "blueprint-after-diagnostic", "application/json")] : []),
      artifactManifestFile(eventsPath, "events", "application/x-ndjson"),
      artifactManifestFile(commandsPath, "commands", "application/x-ndjson"),
      artifactManifestFile(observationsPath, "observations", "application/x-ndjson"),
      artifactManifestFile(runtimeLogPath, "log", "text/plain"),
      artifactManifestFile(commandsLogPath, "log", "text/plain"),
      artifactManifestFile(mountsPath, "mounts", "application/json"),
      artifactManifestFile(capturedMountsPath, "mounted-files", "application/json"),
      artifactManifestFile(diffsPath, "mount-diffs", "application/json"),
      artifactManifestFile(workspacePatchPath, "workspace-patch", "application/json"),
      artifactManifestFile(changedFilesPath, "changed-files", "application/json"),
      artifactManifestFile(patchPath, "patch", "text/x-diff"),
      artifactManifestFile(diagnosticsPath, "diagnostics", "application/json"),
      artifactManifestFile(testResultsPath, "test-results", "application/json"),
      artifactManifestFile(reviewPath, "review", "application/json"),
      artifactManifestFile(previewSessionEvidencePath, "preview-session-evidence", "application/json"),
      artifactManifestFile(runtimeReferenceManifestPath, "runtime-reference-manifest", "application/json"),
      artifactManifestFile(runtimeReferenceIndexPath, "runtime-reference-index", "application/json"),
      artifactManifestFile(runtimeReplayReferenceIndexPath, "runtime-replay-index", "application/json"),
      artifactManifestFile(previewEvidencePath, "preview-evidence", "application/json"),
      ...(durablePreview ? durablePreview.manifestFiles : []),
      ...source.browserManifestFiles(),
      ...source.observationManifestFiles(),
      ...source.pluginCheckManifestFiles(),
      ...source.themeCheckManifestFiles(),
      ...runtimeSnapshotFiles,
      ...replayExportPackageFiles,
      ...mountDiffs.map((diff) => artifactManifestFile(join(source.artifactRoot, diff.artifactPath), "diff", "text/x-diff")),
      ...capturedMounts.files.map((file) =>
        artifactManifestFile(join(source.artifactRoot, file.artifactPath), "file", file.contentType),
      ),
    ]

    metadata.preview = preview
    if (durablePreview) {
      metadata.durablePreview = durablePreview.preview
    }
    metadata.previewSessionEvidence = previewSessionEvidenceRef

    await writeRedactedArtifact(redactor, blueprintAfterPath, source.artifactRoot, artifactJson(blueprintAfter))
    await writeRedactedArtifact(redactor, blueprintAfterNotesPath, source.artifactRoot, artifactJson(blueprintAfterNotes))
    if (replaySnapshot) {
      await writeRedactedArtifact(redactor, partialBlueprintAfterPath, source.artifactRoot, artifactJson(partialBlueprintAfter))
    }
    await writeJsonLines(eventsPath, source.events, redactor, source.artifactRoot)
    await writeJsonLines(commandsPath, source.commands, redactor, source.artifactRoot)
    await writeJsonLines(observationsPath, source.observations, redactor, source.artifactRoot)
    await writeRedactedArtifact(redactor, runtimeLogPath, source.artifactRoot, source.formatRuntimeLog())
    await writeRedactedArtifact(redactor, commandsLogPath, source.artifactRoot, source.formatCommandsLog())
    await writeRedactedArtifact(redactor, mountsPath, source.artifactRoot, artifactJson(source.mounts))
    await writeRedactedArtifact(redactor, capturedMountsPath, source.artifactRoot, artifactJson(serializeCapturedMountFiles(capturedMounts)))
    await writeRedactedArtifact(redactor, diffsPath, source.artifactRoot, artifactJson(mountDiffs))
    await writeRedactedArtifact(redactor, workspacePatchPath, source.artifactRoot, artifactJson(workspacePatch))
    await writeFile(changedFilesPath, changedFilesJson)
    await writeFile(patchPath, redactedPatch)
    await writeRedactedArtifact(redactor, diagnosticsPath, source.artifactRoot, artifactJson(diagnostics))
    await writeRedactedArtifact(redactor, testResultsPath, source.artifactRoot, artifactJson(testResults))
    await writeRedactedArtifact(redactor, previewEvidencePath, source.artifactRoot, artifactJson(previewEvidence))
    await writeFile(previewSessionEvidencePath, previewSessionEvidenceJson)
    const redaction = redactor.summary()
    if (redaction.total > 0) {
      review.redaction = redaction
      review.riskFlags.push("secrets-redacted")
    }
    await writeRedactedArtifact(redactor, reviewPath, source.artifactRoot, artifactJson(review))
    await writeFile(runtimeReferenceManifestPath, "{}\n")
    await writeFile(runtimeReferenceIndexPath, "{}\n")
    await writeFile(runtimeReplayReferenceIndexPath, "{}\n")
    metadata.redaction = redactor.summary()
    await writeRedactedArtifact(redactor, metadataPath, source.artifactRoot, artifactJson(metadata))

    const manifest: ArtifactManifest = {
      id: bundleId,
      contentDigest: {
        algorithm: "sha256",
        inputs: ["files/changed-files.json", "files/patch.diff"],
        value: contentDigest,
      },
      createdAt,
      runtime,
      files: manifestFiles.map((file) => ({
        ...file,
        path: relative(source.artifactRoot, file.path),
      })),
    }
    await refreshArtifactManifestFileSha256s(source.artifactRoot, manifest)
    const runtimeReferenceIndex = await buildRuntimeReferenceIndex({
      artifactRoot: source.artifactRoot,
      createdAt,
      manifestFiles: manifest.files,
      capturedMounts,
      browserProbes: source.browserArtifacts(),
    })
    await writeFile(runtimeReferenceIndexPath, artifactJson(runtimeReferenceIndex))
    await refreshArtifactManifestFileSha256s(source.artifactRoot, manifest)
    const runtimeReferenceManifest = buildRuntimeReferenceManifest({
      createdAt,
      runtime,
      artifactBundle: {
        kind: "artifact-bundle",
        id: bundleId,
        digest: { algorithm: "sha256", value: contentDigest },
      },
      files: manifest.files
        .filter((file) => !["manifest.json", "metadata.json", "files/review.json", "files/runtime-reference-manifest.json", "files/runtime-replay-index.json"].includes(file.path))
        .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256, ...(file.viewer ? { viewer: cloneArtifactViewerMetadata(file.viewer) } : {}) })),
      snapshots: runtimeSnapshots,
    })
    await writeFile(runtimeReferenceManifestPath, artifactJson(runtimeReferenceManifest))
    const runtimeReferenceManifestRef = artifactManifestFileWithSha256(
      "files/runtime-reference-manifest.json",
      "runtime-reference-manifest",
      "application/json",
      await calculateArtifactManifestFileSha256(source.artifactRoot, manifest, artifactManifestFile("files/runtime-reference-manifest.json", "runtime-reference-manifest", "application/json")),
    )
    const runtimeReplayReferenceIndex = buildRuntimeReplayReferenceIndex({
      createdAt,
      runtime,
      artifactBundle: {
        kind: "artifact-bundle",
        id: bundleId,
        digest: { algorithm: "sha256", value: contentDigest },
      },
      files: manifest.files
        .filter((file) => !["manifest.json", "files/runtime-replay-index.json"].includes(file.path))
        .map((file) => file.path === "files/runtime-reference-manifest.json" ? runtimeReferenceManifestRef : ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256, ...(file.viewer ? { viewer: cloneArtifactViewerMetadata(file.viewer) } : {}) })),
      runtimeReferenceManifest: runtimeReferenceManifestRef,
      snapshots: runtimeSnapshots,
    })
    await writeFile(runtimeReplayReferenceIndexPath, artifactJson(runtimeReplayReferenceIndex))
    await refreshArtifactManifestFileSha256s(source.artifactRoot, manifest)
    await writeRedactedArtifact(redactor, manifestPath, source.artifactRoot, artifactJson(manifest))

    return {
      id: bundleId,
      directory: source.artifactRoot,
      manifestPath,
      metadataPath,
      blueprintAfterPath,
      blueprintAfterViewer,
      blueprintAfterNotesPath,
      eventsPath,
      commandsPath,
      observationsPath,
      runtimeLogPath,
      commandsLogPath,
      mountsPath,
      capturedMountsPath,
      diffsPath,
      workspacePatchPath,
      changedFilesPath,
      patchPath,
      diagnosticsPath,
      testResultsPath,
      reviewPath,
      previewSessionEvidencePath,
      previewSessionEvidenceRef,
      ...(durablePreview ? { durablePreviewPath: join(source.artifactRoot, durablePreview.preview.manifest.path), durablePreview: durablePreview.preview } : {}),
      runtimeReferenceManifestPath,
      runtimeReferenceIndexPath,
      runtimeReplayReferenceIndexPath,
      previewEvidencePath,
      ...(preview ? { preview } : {}),
      contentDigest,
      createdAt,
    }
  }
}

async function firstRuntimeStateSnapshotPayload(snapshots: Snapshot[]): Promise<RuntimeSnapshotArtifact | undefined> {
  for (const snapshot of snapshots) {
    if (snapshot.semantics !== "runtime-state-artifact") {
      continue
    }

    try {
      return await runtimeSnapshotPayload(snapshot)
    } catch {
      continue
    }
  }
}

function portableSiteReplaySnapshot(snapshot: RuntimeSnapshotArtifact | undefined, sourceBlueprint: unknown): RuntimeSnapshotArtifact | undefined {
  if (!snapshot) {
    return undefined
  }

  const runtimeOnlyActivePlugins = activePluginsFromBlueprint(sourceBlueprint)
  const portable = JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshotArtifact
  const runtime = portable.metadata.runtime as RuntimeInfo & { environment?: RuntimeInfo["environment"] & { blueprint?: unknown } }
  if (runtime.environment && Object.hasOwn(runtime.environment, "blueprint")) {
    delete runtime.environment.blueprint
  }

  if (runtimeOnlyActivePlugins.length === 0) {
    return portable
  }

  portable.metadata.activePlugins = portable.metadata.activePlugins.filter((plugin) => !runtimeOnlyActivePlugins.includes(plugin))
  for (const table of portable.database.tables) {
    for (const row of table.rows) {
      if (row.option_name !== "active_plugins" || typeof row.option_value !== "string") {
        continue
      }

      const filtered = filterSerializedPluginList(row.option_value, runtimeOnlyActivePlugins)
      if (filtered) {
        row.option_value = filtered
      }
    }
  }

  return portable
}

function activePluginsFromBlueprint(blueprint: unknown): string[] {
  if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) {
    return []
  }

  const steps = Array.isArray((blueprint as { steps?: unknown }).steps) ? (blueprint as { steps: unknown[] }).steps : []
  return [...new Set(steps.flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step) || (step as { step?: unknown }).step !== "setSiteOptions") {
      return []
    }

    const options = (step as { options?: unknown }).options
    const activePlugins = options && typeof options === "object" && !Array.isArray(options)
      ? (options as { active_plugins?: unknown }).active_plugins
      : undefined
    return Array.isArray(activePlugins) ? activePlugins.filter((plugin): plugin is string => typeof plugin === "string" && plugin.length > 0) : []
  }))]
}

function filterSerializedPluginList(serialized: string, excluded: string[]): string | undefined {
  const plugins = [...serialized.matchAll(/s:\d+:"([^"]+)"/g)].map((match) => match[1])
  if (plugins.length === 0) {
    return undefined
  }

  const filtered = plugins.filter((plugin) => !excluded.includes(plugin))
  return `a:${filtered.length}:{${filtered.map((plugin, index) => `i:${index};s:${Buffer.byteLength(plugin, "utf8")}:"${plugin}";`).join("")}}`
}

function blueprintAfterReplayViewerMetadata(status: "partial" | "replayable-runtime-state"): ArtifactViewerMetadata {
  const limitations = status === "partial"
    ? [
      "WP Codebox does not host public artifact URLs; consumers must provide a browser-fetchable URL for blueprint.after.json.",
      "Text files from readwrite mounts are embedded in blueprint.after.json as writeFile steps; binary files are copied into artifacts but not replayed yet.",
      "Database exports, option diffs, uploaded media, active theme/plugin state, and screenshots are not captured yet.",
    ]
    : [
      "WP Codebox does not host public artifact URLs; consumers must provide a browser-fetchable URL for blueprint.after.json.",
      "The reviewer replay restores the generated WordPress site from a runtime-state snapshot instead of re-running generation runtime activation.",
    ]

  return {
    kind: "wordpress-playground-blueprint",
    base: "https://playground.wordpress.net/",
    query: {
      parameter: "blueprint-url",
      value: {
        source: "public-artifact-url",
        path: "blueprint.after.json",
      },
      encoding: "url",
    },
    replay: {
      status,
      limitations,
    },
  }
}

function cloneArtifactViewerMetadata(viewer: ArtifactViewerMetadata): ArtifactViewerMetadata {
  return JSON.parse(JSON.stringify(viewer)) as ArtifactViewerMetadata
}

function buildPreviewEvidence({
  artifactBundleRef,
  createdAt,
  durablePreview,
  events,
  packages,
  preview,
  runtime,
}: {
  artifactBundleRef: RuntimeEpisodeTraceRef
  createdAt: string
  durablePreview?: ArtifactDurablePreviewRef
  events: LifecycleEvent[]
  packages?: ArtifactPreviewEvidence["components"]["packages"]
  preview?: ArtifactPreview
  runtime: RuntimeInfo
}): ArtifactPreviewEvidence {
  const progressEvents = events.flatMap((event) => {
    if (event.type !== "runtime.browser-startup-progress") {
      return []
    }

    const progress = event.data?.event
    if (!isBrowserStartupProgressEvent(progress)) {
      return []
    }

    return [{
      id: event.id,
      phase: progress.phase,
      status: progress.status,
      label: progress.label,
      elapsed_ms: progress.elapsed_ms,
      timestamp: event.timestamp,
    }]
  })
  const lastProgress = progressEvents.at(-1)
  const ready = progressEvents.some((event) => event.phase === "preview:ready" && event.status === "complete")

  return {
    schema: "wp-codebox/preview-evidence/v1",
    createdAt,
    session: {
      kind: "browser-playground-session",
      id: `browser-playground-session-${runtime.id}`,
      runtimeId: runtime.id,
      backend: runtime.backend,
      environment: {
        kind: runtime.environment.kind,
        name: runtime.environment.name ?? runtime.environment.kind,
        version: runtime.environment.version ?? "unknown",
      },
    },
    run: artifactBundleRef,
    preview: {
      status: preview?.status ?? "unavailable",
      lifecycle: preview?.lifecycle ?? "not-started",
      source: preview?.source,
      createdAt: preview?.createdAt,
      expiresAt: preview?.expiresAt,
      holdSeconds: preview?.holdSeconds,
      ...(preview?.blockers ? { blockers: preview.blockers } : {}),
      url: safePreviewUrlRef(preview?.url),
      ...(preview?.publicUrl ? { publicUrl: safePreviewUrlRef(preview.publicUrl) } : {}),
      ...(preview?.localUrl ? { localUrl: safePreviewUrlRef(preview.localUrl) } : {}),
      ...(preview?.siteUrl ? { siteUrl: safePreviewUrlRef(preview.siteUrl) } : {}),
      ...(durablePreview ? { durablePreview } : {}),
      reviewerAccess: previewReviewerAccess(preview),
    },
    readiness: {
      ready,
      status: lastProgress?.status ?? "not-started",
      phase: lastProgress?.phase,
      events: progressEvents,
    },
    components: {
      packages,
      runtime: {
        backend: runtime.backend,
        wordpressVersion: runtime.environment.version,
      },
    },
  }
}

function isBrowserStartupProgressEvent(value: unknown): value is BrowserStartupProgressEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const candidate = value as Partial<BrowserStartupProgressEvent>
  return typeof candidate.phase === "string" && typeof candidate.status === "string"
}

function safePreviewUrlRef(url: string | undefined): ArtifactPreviewEvidence["preview"]["url"] {
  if (!url) {
    return {
      kind: "preview-url",
      availability: "unavailable",
      reviewerSafe: false,
      reason: "preview-url-unavailable",
    }
  }

  try {
    const parsed = new URL(url)
    if (isLocalPreviewHost(parsed.hostname)) {
      return {
        kind: "preview-url",
        availability: "local-only",
        reviewerSafe: false,
        reason: "loopback-url-omitted",
      }
    }
  } catch {
    return {
      kind: "preview-url",
      availability: "unavailable",
      reviewerSafe: false,
      reason: "invalid-url-omitted",
    }
  }

  return {
    kind: "preview-url",
    availability: "reviewer-safe",
    reviewerSafe: true,
    url,
  }
}

function isLocalPreviewHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost"
    || normalized === "0.0.0.0"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized.startsWith("127.")
}

async function writeJsonLines(path: string, records: unknown[], redactor: ArtifactRedactor, artifactRoot: string): Promise<void> {
  await writeRedactedArtifact(redactor, path, artifactRoot, records.length > 0 ? `${records.map((record) => artifactJsonLine(record)).join("\n")}\n` : "")
}

function artifactJson(value: unknown): string {
  return `${JSON.stringify(normalizeJsonValue(value), null, 2)}\n`
}

function artifactJsonLine(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value))
}

function buildPreviewSessionEvidence({
  artifactId,
  browser,
  contentDigest,
  createdAt,
  durablePreview,
  packages,
  paths,
  preview,
  runtime,
}: {
  artifactId: string
  browser?: ArtifactReviewBrowserSummary
  contentDigest: string
  createdAt: string
  durablePreview?: ArtifactDurablePreviewRef
  packages?: ArtifactPackageProvenance
  paths: {
    manifest: string
    review: string
    runtimeEvents: string
    runtimeLog: string
    runtimeReferenceManifest: string
    runtimeReplayReferenceIndex: string
    durablePreview?: string
    browserSummary?: string
  }
  preview?: ArtifactPreview
  runtime: RuntimeInfo
}): ArtifactPreviewSessionEvidence {
  return stripUndefined({
    schema: "wp-codebox/preview-session-evidence/v1" as const,
    artifactId,
    createdAt,
    session: {
      runtimeId: runtime.id,
      backend: runtime.backend,
      createdAt: runtime.createdAt,
      status: runtime.status,
      environment: stripUndefined({
        kind: runtime.environment.kind,
        name: runtime.environment.name,
        version: runtime.environment.version,
      }),
    },
    preview: preview ? stripUndefined({
      status: preview.status,
      lifecycle: preview.lifecycle,
      source: preview.source,
      createdAt: preview.createdAt,
      expiresAt: preview.expiresAt,
      holdSeconds: preview.holdSeconds,
      hasPublicUrl: Boolean(preview.publicUrl),
      hasSiteUrl: Boolean(preview.siteUrl),
      hasReviewerAuthBootstrap: Boolean(preview.reviewerAuthBootstrap),
      reviewerAccess: previewReviewerAccess(preview),
      blockers: preview.blockers,
    }) : undefined,
    refs: stripUndefined({
      artifactBundle: {
        kind: "artifact-bundle" as const,
        id: artifactId,
        digest: { algorithm: "sha256" as const, value: contentDigest },
      },
      manifest: evidenceRef(paths.manifest, "manifest"),
      review: evidenceRef(paths.review, "review"),
      runtimeEvents: evidenceRef(paths.runtimeEvents, "events", "application/x-ndjson"),
      runtimeLog: evidenceRef(paths.runtimeLog, "runtime-log", "text/plain"),
      runtimeReferenceManifest: evidenceRef(paths.runtimeReferenceManifest, "runtime-reference-manifest"),
      runtimeReplayReferenceIndex: evidenceRef(paths.runtimeReplayReferenceIndex, "runtime-replay-index"),
      browserSummary: browser && paths.browserSummary ? evidenceRef(paths.browserSummary, "browser-summary") : undefined,
      durablePreview: durablePreview && paths.durablePreview ? evidenceRef(paths.durablePreview, "artifact-preview") : undefined,
    }),
    components: packages,
  })
}

export function heldPreviewWithExternalAccessBlockers(preview: ArtifactPreview | undefined, commands: ExecutionResult[]): ArtifactPreview | undefined {
  if (!preview || preview.lifecycle !== "held-after-run" || !preview.holdSeconds) {
    return preview
  }

  const authCommand = commands.find((command) => browserCommandRequestsWordPressAdminAuth(command))
  if (!authCommand) {
    return preview
  }

  if (preview.reviewerAuthBootstrap) {
    return {
      ...preview,
      reviewerAccess: previewReviewerAccess(preview),
    }
  }

  const blocker: ArtifactPreviewBlocker = {
    schema: "wp-codebox/preview-blocker/v1",
    kind: "unsupported-preview",
    code: "external-wordpress-admin-auth-unavailable",
    message: "This held preview used auth=wordpress-admin inside the controlled automation browser. WP Codebox cannot safely export that in-memory WordPress admin session to an external reviewer browser, so admin URLs may redirect to login outside the automation context.",
    retryable: false,
    reviewerSafe: false,
    evidence: {
      command: authCommand.command,
      auth: "wordpress-admin",
    },
  }

  return {
    ...preview,
    blockers: [...(preview.blockers ?? []), blocker],
    reviewerAccess: previewReviewerAccess({ ...preview, blockers: [...(preview.blockers ?? []), blocker] }),
  }
}

function browserCommandRequestsWordPressAdminAuth(command: ExecutionResult): boolean {
  if (!["wordpress.browser-actions", "wordpress.browser-probe", "wordpress.browser-scenario", "wordpress.visual-compare"].includes(command.command)) {
    return false
  }

  return command.args.some((arg) => argRequestsWordPressAdminAuth(arg))
}

function argRequestsWordPressAdminAuth(arg: string): boolean {
  const separator = arg.indexOf("=")
  if (separator > 0) {
    const key = arg.slice(0, separator).trim()
    const value = arg.slice(separator + 1).trim()
    if (key === "auth" && value === "wordpress-admin") {
      return true
    }
    if ((key === "scenario" || key === "scenario-json") && /"auth"\s*:\s*"wordpress-admin"/.test(value)) {
      return true
    }
  }

  return /"auth"\s*:\s*"wordpress-admin"/.test(arg)
}

function evidenceRef(path: string, kind: string, contentType = "application/json"): ArtifactEvidenceRef {
  return { path, kind, contentType }
}

interface DurableArtifactPreviewBuildResult {
  preview: ArtifactDurablePreviewRef
  manifestFiles: ArtifactManifestFile[]
}

interface BrowserArtifactBundleWithFiles {
  probe: number
  schema?: string
  root?: string
  entrypoint?: string
  files: BrowserArtifactFile[]
}

interface BrowserArtifactFile {
  path: string
  content: string
  encoding: string
  contentType: string
}

async function buildDurableArtifactPreview({
  artifactRoot,
  createdAt,
  probes,
  redactor,
}: {
  artifactRoot: string
  createdAt: string
  probes: BrowserArtifact[]
  redactor: ArtifactRedactor
}): Promise<DurableArtifactPreviewBuildResult | undefined> {
  const bundle = findBrowserArtifactBundleWithFiles(probes)
  if (!bundle) {
    return undefined
  }

  const previewRoot = "files/artifact-preview/files"
  const manifestPath = "files/artifact-preview/manifest.json"
  const files: ArtifactEvidenceRef[] = []
  const manifestFiles: ArtifactManifestFile[] = []
  const writtenPaths = new Set<string>()

  for (const file of bundle.files) {
    const relativePath = safeArtifactPreviewPath(file.path)
    if (!relativePath || writtenPaths.has(relativePath)) {
      continue
    }

    const artifactPath = `${previewRoot}/${relativePath}`
    const absolutePath = join(artifactRoot, artifactPath)
    const contents = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8")
    const writtenContents = file.encoding === "base64" ? contents : Buffer.from(redactor.redact(artifactPath, contents.toString("utf8")), "utf8")
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, writtenContents)

    const ref = {
      path: artifactPath,
      kind: relativePath === "index.html" ? "artifact-preview-entrypoint" : "artifact-preview-file",
      contentType: file.contentType,
      sha256: artifactFileDigest(writtenContents),
    }
    files.push(ref)
    manifestFiles.push(artifactManifestFile(join(artifactRoot, artifactPath), ref.kind, ref.contentType))
    writtenPaths.add(relativePath)
  }

  if (files.length === 0) {
    return undefined
  }

  const entrypoint = durablePreviewEntrypoint(bundle, files, previewRoot)
  if (!entrypoint) {
    return undefined
  }

  const preview: ArtifactDurablePreviewRef = {
    kind: "artifact-preview",
    reviewerSafe: true,
    durable: true,
    entrypoint,
    manifest: evidenceRef(manifestPath, "artifact-preview"),
    source: stripUndefined({
      kind: "browser-runtime-artifact-bundle" as const,
      probe: bundle.probe,
      schema: bundle.schema,
      root: bundle.root,
      entrypoint: bundle.entrypoint,
    }),
    files,
  }
  const manifest = {
    schema: "wp-codebox/artifact-preview/v1",
    createdAt,
    reviewerSafe: true,
    durable: true,
    entrypoint,
    source: preview.source,
    files,
  }
  const manifestJson = redactor.redact(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(artifactRoot, manifestPath), manifestJson)
  preview.manifest.sha256 = artifactFileDigest(manifestJson)
  manifestFiles.unshift(artifactManifestFile(join(artifactRoot, manifestPath), "artifact-preview", "application/json"))

  return { preview, manifestFiles }
}

function findBrowserArtifactBundleWithFiles(probes: BrowserArtifact[]): BrowserArtifactBundleWithFiles | undefined {
  for (const [index, probe] of probes.entries()) {
    const scriptResult = asRecord(probe.summary.scriptResult)
    const candidate = asRecord(scriptResult?.artifact_bundle) ?? asRecord(scriptResult?.artifactBundle) ?? scriptResult
    const files = Array.isArray(candidate?.files) ? candidate.files : undefined
    if (!candidate || !files || files.length === 0) {
      continue
    }

    const entrypoint = stringValue(candidate.entrypoint) ?? stringValue(candidate.entryPoint)
    if (!entrypoint) {
      continue
    }

    const materializableFiles = files.flatMap((file) => materializableArtifactFile(file))
    if (materializableFiles.length === 0) {
      continue
    }

    return {
      probe: index,
      schema: stringValue(candidate.schema),
      root: stringValue(candidate.root),
      entrypoint,
      files: materializableFiles,
    }
  }

  return undefined
}

function materializableArtifactFile(value: unknown): BrowserArtifactFile[] {
  const file = asRecord(value)
  if (!file) {
    return []
  }

  const path = stringValue(file.path) ?? stringValue(file.name)
  const content = stringValue(file.content) ?? stringValue(file.contents) ?? stringValue(file.data) ?? stringValue(file.body)
  if (!path || typeof content !== "string") {
    return []
  }

  const encoding = (stringValue(file.encoding) ?? "utf8").toLowerCase()
  if (!["utf8", "utf-8", "base64"].includes(encoding)) {
    return []
  }

  return [{
    path,
    content,
    encoding: encoding === "utf-8" ? "utf8" : encoding,
    contentType: stringValue(file.contentType) ?? stringValue(file.content_type) ?? stringValue(file.mime_type) ?? artifactPreviewContentType(path),
  }]
}

function durablePreviewEntrypoint(bundle: BrowserArtifactBundleWithFiles, files: ArtifactEvidenceRef[], previewRoot: string): string | undefined {
  const relativePaths = new Set(files.map((file) => file.path.slice(`${previewRoot}/`.length)))
  const candidates = [
    bundle.entrypoint,
    stripArtifactPreviewRoot(bundle.entrypoint, bundle.root),
    "index.html",
  ].flatMap((path) => path ? [safeArtifactPreviewPath(path)] : []).filter((path): path is string => Boolean(path))

  for (const candidate of candidates) {
    if (relativePaths.has(candidate)) {
      return `${previewRoot}/${candidate}`
    }
  }

  return files.find((file) => file.path.endsWith(".html"))?.path ?? files[0]?.path
}

function stripArtifactPreviewRoot(path: string | undefined, root: string | undefined): string | undefined {
  const safeRoot = root ? safeArtifactPreviewPath(root) : undefined
  const safePath = path ? safeArtifactPreviewPath(path) : undefined
  if (!safeRoot || !safePath || safePath === safeRoot) {
    return undefined
  }

  return safePath.startsWith(`${safeRoot}/`) ? safePath.slice(safeRoot.length + 1) : undefined
}

function safeArtifactPreviewPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part.length > 0 && part !== ".")
  if (normalized.length === 0 || normalized.some((part) => part === "..")) {
    return undefined
  }

  return normalized.join("/")
}

function artifactPreviewContentType(path: string): string {
  const normalized = path.toLowerCase()
  if (normalized.endsWith(".html") || normalized.endsWith(".htm")) {
    return "text/html; charset=utf-8"
  }
  if (normalized.endsWith(".css")) {
    return "text/css; charset=utf-8"
  }
  if (normalized.endsWith(".js")) {
    return "text/javascript; charset=utf-8"
  }
  if (normalized.endsWith(".json")) {
    return "application/json"
  }
  if (normalized.endsWith(".svg")) {
    return "image/svg+xml"
  }
  if (normalized.endsWith(".png")) {
    return "image/png"
  }
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg"
  }

  return "application/octet-stream"
}

function replayExportPackageManifestFiles(artifactRoot: string, commands: ExecutionResult[]): ArtifactManifestFile[] {
  return commands.flatMap((command) => {
    if (command.command !== "wordpress.export-replay-package" || command.exitCode !== 0) {
      return []
    }

    let output: unknown
    try {
      output = JSON.parse(command.stdout.trim() || "{}")
    } catch {
      return []
    }

    const envelope = asRecord(output)
    const artifacts = asRecord(envelope?.artifacts)
    const directory = stringValue(envelope?.directory)
    if (envelope?.schema !== "wp-codebox/wordpress-replay-export/v1" || !directory || !artifacts) {
      return []
    }

    const refs: Array<{ key: string; kind: string; contentType: string }> = [
      { key: "manifest", kind: "replay-package-manifest", contentType: "application/json" },
      { key: "blueprint", kind: "blueprint-after", contentType: "application/json" },
      { key: "snapshot", kind: "runtime-snapshot", contentType: "application/json" },
      { key: "notes", kind: "blueprint-after-notes", contentType: "application/json" },
    ]

    return refs.flatMap((ref) => {
      const artifactPath = stringValue(artifacts[ref.key])
      if (!artifactPath) {
        return []
      }

      const absolutePath = join(directory, artifactPath)
      const manifestPath = relative(artifactRoot, absolutePath).replace(/\\/g, "/")
      if (manifestPath.startsWith("..") || manifestPath.startsWith("/")) {
        return []
      }

      return [artifactManifestFile(join(artifactRoot, manifestPath), ref.kind, ref.contentType)]
    })
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

async function writeRedactedArtifact(redactor: ArtifactRedactor, path: string, artifactRoot: string, contents: string): Promise<void> {
  await writeFile(path, redactor.redact(relative(artifactRoot, path), contents))
}
