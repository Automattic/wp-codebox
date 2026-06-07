import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { discoverInterruptedRunEvidence } from "@automattic/wp-codebox-core"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-interrupted-run-evidence-"))
const startedAt = "2026-06-06T12:00:00.000Z"
const finishedAt = "2026-06-06T12:00:10.000Z"

try {
  const directDirectory = await writeArtifactBundle("sandbox-723-timeout", {
    manifest: false,
    changedFiles: true,
    runtimeReferenceManifest: true,
    runtimeId: "runtime-timeout-723",
    lastKnownPhase: "collect_artifacts",
    lastHeartbeat: "2026-06-06T12:00:06.000Z",
    mtime: "2026-06-06T12:00:06.000Z",
  })
  const nestedDirectory = await writeArtifactBundle("nested/sandbox-723-interrupted", {
    manifest: true,
    changedFiles: true,
    runtimeReferenceManifest: true,
    runtimeId: "runtime-interrupted-723",
    lastKnownPhase: "run_workloads",
    lastHeartbeat: "2026-06-06T12:00:08.000Z",
    mtime: "2026-06-06T12:00:08.000Z",
  })
  await writeArtifactBundle("outside-window", {
    manifest: true,
    changedFiles: true,
    runtimeReferenceManifest: true,
    runtimeId: "runtime-outside-window",
    lastKnownPhase: "ignored",
    lastHeartbeat: "2026-06-06T12:01:00.000Z",
    mtime: "2026-06-06T12:01:00.000Z",
  })

  const defaultDepthEvidence = await discoverInterruptedRunEvidence({ artifactsRoot: root, startedAt, finishedAt })
  assert.equal(defaultDepthEvidence.schema, "wp-codebox/interrupted-run-evidence/v1")
  assert.deepEqual(defaultDepthEvidence.artifacts.map((artifact) => artifact.directory), [directDirectory])
  assert.equal(defaultDepthEvidence.runtime_id, "runtime-timeout-723")
  assert.equal(defaultDepthEvidence.last_known_phase, "collect_artifacts")
  assert.equal(defaultDepthEvidence.last_heartbeat, "2026-06-06T12:00:06.000Z")
  assert.equal(defaultDepthEvidence.artifact_ref_count, 2)
  assert.deepEqual(defaultDepthEvidence.evidence_refs.map((ref) => ref.kind).sort(), ["changed-files", "runtime-reference-manifest"])

  const nestedEvidence = await discoverInterruptedRunEvidence({ artifactsRoot: root, sessionId: "sandbox-723-interrupted", startedAt, finishedAt, maxDepth: 2 })
  assert.deepEqual(nestedEvidence.artifacts.map((artifact) => artifact.directory), [nestedDirectory])
  assert.equal(nestedEvidence.runtime_id, "runtime-interrupted-723")
  assert.equal(nestedEvidence.last_known_phase, "run_workloads")
  assert.equal(nestedEvidence.last_heartbeat, "2026-06-06T12:00:08.000Z")
  assert.equal(nestedEvidence.artifact_ref_count, 3)
  assert.ok(nestedEvidence.evidence_refs.every((ref) => ref.artifact_id === "artifact-nested-sandbox-723-interrupted"))
  assert.ok(nestedEvidence.evidence_refs.every((ref) => ref.sha256?.algorithm === "sha256"))

  const fallbackEvidence = await discoverInterruptedRunEvidence({ artifactsRoot: root, sessionId: "missing-session", startedAt, finishedAt, maxDepth: 2 })
  assert.equal(fallbackEvidence.artifacts.length, 2)
  assert.equal(fallbackEvidence.runtime_id, "runtime-interrupted-723")
  assert.equal(fallbackEvidence.last_heartbeat, "2026-06-06T12:00:08.000Z")

  console.log("interrupted run evidence smoke passed")
} finally {
  await rm(root, { recursive: true, force: true })
}

async function writeArtifactBundle(name: string, options: { manifest: boolean; changedFiles: boolean; runtimeReferenceManifest: boolean; runtimeId: string; lastKnownPhase: string; lastHeartbeat: string; mtime: string }): Promise<string> {
  const directory = join(root, name)
  const files = join(directory, "files")
  await mkdir(files, { recursive: true })
  const manifestFiles = []
  if (options.changedFiles) {
    const changedFilesPath = join(files, "changed-files.json")
    await writeFile(changedFilesPath, `${JSON.stringify({ schema: "wp-codebox/changed-files/v1", files: [] }, null, 2)}\n`)
    manifestFiles.push({ path: "files/changed-files.json", kind: "changed-files", contentType: "application/json", sha256: { algorithm: "sha256", value: "0".repeat(64) } })
  }
  if (options.runtimeReferenceManifest) {
    const runtimeManifestPath = join(files, "runtime-reference-manifest.json")
    await writeFile(runtimeManifestPath, `${JSON.stringify({
      schema: "wp-codebox/runtime-reference-manifest/v1",
      runtime: { id: options.runtimeId, backend: "wordpress-playground", environment: { kind: "wordpress" }, createdAt: startedAt, status: "created" },
      lastKnownPhase: options.lastKnownPhase,
      heartbeatAt: options.lastHeartbeat,
    }, null, 2)}\n`)
    manifestFiles.push({ path: "files/runtime-reference-manifest.json", kind: "runtime-reference-manifest", contentType: "application/json", sha256: { algorithm: "sha256", value: "1".repeat(64) } })
  }
  if (options.manifest) {
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
      id: `artifact-${name.replace(/\//g, "-")}`,
      contentDigest: { algorithm: "sha256", inputs: [], value: "2".repeat(64) },
      createdAt: options.mtime,
      runtime: { id: options.runtimeId, backend: "wordpress-playground", environment: { kind: "wordpress" }, createdAt: startedAt, status: "created" },
      files: [
        { path: "manifest.json", kind: "manifest", contentType: "application/json", sha256: { algorithm: "sha256", value: "3".repeat(64) } },
        ...manifestFiles,
      ],
    }, null, 2)}\n`)
  }
  const mtime = new Date(options.mtime)
  await utimes(directory, mtime, mtime)
  return directory
}
