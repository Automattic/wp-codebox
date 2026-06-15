import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { discoverPartialRunArtifacts } from "@automattic/wp-codebox-core/artifacts"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-partial-artifacts-"))
const startedAt = "2026-06-06T12:00:00.000Z"
const finishedAt = "2026-06-06T12:00:10.000Z"

try {
  const successDirectory = await writeArtifactBundle("successful-session", {
    manifest: true,
    changedFiles: true,
    runtimeReferenceManifest: true,
    mtime: "2026-06-06T12:00:05.000Z",
  })
  const timeoutDirectory = await writeArtifactBundle("sandbox-705-timeout-partial", {
    manifest: false,
    changedFiles: true,
    runtimeReferenceManifest: true,
    mtime: "2026-06-06T12:00:06.000Z",
  })
  await writeArtifactBundle("outside-window", {
    manifest: true,
    changedFiles: true,
    runtimeReferenceManifest: false,
    mtime: "2026-06-06T12:01:00.000Z",
  })

  const timestampDiscovery = await discoverPartialRunArtifacts({ artifactsRoot: root, startedAt, finishedAt })
  assert.equal(timestampDiscovery.schema, "wp-codebox/partial-artifact-discovery/v1")
  assert.equal(timestampDiscovery.selectedBy, "time-window")
  assert.equal(timestampDiscovery.artifacts.length, 2)
  assert.ok(timestampDiscovery.artifacts.some((artifact) => artifact.directory === successDirectory && artifact.hasManifest))
  const timeoutArtifact = timestampDiscovery.artifacts.find((artifact) => artifact.directory === timeoutDirectory)
  assert.ok(timeoutArtifact, "timeout partial artifact should be discovered")
  assert.equal(timeoutArtifact.hasManifest, false)
  assert.equal(timeoutArtifact.hasChangedFiles, true)
  assert.equal(timeoutArtifact.hasRuntimeReferenceManifest, true)
  assert.equal((timeoutArtifact.runtimeReferenceManifest.payload as { cookie?: string }).cookie, "[redacted]")

  const sessionDiscovery = await discoverPartialRunArtifacts({ artifactsRoot: root, sessionId: "sandbox-705", startedAt, finishedAt })
  assert.equal(sessionDiscovery.selectedBy, "session-id")
  assert.deepEqual(sessionDiscovery.artifacts.map((artifact) => artifact.directory), [timeoutDirectory])

  const fallbackDiscovery = await discoverPartialRunArtifacts({ artifactsRoot: root, sessionId: "missing-session", startedAt, finishedAt })
  assert.equal(fallbackDiscovery.selectedBy, "time-window")
  assert.equal(fallbackDiscovery.artifacts.length, 2)

  const { stdout } = await execFileAsync(process.execPath, [
    "packages/cli/dist/index.js",
    "artifacts",
    "discover-partial",
    "--artifacts",
    root,
    "--session-id",
    "sandbox-705",
    "--started-at",
    startedAt,
    "--finished-at",
    finishedAt,
    "--json",
  ], { cwd: resolve(import.meta.dirname, "..") })
  const cliOutput = JSON.parse(stdout)
  assert.equal(cliOutput.schema, "wp-codebox/partial-artifact-discovery/v1")
  assert.equal(cliOutput.selectedBy, "session-id")
  assert.equal(cliOutput.artifacts.length, 1)
  assert.equal(cliOutput.artifacts[0].hasChangedFiles, true)
} finally {
  await rm(root, { recursive: true, force: true })
}

async function writeArtifactBundle(name: string, options: { manifest: boolean; changedFiles: boolean; runtimeReferenceManifest: boolean; mtime: string }): Promise<string> {
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
    await writeFile(runtimeManifestPath, `${JSON.stringify({ schema: "wp-codebox/runtime-reference-manifest/v1", cookie: "wordpress_logged_in=secret" }, null, 2)}\n`)
    manifestFiles.push({ path: "files/runtime-reference-manifest.json", kind: "runtime-reference-manifest", contentType: "application/json", sha256: { algorithm: "sha256", value: "1".repeat(64) } })
  }
  if (options.manifest) {
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
      id: `artifact-${name}`,
      contentDigest: { algorithm: "sha256", inputs: [], value: "2".repeat(64) },
      createdAt: options.mtime,
      runtime: { backend: "wordpress-playground", version: "0.0.0" },
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
