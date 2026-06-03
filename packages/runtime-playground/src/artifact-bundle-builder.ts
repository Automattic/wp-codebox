import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import {
  buildRuntimeReferenceManifest,
  buildRuntimeReplayReferenceIndex,
  artifactManifestFile,
  artifactManifestFileWithSha256,
  calculateArtifactManifestFileSha256,
  refreshArtifactManifestFileSha256s,
  type ArtifactBundle,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactPreview,
  type ArtifactReviewBrowserSummary,
  type ArtifactSpec,
  type ExecutionResult,
  type LifecycleEvent,
  type MountSpec,
  type ObservationResult,
  type RuntimeCreateSpec,
  type RuntimeInfo,
  type Snapshot,
} from "@automattic/wp-codebox-core"
import type { BrowserProbeArtifact } from "./browser-artifacts.js"
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
  previewInfo(createdAt: string, previewHoldSeconds?: number): Promise<ArtifactPreview | undefined>
  browserReviewSummary(): ArtifactReviewBrowserSummary | undefined
  browserArtifacts(): BrowserProbeArtifact[]
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
    const redactor = new ArtifactRedactor(source.spec.secretEnv)

    await source.redactBrowserArtifacts(redactor)
    await source.redactPluginCheckArtifacts(redactor)
    await source.redactThemeCheckArtifacts(redactor)

    const preview = await source.previewInfo(createdAt, spec.previewHoldSeconds)
    const browser = source.browserReviewSummary()
    const runtime = await source.info()
    const runtimeSnapshots = spec.includeRuntimeSnapshotBundles ? source.snapshots : []
    const runtimeSnapshotFiles = runtimeSnapshots.flatMap((snapshot) =>
      (snapshot.artifactRefs ?? [])
        .filter((ref): ref is typeof ref & { path: string } => typeof ref.path === "string" && ref.path.length > 0)
        .map((ref) => artifactManifestFile(join(source.artifactRoot, ref.path), "runtime-snapshot", "application/json")),
    )
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
      runtimeReferenceManifest: relative(source.artifactRoot, runtimeReferenceManifestPath),
      runtimeReferenceIndex: relative(source.artifactRoot, runtimeReferenceIndexPath),
      runtimeReplayReferenceIndex: relative(source.artifactRoot, runtimeReplayReferenceIndexPath),
      mountDiffs: relative(source.artifactRoot, diffsPath),
      ...(runtimeSnapshotFiles.length > 0 ? { runtimeSnapshots: runtimeSnapshotFiles.map((file) => relative(source.artifactRoot, file.path)) } : {}),
      ...(browser ? { browser: browser.probes.find((probe) => probe.summaryFile)?.summaryFile ?? "files/browser/summary.json" } : {}),
      ...(source.pluginCheckArtifactPaths().length > 0 ? { pluginChecks: source.pluginCheckArtifactPaths() } : {}),
      ...(source.themeCheckArtifactPaths().length > 0 ? { themeChecks: source.themeCheckArtifactPaths() } : {}),
    }
    metadata.artifacts = artifactFiles
    const blueprintAfter = buildBlueprintAfter({
      environment: source.spec.environment,
      capturedMounts,
    })
    const blueprintAfterNotes = buildBlueprintAfterNotes({
      createdAt,
      runtimeId: source.runtimeId,
      environment: source.spec.environment,
      mounts: source.mounts,
      capturedMounts,
    })

    const manifestFiles: ArtifactManifestFile[] = [
      artifactManifestFile(manifestPath, "manifest", "application/json"),
      artifactManifestFile(metadataPath, "metadata", "application/json"),
      artifactManifestFile(blueprintAfterPath, "blueprint-after", "application/json"),
      artifactManifestFile(blueprintAfterNotesPath, "blueprint-after-notes", "application/json"),
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
      artifactManifestFile(runtimeReferenceManifestPath, "runtime-reference-manifest", "application/json"),
      artifactManifestFile(runtimeReferenceIndexPath, "runtime-reference-index", "application/json"),
      artifactManifestFile(runtimeReplayReferenceIndexPath, "runtime-replay-index", "application/json"),
      ...source.browserManifestFiles(),
      ...source.observationManifestFiles(),
      ...source.pluginCheckManifestFiles(),
      ...source.themeCheckManifestFiles(),
      ...runtimeSnapshotFiles,
      ...mountDiffs.map((diff) => artifactManifestFile(join(source.artifactRoot, diff.artifactPath), "diff", "text/x-diff")),
      ...capturedMounts.files.map((file) =>
        artifactManifestFile(join(source.artifactRoot, file.artifactPath), "file", file.contentType),
      ),
    ]

    metadata.preview = preview

    await writeRedactedArtifact(redactor, blueprintAfterPath, source.artifactRoot, `${JSON.stringify(blueprintAfter, null, 2)}\n`)
    await writeRedactedArtifact(redactor, blueprintAfterNotesPath, source.artifactRoot, `${JSON.stringify(blueprintAfterNotes, null, 2)}\n`)
    await writeJsonLines(eventsPath, source.events, redactor, source.artifactRoot)
    await writeJsonLines(commandsPath, source.commands, redactor, source.artifactRoot)
    await writeJsonLines(observationsPath, source.observations, redactor, source.artifactRoot)
    await writeRedactedArtifact(redactor, runtimeLogPath, source.artifactRoot, source.formatRuntimeLog())
    await writeRedactedArtifact(redactor, commandsLogPath, source.artifactRoot, source.formatCommandsLog())
    await writeRedactedArtifact(redactor, mountsPath, source.artifactRoot, `${JSON.stringify(source.mounts, null, 2)}\n`)
    await writeRedactedArtifact(redactor, capturedMountsPath, source.artifactRoot, `${JSON.stringify(serializeCapturedMountFiles(capturedMounts), null, 2)}\n`)
    await writeRedactedArtifact(redactor, diffsPath, source.artifactRoot, `${JSON.stringify(mountDiffs, null, 2)}\n`)
    await writeRedactedArtifact(redactor, workspacePatchPath, source.artifactRoot, `${JSON.stringify(workspacePatch, null, 2)}\n`)
    await writeFile(changedFilesPath, changedFilesJson)
    await writeFile(patchPath, redactedPatch)
    await writeRedactedArtifact(redactor, diagnosticsPath, source.artifactRoot, `${JSON.stringify(diagnostics, null, 2)}\n`)
    await writeRedactedArtifact(redactor, testResultsPath, source.artifactRoot, `${JSON.stringify(testResults, null, 2)}\n`)
    const redaction = redactor.summary()
    if (redaction.total > 0) {
      review.redaction = redaction
      review.riskFlags.push("secrets-redacted")
    }
    await writeRedactedArtifact(redactor, reviewPath, source.artifactRoot, `${JSON.stringify(review, null, 2)}\n`)
    await writeFile(runtimeReferenceManifestPath, "{}\n")
    await writeFile(runtimeReferenceIndexPath, "{}\n")
    await writeFile(runtimeReplayReferenceIndexPath, "{}\n")
    metadata.redaction = redactor.summary()
    await writeRedactedArtifact(redactor, metadataPath, source.artifactRoot, `${JSON.stringify(metadata, null, 2)}\n`)

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
    await writeFile(runtimeReferenceIndexPath, `${JSON.stringify(runtimeReferenceIndex, null, 2)}\n`)
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
        .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 })),
      snapshots: runtimeSnapshots,
    })
    await writeFile(runtimeReferenceManifestPath, `${JSON.stringify(runtimeReferenceManifest, null, 2)}\n`)
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
        .map((file) => file.path === "files/runtime-reference-manifest.json" ? runtimeReferenceManifestRef : ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 })),
      runtimeReferenceManifest: runtimeReferenceManifestRef,
      snapshots: runtimeSnapshots,
    })
    await writeFile(runtimeReplayReferenceIndexPath, `${JSON.stringify(runtimeReplayReferenceIndex, null, 2)}\n`)
    await refreshArtifactManifestFileSha256s(source.artifactRoot, manifest)
    await writeRedactedArtifact(redactor, manifestPath, source.artifactRoot, `${JSON.stringify(manifest, null, 2)}\n`)

    return {
      id: bundleId,
      directory: source.artifactRoot,
      manifestPath,
      metadataPath,
      blueprintAfterPath,
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
      runtimeReferenceManifestPath,
      runtimeReferenceIndexPath,
      runtimeReplayReferenceIndexPath,
      ...(preview ? { preview } : {}),
      contentDigest,
      createdAt,
    }
  }
}

async function writeJsonLines(path: string, records: unknown[], redactor: ArtifactRedactor, artifactRoot: string): Promise<void> {
  await writeRedactedArtifact(redactor, path, artifactRoot, records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "")
}

async function writeRedactedArtifact(redactor: ArtifactRedactor, path: string, artifactRoot: string, contents: string): Promise<void> {
  await writeFile(path, redactor.redact(relative(artifactRoot, path), contents))
}
