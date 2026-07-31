import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { artifactFileDigest, type ArtifactManifest, type RuntimeReplayReferenceIndex, type RuntimeReferenceManifest, type Snapshot } from "../packages/runtime-core/src/public.js"
import { verifyArtifactBundle } from "../packages/runtime-core/src/artifact-bundle-verifier.js"
import { ArtifactBundleBuilder } from "../packages/runtime-playground/src/artifact-bundle-builder.js"
import { captureMountedFiles, captureMountDiffs } from "../packages/runtime-playground/src/mounted-artifact-capture.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-snapshot-lifecycle-"))
const artifactRoot = join(root, "artifacts")
const snapshotPath = "files/runtime-snapshots/snapshot-checkpoint.json"
const snapshotContent = `${JSON.stringify({ schema: "wp-codebox/wordpress-runtime-snapshot/v1", id: "snapshot-checkpoint" }, null, 2)}\n`
const snapshotDigest = artifactFileDigest(snapshotContent)
const snapshot: Snapshot = {
  schema: "wp-codebox/runtime-episode-snapshot/v1",
  id: "snapshot-checkpoint",
  createdAt: "2026-01-01T00:00:00.000Z",
  semantics: "runtime-state-artifact",
  metadata: {},
  artifactRefs: [{ kind: "runtime-snapshot-artifact", id: "snapshot-checkpoint", path: snapshotPath, digest: snapshotDigest }],
}

try {
  await mkdir(join(artifactRoot, "files/runtime-snapshots"), { recursive: true })
  await writeFile(join(artifactRoot, snapshotPath), snapshotContent)

  await new ArtifactBundleBuilder({
    artifactRoot,
    runtimeId: "runtime-snapshot-lifecycle",
    runtimeCreatedAt: "2026-01-01T00:00:00.000Z",
    spec: { environment: { blueprint: {} } },
    mounts: [],
    commands: [],
    observations: [],
    snapshots: [snapshot],
    events: [],
    info: async () => ({ id: "runtime-snapshot-lifecycle", backend: "wordpress-playground", status: "ready", createdAt: "2026-01-01T00:00:00.000Z", environment: { kind: "wordpress" } }),
    previewInfo: async () => undefined,
    browserReviewSummary: () => undefined,
    browserArtifacts: () => [],
    captureMountedFiles: (filesDirectory, redactor) => captureMountedFiles(filesDirectory, [], redactor),
    captureMountDiffs: (filesDirectory, redactor) => captureMountDiffs(artifactRoot, filesDirectory, [], redactor),
    redactBrowserArtifacts: async () => {},
    redactPluginCheckArtifacts: async () => {},
    redactThemeCheckArtifacts: async () => {},
    browserManifestFiles: () => [],
    pluginCheckArtifactPaths: () => [],
    themeCheckArtifactPaths: () => [],
    observationManifestFiles: () => [],
    pluginCheckManifestFiles: () => [],
    themeCheckManifestFiles: () => [],
    formatRuntimeLog: () => "",
    formatCommandsLog: () => "",
    recordArtifactsCollected: () => {},
  } as any).build()

  const manifest = JSON.parse(await readFile(join(artifactRoot, "manifest.json"), "utf8")) as ArtifactManifest
  const snapshotFile = manifest.files.find((file) => file.path === snapshotPath)
  assert.equal(snapshotFile?.kind, "runtime-snapshot-artifact")
  assert.equal(snapshotFile?.contentType, "application/json")
  assert.deepEqual(snapshotFile?.sha256, snapshotDigest)
  assert.equal((await verifyArtifactBundle(artifactRoot)).valid, true)

  const runtimeReferences = JSON.parse(await readFile(join(artifactRoot, "files/runtime-reference-manifest.json"), "utf8")) as RuntimeReferenceManifest
  const replayReferences = JSON.parse(await readFile(join(artifactRoot, "files/runtime-replay-index.json"), "utf8")) as RuntimeReplayReferenceIndex
  assert.deepEqual(runtimeReferences.snapshots[0]?.artifactRefs[0], { kind: "runtime-snapshot-artifact", id: "snapshot-checkpoint", path: snapshotPath, digest: snapshotDigest })
  assert.deepEqual(replayReferences.snapshots[0]?.artifactRefs[0], { kind: "runtime-snapshot-artifact", id: "snapshot-checkpoint", path: snapshotPath, digest: snapshotDigest })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("runtime snapshot artifact lifecycle ok")
