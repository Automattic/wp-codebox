import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { RUNTIME_REFERENCE_MANIFEST_SCHEMA, RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA, createRuntime, runtimeReferenceManifestDigest, runtimeReplayReferenceIndexDigest, verifyArtifactBundle } from "@automattic/wp-codebox-core"
import { buildArtifactDiagnostics, createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"

const execFileAsync = promisify(execFile)
const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-artifacts-"))
const packageProvenanceFixture = JSON.parse(await readFile(resolve(import.meta.dirname, "../tests/fixtures/artifact-package-provenance-shape.json"), "utf8"))

try {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "packages/cli/dist/index.js",
      "recipe-run",
      "--recipe",
      "./examples/recipes/seeded-plugin-workspace.json",
      "--artifacts",
      artifactsDirectory,
      "--preview-hold",
      "1s",
      "--preview-public-url",
      "https://preview.example.test/codebox/",
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024 * 10,
    },
  )
  const output = JSON.parse(stdout)
  assert.equal(output.success, true)
  assert.equal(output.runtime.status, "created")
  assert.equal(output.runtime.previewUrl, "https://preview.example.test/codebox/")

  const artifacts = output.artifacts
  const verification = await verifyArtifactBundle(artifacts.directory)
  assert.equal(verification.valid, true, JSON.stringify(verification.violations, null, 2))
  assert.ok(artifacts.changedFilesPath, "artifact bundle should expose changedFilesPath")
  assert.ok(artifacts.patchPath, "artifact bundle should expose patchPath")
  assert.ok(artifacts.workspacePatchPath, "artifact bundle should expose workspacePatchPath")
  assert.ok(artifacts.diagnosticsPath, "artifact bundle should expose diagnosticsPath")
  assert.ok(artifacts.testResultsPath, "artifact bundle should expose testResultsPath")
  assert.ok(artifacts.reviewPath, "artifact bundle should expose reviewPath")
  assert.ok(artifacts.previewEvidencePath, "artifact bundle should expose previewEvidencePath")
  assert.equal(artifacts.preview.status, "available")
  assert.equal(artifacts.preview.lifecycle, "held-after-run")
  assert.equal(artifacts.preview.holdSeconds, 1)
  assert.equal(artifacts.preview.url, "https://preview.example.test/codebox/")
  assert.equal(artifacts.preview.publicUrl, "https://preview.example.test/codebox/")
  assert.equal(artifacts.preview.siteUrl, "https://preview.example.test/codebox/")
  assert.match(artifacts.preview.localUrl, /^http:\/\/127\.0\.0\.1:/)
  assert.equal(artifacts.preview.source, "public-url-override")

  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"))
  const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8"))
  const changedFiles = JSON.parse(await readFile(artifacts.changedFilesPath, "utf8"))
  const workspacePatch = JSON.parse(await readFile(artifacts.workspacePatchPath, "utf8"))
  const changedFilesJson = await readFile(artifacts.changedFilesPath, "utf8")
  const patch = await readFile(artifacts.patchPath, "utf8")
  const diagnostics = JSON.parse(await readFile(artifacts.diagnosticsPath, "utf8"))
  const testResults = JSON.parse(await readFile(artifacts.testResultsPath, "utf8"))
  const review = JSON.parse(await readFile(artifacts.reviewPath, "utf8"))
  const previewEvidence = JSON.parse(await readFile(artifacts.previewEvidencePath, "utf8"))
  const previewSessionEvidence = JSON.parse(await readFile(artifacts.previewSessionEvidencePath, "utf8"))
  const previewSessionEvidenceText = await readFile(artifacts.previewSessionEvidencePath, "utf8")
  const runtimeReferenceManifest = JSON.parse(await readFile(artifacts.runtimeReferenceManifestPath, "utf8"))
  const runtimeReferenceIndex = JSON.parse(await readFile(artifacts.runtimeReferenceIndexPath, "utf8"))
  const runtimeReplayReferenceIndex = JSON.parse(await readFile(artifacts.runtimeReplayReferenceIndexPath, "utf8"))
  const contentDigest = createHash("sha256")
    .update("wp-codebox/artifact-content/v1\n")
    .update("files/changed-files.json\n")
    .update(changedFilesJson)
    .update("\nfiles/patch.diff\n")
    .update(patch)
    .digest("hex")

  assert.equal(artifacts.id, `artifact-bundle-sha256-${contentDigest}`)
  assert.equal(artifacts.contentDigest, contentDigest)
  assert.equal(manifest.id, artifacts.id)
  assert.deepEqual(manifest.contentDigest, {
    algorithm: "sha256",
    inputs: ["files/changed-files.json", "files/patch.diff"],
    value: contentDigest,
  })
  assert.deepEqual(metadata.contentDigest, manifest.contentDigest)
  assert.deepEqual(metadata.preview, artifacts.preview)
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/changed-files.json" && file.kind === "changed-files"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/workspace-patch.json" && file.kind === "workspace-patch"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/patch.diff" && file.kind === "patch"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/diagnostics.json" && file.kind === "diagnostics"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/test-results.json" && file.kind === "test-results"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/review.json" && file.kind === "review"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/preview-session-evidence.json" && file.kind === "preview-session-evidence"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-reference-manifest.json" && file.kind === "runtime-reference-manifest"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-reference-index.json" && file.kind === "runtime-reference-index"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-replay-index.json" && file.kind === "runtime-replay-index"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/preview-evidence.json" && file.kind === "preview-evidence"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-evidence/run-attestation.json" && file.kind === "run-attestation"))
  const blueprintAfterManifestFile = manifestFile(manifest, "blueprint.after.json")
  assert.equal(blueprintAfterManifestFile.viewer.kind, "wordpress-playground-blueprint")
  assert.equal(blueprintAfterManifestFile.viewer.base, "https://playground.wordpress.net/")
  assert.equal(blueprintAfterManifestFile.viewer.query.parameter, "blueprint-url")
  assert.equal(blueprintAfterManifestFile.viewer.query.value.source, "public-artifact-url")
  assert.equal(blueprintAfterManifestFile.viewer.query.value.path, "blueprint.after.json")
  assert.equal(blueprintAfterManifestFile.viewer.query.encoding, "url")
  assert.equal(blueprintAfterManifestFile.viewer.replay.status, "replayable-runtime-state")
  assert.ok(blueprintAfterManifestFile.viewer.replay.limitations.some((limitation: string) => limitation.includes("runtime-state snapshot")))
  assert.deepEqual(artifacts.blueprintAfterViewer, blueprintAfterManifestFile.viewer)
  const runtimeEvidence = metadata.artifacts.runtimeEvidence
  assert.match(runtimeEvidence["run-attestation"].sha256, /^[a-f0-9]{64}$/)
  assert.ok(Array.isArray(metadata.artifacts.runtimeSnapshots))
  assert.ok(metadata.artifacts.runtimeSnapshots.length > 0)
  assert.ok(metadata.artifacts.runtimeSnapshots.every((path: string) => path.startsWith("files/runtime-snapshots/") && path.endsWith(".json")))
  const { runtimeSnapshots: _runtimeSnapshots, ...metadataArtifactsWithoutRuntimeSnapshots } = metadata.artifacts
  assert.deepEqual(metadataArtifactsWithoutRuntimeSnapshots, {
    workspacePatch: "files/workspace-patch.json",
    changedFiles: "files/changed-files.json",
    patch: "files/patch.diff",
    diagnostics: "files/diagnostics.json",
    testResults: "files/test-results.json",
    review: "files/review.json",
    previewSessionEvidence: "files/preview-session-evidence.json",
    runtimeReferenceManifest: "files/runtime-reference-manifest.json",
    runtimeReferenceIndex: "files/runtime-reference-index.json",
    runtimeReplayReferenceIndex: "files/runtime-replay-index.json",
    previewEvidence: "files/preview-evidence.json",
    mountDiffs: "files/diffs.json",
    runtimeEvidence,
  })
  assert.equal(metadata.provenance.runtime.backend, "wordpress-playground")
  assert.equal(metadata.provenance.runtime.version, "0.0.0")
  assert.equal(metadata.provenance.runtime.wordpressVersion, "latest")
  assert.equal(metadata.provenance.packages.schema, packageProvenanceFixture.schema)
  assert.equal(metadata.provenance.packages.wpCodebox.name, packageProvenanceFixture.wpCodebox.name)
  assert.equal(metadata.provenance.packages.wpCodebox.version, packageProvenanceFixture.wpCodebox.version)
  assert.match(metadata.provenance.packages.wpCodebox.source.digest.value, /^[a-f0-9]{64}$/)
  assert.equal(metadata.provenance.packages.runtimeCore.name, packageProvenanceFixture.runtimeCore.name)
  assert.equal(metadata.provenance.packages.runtimeCore.version, packageProvenanceFixture.runtimeCore.version)
  assert.match(metadata.provenance.packages.runtimeCore.source.digest.value, /^[a-f0-9]{64}$/)
  assert.equal(metadata.provenance.packages.runtimePlayground.name, packageProvenanceFixture.runtimePlayground.name)
  assert.equal(metadata.provenance.packages.runtimePlayground.version, packageProvenanceFixture.runtimePlayground.version)
  assert.match(metadata.provenance.packages.runtimePlayground.source.digest.value, /^[a-f0-9]{64}$/)
  assert.equal(metadata.provenance.packages.playground.cli.name, packageProvenanceFixture.playground.cli.name)
  assert.equal(metadata.provenance.packages.playground.cli.version, packageProvenanceFixture.playground.cli.version)
  assert.equal(metadata.provenance.packages.playground.wordpressBuilds.name, packageProvenanceFixture.playground.wordpressBuilds.name)
  assert.equal(metadata.provenance.packages.playground.wordpressBuilds.version, packageProvenanceFixture.playground.wordpressBuilds.version)
  assert.equal(metadata.provenance.packages.environment.wordpressVersion, "latest")
  assert.equal(metadata.provenance.packages.environment.nodeVersion, process.versions.node)
  assert.equal(metadata.provenance.task.kind, "recipe-run")
  assert.equal(metadata.provenance.task.recipePath.endsWith("examples/recipes/seeded-plugin-workspace.json"), true)
  assert.equal(metadata.provenance.task.preview.effective.publicUrl, "https://preview.example.test/codebox/")
  assert.ok(metadata.provenance.task.inputs.workspaces.length > 0)
  assert.equal(metadata.provenance.workspace.schema, "wp-codebox/sandbox-workspace/v1")
  assert.equal(metadata.provenance.workspace.root, "/workspace")
  assert.equal(metadata.provenance.workspace.defaultMode, "repo-backed")
  assert.equal(Object.hasOwn(metadata.provenance.workspace, "dmc"), false)
  assert.ok(metadata.provenance.workspace.mounts.some((mount: { target: string; sourceMode: string; mountRole?: string }) =>
    mount.target === "/wordpress/wp-content/plugins/seeded-helper" && mount.sourceMode === "repo-backed" && mount.mountRole === "recipe-workspace",
  ))
  assert.ok(metadata.provenance.mounts.some((mount: { target: string; mode: string; metadata?: { kind?: string } }) =>
    mount.target === "/wordpress/wp-content/plugins/seeded-helper" && mount.mode === "readwrite" && mount.metadata?.kind === "recipe-workspace",
  ))
  assert.equal(changedFiles.schema, "wp-codebox/changed-files/v1")
  assert.equal(workspacePatch.schema, "wp-codebox/workspace-patch/v1")
  assert.equal(workspacePatch.contentDigest.value, contentDigest)
  assert.equal(workspacePatch.workspace.schema, "wp-codebox/sandbox-workspace/v1")
  assert.equal(workspacePatch.workspace.root, "/workspace")
  assert.equal(workspacePatch.promotion.patch, "files/patch.diff")
  assert.equal(workspacePatch.promotion.changedFiles, "files/changed-files.json")
  assert.ok(workspacePatch.promotion.files.every((file: { intent: string }) => file.intent === "promotion"))
  assert.ok(workspacePatch.workspaces.some((workspace: { target: string; sourceMode: string; mountRole?: string; patch: string }) =>
    workspace.target === "/wordpress/wp-content/plugins/seeded-helper" && workspace.sourceMode === "repo-backed" && workspace.mountRole === "recipe-workspace" && workspace.patch === "files/diffs/mount-0.patch",
  ))
  assert.ok(
    changedFiles.files.some((file: { path: string; status: string }) =>
      file.path === "/wordpress/wp-content/plugins/seeded-helper/generated.txt" && file.status === "added",
    ),
  )
  assert.match(patch, /generated\.txt/)
  assert.match(patch, /\+cooked/)
  assert.equal(diagnostics.schema, "wp-codebox/artifact-diagnostics/v1")
  assert.equal(diagnostics.status, "clean")
  assert.deepEqual(diagnostics.summary, { total: 0, error: 0, warning: 0, notice: 0, info: 0 })
  assert.deepEqual(diagnostics.diagnostics, [])
  assert.equal(testResults.schema, "wp-codebox/test-results/v1")
  assert.equal(testResults.status, "unknown")
  assert.deepEqual(testResults.summary, { total: 0, passed: 0, failed: 0, skipped: 0, unknown: 0 })
  assert.deepEqual(testResults.suites, [])
  assert.ok(testResults.rawLogReferences.some((log: { path: string }) => log.path === "logs/commands.log"))
  assert.equal(review.schema, "wp-codebox/artifact-review/v1")
  assert.equal(review.artifactId, artifacts.id)
  assert.deepEqual(review.preview, artifacts.preview)
  assert.equal(review.provenance.task.kind, "recipe-run")
  assert.equal(review.provenance.runtime.wordpressVersion, "latest")
  assert.deepEqual(review.provenance.packages, metadata.provenance.packages)
  assert.equal(review.evidence.workspacePatch, "files/workspace-patch.json")
  assert.equal(review.evidence.patch, "files/patch.diff")
  assert.equal(review.evidence.artifactContentDigest, contentDigest)
  assert.equal(review.evidence.changedFiles, "files/changed-files.json")
  assert.equal(review.evidence.diagnostics, "files/diagnostics.json")
  assert.equal(review.evidence.testResults, "files/test-results.json")
  assert.equal(review.evidence.previewSessionEvidence, "files/preview-session-evidence.json")
  assert.equal(review.evidence.runtimeReferenceManifest, "files/runtime-reference-manifest.json")
  assert.equal(review.evidence.previewEvidence, "files/preview-evidence.json")
  assert.equal(previewEvidence.schema, "wp-codebox/preview-evidence/v1")
  assert.equal(previewEvidence.session.kind, "browser-playground-session")
  assert.equal(previewEvidence.session.runtimeId, output.runtime.id)
  assert.equal(previewEvidence.session.backend, "wordpress-playground")
  assert.equal(previewEvidence.run.kind, "artifact-bundle")
  assert.equal(previewEvidence.run.id, artifacts.id)
  assert.equal(previewEvidence.run.path, "manifest.json")
  assert.equal(previewEvidence.run.digest.value, artifacts.contentDigest)
  assert.equal(previewEvidence.preview.url.availability, "reviewer-safe")
  assert.equal(previewEvidence.preview.url.url, "https://preview.example.test/codebox/")
  assert.equal(previewEvidence.preview.publicUrl.url, "https://preview.example.test/codebox/")
  assert.equal(previewEvidence.preview.localUrl.availability, "local-only")
  assert.equal(Object.hasOwn(previewEvidence.preview.localUrl, "url"), false)
  assert.equal(JSON.stringify(previewEvidence).includes("127.0.0.1"), false)
  assert.equal(previewEvidence.readiness.ready, true)
  assert.ok(previewEvidence.readiness.events.some((event: { phase: string; status: string }) => event.phase === "preview:ready" && event.status === "complete"))
  assert.deepEqual(previewEvidence.components.packages, metadata.provenance.packages)
  assert.equal(artifacts.previewSessionEvidenceRef.path, "files/preview-session-evidence.json")
  assert.match(artifacts.previewSessionEvidenceRef.sha256.value, /^[a-f0-9]{64}$/)
  assert.equal(metadata.previewSessionEvidence.path, "files/preview-session-evidence.json")
  assert.equal(metadata.previewSessionEvidence.sha256.value, artifacts.previewSessionEvidenceRef.sha256.value)
  assert.doesNotMatch(previewSessionEvidenceText, /localhost|127\.0\.0\.1|\/Users\/|\/private\/|\/tmp\//)
  assert.equal(previewSessionEvidence.schema, "wp-codebox/preview-session-evidence/v1")
  assert.equal(previewSessionEvidence.artifactId, artifacts.id)
  assert.equal(previewSessionEvidence.session.runtimeId, output.runtime.id)
  assert.equal(previewSessionEvidence.session.backend, "wordpress-playground")
  assert.equal(previewSessionEvidence.session.environment.version, "latest")
  assert.equal(previewSessionEvidence.preview.source, "public-url-override")
  assert.equal(previewSessionEvidence.preview.hasPublicUrl, true)
  assert.equal(previewSessionEvidence.preview.hasSiteUrl, true)
  assert.equal(previewSessionEvidence.refs.artifactBundle.id, artifacts.id)
  assert.equal(previewSessionEvidence.refs.manifest.path, "manifest.json")
  assert.equal(previewSessionEvidence.refs.review.path, "files/review.json")
  assert.equal(previewSessionEvidence.refs.runtimeEvents.path, "events.jsonl")
  assert.equal(previewSessionEvidence.refs.runtimeLog.path, "logs/runtime.log")
  assert.equal(previewSessionEvidence.refs.runtimeReferenceManifest.path, "files/runtime-reference-manifest.json")
  assert.equal(previewSessionEvidence.refs.runtimeReplayReferenceIndex.path, "files/runtime-replay-index.json")
  assert.equal(previewSessionEvidence.components.schema, packageProvenanceFixture.schema)
  assert.equal(runtimeReferenceIndex.schema, "wp-codebox/runtime-reference-index/v1")
  assert.equal(runtimeReferenceIndex.summary.references, runtimeReferenceIndex.references.length)
  assert.equal(runtimeReferenceIndex.summary.present, runtimeReferenceIndex.present.length)
  assert.equal(runtimeReferenceIndex.summary.missing, runtimeReferenceIndex.missing.length)
  assert.equal(runtimeReplayReferenceIndex.schema, RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA)
  const runtimeReplayManifestFile = manifestFile(manifest, "files/runtime-replay-index.json")
  assert.equal(runtimeReplayManifestFile.sha256.value, sha256(await readFile(join(artifacts.directory, "files/runtime-replay-index.json"))))
  assert.equal(runtimeReplayReferenceIndex.artifactBundle.id, artifacts.id)
  assert.equal(runtimeReplayReferenceIndex.artifactBundle.digest.value, artifacts.contentDigest)
  assert.equal(runtimeReplayReferenceIndex.digest.value, runtimeReplayReferenceIndexDigest(runtimeReplayReferenceIndex).value)
  assert.equal(runtimeReplayReferenceIndex.id, `runtime-replay-reference-index-sha256-${runtimeReplayReferenceIndex.digest.value}`)
  assert.equal(runtimeReplayReferenceIndex.references.runtimeReferenceManifest.path, "files/runtime-reference-manifest.json")
  assert.equal(runtimeReplayReferenceIndex.references.blueprintAfter.viewer.kind, "wordpress-playground-blueprint")
  assert.equal(runtimeReplayReferenceIndex.references.blueprintAfter.viewer.query.parameter, "blueprint-url")
  assert.equal(runtimeReplayReferenceIndex.references.blueprintAfter.viewer.query.value.source, "public-artifact-url")
  assert.equal(runtimeReplayReferenceIndex.references.blueprintAfter.viewer.query.value.path, "blueprint.after.json")
  assert.equal(runtimeReplayReferenceIndex.references.blueprintAfter.viewer.query.value.kind, "blueprint-after")
  assert.equal(runtimeReplayReferenceIndex.references.blueprintAfter.viewer.query.value.contentType, "application/json")
  assert.equal(runtimeReplayReferenceIndex.references.blueprintAfter.viewer.query.value.sha256.value, blueprintAfterManifestFile.sha256.value)
  assert.equal(runtimeReplayReferenceIndex.references.blueprintAfter.viewer.replay.status, "replayable-runtime-state")
  assert.equal(runtimeReplayReferenceIndex.references.changedFiles.path, "files/changed-files.json")
  assert.equal(runtimeReplayReferenceIndex.references.patch.path, "files/patch.diff")
  assert.equal(runtimeReplayReferenceIndex.replay.status, "runtime-state-artifact")
  assert.ok(runtimeReplayReferenceIndex.snapshots.length > 0)
  assert.equal(runtimeReferenceManifest.schema, RUNTIME_REFERENCE_MANIFEST_SCHEMA)
  const runtimeReferenceManifestFile = manifestFile(manifest, "files/runtime-reference-manifest.json")
  assert.equal(runtimeReferenceManifestFile.sha256.value, sha256(await readFile(join(artifacts.directory, "files/runtime-reference-manifest.json"))))
  assert.equal(runtimeReferenceManifest.artifactBundle.id, artifacts.id)
  assert.equal(runtimeReferenceManifest.artifactBundle.digest.value, artifacts.contentDigest)
  assert.equal(runtimeReferenceManifest.digest.value, runtimeReferenceManifestDigest(runtimeReferenceManifest).value)
  assert.equal(runtimeReferenceManifest.id, `runtime-reference-manifest-sha256-${runtimeReferenceManifest.digest.value}`)
  const runtimeReferenceManifestBlueprintViewer = runtimeReferenceManifest.files.find((file: { path: string }) => file.path === "blueprint.after.json")?.viewer
  assert.equal(runtimeReferenceManifestBlueprintViewer.kind, "wordpress-playground-blueprint")
  assert.equal(runtimeReferenceManifestBlueprintViewer.query.parameter, "blueprint-url")
  assert.equal(runtimeReferenceManifestBlueprintViewer.query.value.source, "public-artifact-url")
  assert.equal(runtimeReferenceManifestBlueprintViewer.query.value.path, "blueprint.after.json")
  assert.equal(runtimeReferenceManifestBlueprintViewer.query.value.kind, "blueprint-after")
  assert.equal(runtimeReferenceManifestBlueprintViewer.query.value.contentType, "application/json")
  assert.equal(runtimeReferenceManifestBlueprintViewer.query.value.sha256.value, blueprintAfterManifestFile.sha256.value)
  assert.equal(runtimeReferenceManifestBlueprintViewer.replay.status, "replayable-runtime-state")
  assert.ok(runtimeReferenceManifest.snapshots.length > 0)
  assert.ok(runtimeReferenceManifest.files.some((file: { path: string }) => file.path === "files/runtime-reference-index.json"))
  assert.ok(runtimeReferenceManifest.files.some((file: { path: string }) => file.path === "files/changed-files.json"))
  assert.ok(review.changedFiles.some((file: { path: string; status: string }) =>
    file.path === "/wordpress/wp-content/plugins/seeded-helper/generated.txt" && file.status === "added",
  ))
  assert.ok(review.actions.some((action: { kind: string; requiresApprovedFiles?: boolean }) => action.kind === "approve" && action.requiresApprovedFiles === true))
  assert.ok(review.actions.some((action: { kind: string }) => action.kind === "discard"))
  assert.ok(review.progress.some((event: { type: string; label: string }) => event.type === "complete" && event.label === "Ready for your review."))

  const reportedDiagnostics = buildArtifactDiagnostics([
    {
      id: "observation-fixture",
      type: "import-report",
      observedAt: "2026-01-01T00:00:00.000Z",
      data: {
        diagnostics: [
          {
            diagnostic_id: "layout-gap-1",
            type: "layout_fidelity_gap",
            severity: "warning",
            category: "transformation",
            message: "Generated artifact lost source grid structure.",
            path: "index.html",
            selector: ".hero",
            refs: [{ path: "files/import-report.json", kind: "import-report" }],
            source_report: { html: { element_count: 8 }, css: { selector_count: 4 } },
          },
        ],
      },
    },
  ])
  assert.equal(reportedDiagnostics.status, "reported")
  assert.equal(reportedDiagnostics.summary.warning, 1)
  assert.equal(reportedDiagnostics.diagnostics[0].id, "layout-gap-1")
  assert.equal(reportedDiagnostics.diagnostics[0].provenance?.observationType, "import-report")
  assert.equal(reportedDiagnostics.diagnostics[0].details?.source_report?.html?.element_count, 8)

  const { stdout: runStdout } = await execFileAsync(
    process.execPath,
    [
      "packages/cli/dist/index.js",
      "run",
      "--mount",
      "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
      "--command",
      "wordpress.run-php",
      "--arg",
      "code-file=./examples/simple-plugin/probe.php",
      "--artifacts",
      artifactsDirectory,
      "--preview-public-url",
      "https://run-preview.example.test/",
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024 * 10,
    },
  )
  const runOutput = JSON.parse(runStdout)
  assert.equal(runOutput.success, true)
  assert.equal(runOutput.runtime.status, "destroyed")
  assert.equal(runOutput.artifacts.preview.url, "https://run-preview.example.test/")
  assert.equal(runOutput.artifacts.preview.publicUrl, "https://run-preview.example.test/")
  assert.match(runOutput.artifacts.preview.localUrl, /^http:\/\/127\.0\.0\.1:/)
  const runPreviewEvidence = JSON.parse(await readFile(runOutput.artifacts.previewEvidencePath, "utf8"))
  assert.equal(runPreviewEvidence.preview.url.url, "https://run-preview.example.test/")
  assert.equal(runPreviewEvidence.preview.localUrl.availability, "local-only")
  assert.equal(JSON.stringify(runPreviewEvidence).includes("127.0.0.1"), false)

  const agentMount = join(artifactsDirectory, "agent-mounted-component")
  await mkdir(agentMount, { recursive: true })
  await writeFile(join(agentMount, "component.php"), "<?php // fixture\n")

  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      [
        "packages/cli/dist/index.js",
        "run",
        "--mount",
        `${agentMount}:/wordpress/wp-content/plugins/provenance-smoke`,
        "--command",
        "wordpress.phpunit",
        "--arg",
        "code=throw new Error('wp-codebox-canary-cli-fatal');",
        "--artifacts",
        artifactsDirectory,
        "--json",
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        maxBuffer: 1024 * 1024 * 10,
      },
    ),
    (error) => {
      const childError = error as { stdout?: string; stderr?: string }
      assert.match(childError.stdout ?? "", /wp-codebox-canary-cli-fatal/)
      assert.match(childError.stderr ?? "", /wp-codebox-canary-cli-fatal/)
      const output = JSON.parse(childError.stdout ?? "{}")
      assert.match(readFileSync(output.artifacts.commandsLogPath, "utf8"), /wp-codebox-canary-cli-fatal/)
      return true
    },
  )

  const runtime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "provenance-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.run-php", "wordpress.phpunit"],
        secrets: "none",
        approvals: "never",
      },
      artifactsDirectory,
      metadata: {
        runtime: { version: "0.0.0" },
        task: { kind: "agent-sandbox-run", input: "Cook provenance smoke" },
        agent: { agent: "sandbox-agent", provider: "openai", model: "gpt-5.5" },
      },
    },
    createPlaygroundRuntimeBackend(),
  )
  await runtime.mount({
    type: "directory",
    source: agentMount,
    target: "/wordpress/wp-content/plugins/provenance-smoke",
    mode: "readonly",
    metadata: { kind: "component", slug: "provenance-smoke" },
  })
  const agentArtifacts = await runtime.collectArtifacts({ includeLogs: true })
  const agentMetadata = JSON.parse(await readFile(agentArtifacts.metadataPath, "utf8"))
  const agentReview = JSON.parse(await readFile(agentArtifacts.reviewPath, "utf8"))
  const agentPreviewEvidence = JSON.parse(await readFile(agentArtifacts.previewEvidencePath ?? "", "utf8"))
  assert.equal(agentArtifacts.preview?.status, "expired-on-completion")
  assert.equal(agentReview.preview.status, "expired-on-completion")
  assert.equal(agentReview.preview.lifecycle, "destroyed-on-completion")
  assert.equal(agentReview.evidence.previewEvidence, "files/preview-evidence.json")
  assert.equal(agentPreviewEvidence.preview.url.availability, "local-only")
  assert.equal(Object.hasOwn(agentPreviewEvidence.preview.url, "url"), false)
  assert.equal(JSON.stringify(agentPreviewEvidence).includes("127.0.0.1"), false)
  assert.equal(agentMetadata.provenance.task.input, "Cook provenance smoke")
  assert.deepEqual(agentMetadata.provenance.agent, { agent: "sandbox-agent", provider: "openai", model: "gpt-5.5" })
  assert.equal(agentReview.provenance.agent.model, "gpt-5.5")
  assert.ok(agentReview.provenance.mounts.some((mount: { target: string; metadata?: { slug?: string } }) =>
    mount.target === "/wordpress/wp-content/plugins/provenance-smoke" && mount.metadata?.slug === "provenance-smoke",
  ))

  await assert.rejects(
    () => runtime.execute({
      command: "wordpress.phpunit",
      args: ["code=throw new Error('wp-codebox-canary-bootstrap-fatal');"],
    }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /wordpress\.phpunit (failed with exit code|crashed before producing a structured response)/)
      assert.match(error.message, /wp-codebox-canary-bootstrap-fatal/)
      assert.match(error.message, /Playground output|Playground errors|=== Stdout ===|=== Stderr ===/)
      return true
    },
  )
  await runtime.destroy()

  const secretName = "WP_CODEBOX_SMOKE_SECRET"
  const secretValue = "fixture-secret-value-64"
  const commonToken = "sk-fixtureSecretTokenForRedaction123456"
  const redactionBaseline = join(artifactsDirectory, "redaction-baseline")
  const redactionMount = join(artifactsDirectory, "redaction-mounted-component")
  await mkdir(redactionBaseline, { recursive: true })
  await mkdir(redactionMount, { recursive: true })
  await writeFile(join(redactionMount, "component.php"), "<?php // redaction fixture\n")
  const redactionRuntime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "redaction-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.run-php"],
        secrets: "connector-scoped",
        approvals: "never",
      },
      artifactsDirectory,
      secretEnv: { [secretName]: secretValue },
      metadata: {
        runtime: { version: "0.0.0" },
        task: {
          kind: "agent-sandbox-run",
          input: `Redact ${secretName}`,
          inheritance: {
            connectors: [
              {
                name: "primary-ai",
                status: "resolved",
                provider: "openai",
                model: "gpt-5.5",
                credentials: {
                  schema: "wp-codebox/connector-credentials/v1",
                  connector: "primary-ai",
                  scope: "connector",
                  status: "available",
                  secrets: [
                    { name: secretName, status: "available", scope: "primary-ai", source: "parent-env" },
                  ],
                },
              },
            ],
          },
        },
      },
    },
    createPlaygroundRuntimeBackend(),
  )
  await redactionRuntime.mount({
    type: "directory",
    source: redactionMount,
    target: "/wordpress/wp-content/plugins/redaction-smoke",
    mode: "readwrite",
    metadata: { kind: "component", slug: "redaction-smoke", baselineSource: redactionBaseline },
  })
  await redactionRuntime.execute({
    command: "wordpress.run-php",
    args: [
      `code=file_put_contents('/wordpress/wp-content/plugins/redaction-smoke/leak.txt', getenv('${secretName}') . "\\n${commonToken}\\n"); echo getenv('${secretName}') . " ${commonToken}";`,
    ],
  })
  const redactionArtifacts = await redactionRuntime.collectArtifacts({ includeLogs: true })
  const redactionMetadataText = await readFile(redactionArtifacts.metadataPath, "utf8")
  const redactionPatch = await readFile(redactionArtifacts.patchPath, "utf8")
  const redactionCommandsLog = await readFile(redactionArtifacts.commandsLogPath, "utf8")
  const redactionReview = JSON.parse(await readFile(redactionArtifacts.reviewPath, "utf8"))
  const redactionMountedFile = await readFile(join(redactionArtifacts.directory, "files/mounts/0/leak.txt"), "utf8")

  for (const [artifactName, artifactText] of Object.entries({
    metadata: redactionMetadataText,
    patch: redactionPatch,
    commandsLog: redactionCommandsLog,
    mountedFile: redactionMountedFile,
  })) {
    assert.equal(artifactText.includes(secretName), false, `${artifactName} should redact configured secret names`)
    assert.equal(artifactText.includes(secretValue), false, `${artifactName} should redact configured secret values`)
    assert.equal(artifactText.includes(commonToken), false, `${artifactName} should redact common token patterns`)
  }
  assert.match(redactionPatch, /\[REDACTED:configured-secret-value\]/)
  assert.match(redactionPatch, /\[REDACTED:openai-api-key\]/)
  assert.equal(redactionReview.redaction.status, "redacted")
  assert.ok(redactionReview.redaction.total >= 3)
  assert.ok(redactionReview.riskFlags.includes("secrets-redacted"))
  assert.equal(redactionReview.provenance.task.inheritance.connectors[0].credentials.schema, "wp-codebox/connector-credentials/v1")
  assert.equal(redactionReview.provenance.task.inheritance.connectors[0].credentials.status, "available")
  await redactionRuntime.destroy()

  console.log("Artifact contract smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}

function manifestFile(manifest: { files: Array<{ path: string; sha256: { value: string }; viewer?: any }> }, path: string): { sha256: { value: string }; viewer?: any } {
  const file = manifest.files.find((entry) => entry.path === path)
  assert.ok(file, `Expected manifest file ${path}`)
  return file
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}
