import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { RuntimeRunRegistry, artifactBundleRunRef } from "../packages/runtime-core/src/run-registry.js"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-run-registry-"))

try {
  const registryDirectory = join(workspace, "runs")
  const registry = new RuntimeRunRegistry(registryDirectory)
  const run = await registry.create({
    runId: "run_smoke",
    status: "queued",
    metadata: {
      kind: "smoke",
      secretEnv: { OPENAI_API_KEY: "should-not-persist" },
      nested: { token: "should-not-persist" },
    },
    replay: { command: ["wp-codebox", "recipe-run", "--recipe", "recipe.json"] },
  })

  assert.equal(run.schema, "wp-codebox/run-registry-entry/v1")
  assert.equal(run.status, "queued")
  assert.equal(run.metadata?.secretEnv, "[redacted]")
  assert.equal((run.metadata?.nested as { token?: string }).token, "[redacted]")

  const artifactDirectory = join(workspace, "artifact-bundle")
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(join(artifactDirectory, "manifest.json"), "{}\n")

  const updated = await registry.update(run.runId, {
    status: "succeeded",
    artifactRefs: artifactBundleRunRef({
      id: "artifact-smoke",
      directory: artifactDirectory,
      manifestPath: join(artifactDirectory, "manifest.json"),
      contentDigest: "a".repeat(64),
    } as any),
    now: new Date("2026-01-01T00:00:01.000Z"),
  })
  assert.equal(updated.status, "succeeded")
  assert.equal(updated.artifactRefs[0]?.kind, "artifact-bundle")
  assert.equal(updated.artifactRefs[0]?.digest?.value, "a".repeat(64))
  assert.equal(updated.heartbeatAt, "2026-01-01T00:00:01.000Z")

  const persisted = JSON.parse(await readFile(join(registryDirectory, "run_smoke.json"), "utf8"))
  assert.equal(persisted.status, "succeeded")

  const { stdout: statusStdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "runs", "status", "--registry", registryDirectory, "--run-id", run.runId, "--json"], { cwd: root })
  const status = JSON.parse(statusStdout)
  assert.equal(status.runId, run.runId)
  assert.equal(status.status, "succeeded")

  const { stdout: artifactsStdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "runs", "artifacts", "--registry", registryDirectory, "--run-id", run.runId, "--json"], { cwd: root })
  const artifacts = JSON.parse(artifactsStdout)
  assert.equal(artifacts.schema, "wp-codebox/run-artifacts/v1")
  assert.equal(artifacts.artifactRefs[0].id, "artifact-smoke")

  console.log("Run registry smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}
