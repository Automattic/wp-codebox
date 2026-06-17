import assert from "node:assert/strict"
import { join } from "node:path"

import {
  ARTIFACT_MANIFEST_PATH,
  ArtifactBundleWriter,
  METADATA_ARTIFACT_PATH,
  REVIEW_ARTIFACT_PATH,
  RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH,
  RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH,
  artifactManifestFile,
  runtimeReferenceManifestArtifactFiles,
  runtimeReplayReferenceIndexArtifactFiles,
  type ArtifactManifest,
} from "@automattic/wp-codebox-core"
import { readJson, withTempDir } from "./test-kit.ts"

await withTempDir("wp-codebox-artifact-layout-", async (directory) => {
  const writer = new ArtifactBundleWriter(directory)
  await writer.writeJson("files/example.json", { ok: true }, { kind: "example" })

  const manifest: ArtifactManifest = {
    id: "artifact-bundle-sha256-test",
    contentDigest: {
      algorithm: "sha256",
      inputs: ["files/example.json"],
      value: "1".repeat(64),
    },
    createdAt: "2026-06-17T00:00:00.000Z",
    runtime: {
      id: "runtime-test",
      backend: "test",
      createdAt: "2026-06-17T00:00:00.000Z",
      environment: {},
    },
    files: [],
  }

  await writer.writeManifest(manifest)

  const written = await readJson<ArtifactManifest>(join(directory, ARTIFACT_MANIFEST_PATH))
  assert.deepEqual(written.files.map((file) => file.path), ["files/example.json", ARTIFACT_MANIFEST_PATH])
  assert.notEqual(written.files.find((file) => file.path === ARTIFACT_MANIFEST_PATH)?.sha256.value, "0".repeat(64))
  assert.equal(writer.relativePath(join(directory, "files", "example.json")), "files/example.json")

  const files = [
    artifactManifestFile(ARTIFACT_MANIFEST_PATH, "manifest", "application/json"),
    artifactManifestFile(METADATA_ARTIFACT_PATH, "metadata", "application/json"),
    artifactManifestFile(REVIEW_ARTIFACT_PATH, "review", "application/json"),
    artifactManifestFile(RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH, "runtime-reference-manifest", "application/json"),
    artifactManifestFile(RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH, "runtime-replay-index", "application/json"),
    artifactManifestFile("files/example.json", "example", "application/json"),
  ]

  assert.deepEqual(runtimeReferenceManifestArtifactFiles(files).map((file) => file.path), ["files/example.json"])
  assert.deepEqual(runtimeReplayReferenceIndexArtifactFiles(files).map((file) => file.path), [METADATA_ARTIFACT_PATH, REVIEW_ARTIFACT_PATH, RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH, "files/example.json"])
})

console.log("Artifact layout writer smoke passed")
