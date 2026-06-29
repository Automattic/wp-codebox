import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { DELETE_BOUNDARY_ARTIFACT_KIND, SANDBOX_ISOLATION_PROOF_ARTIFACT_KIND, sandboxIsolationProof, fuzzFixturePlanContract, fuzzSuiteContract, mutationFixtureSeedOperation, restMutationFixtureOptInContract, type RuntimeEpisodeStepResult, type Snapshot } from "../packages/runtime-core/src/public.js"
import {
  createWordPressFuzzSuiteResetExecutor,
  createWordPressRuntimeCheckpoint,
  executeWordPressFuzzSuite,
  inventoryWordPressDatabase,
  listWordPressRuntimeCheckpoints,
  observeWordPressRestPerformance,
  restoreWordPressRuntimeCheckpoint,
} from "../packages/runtime-playground/src/public.js"

const steps: Array<{ command: string; args?: string[]; timeoutMs?: number; observation?: unknown }> = []
let rollbackCaptureIndex = 0
const episode = {
  async reset() {
    return {
      id: "reset-1",
      runtime: { id: "runtime-1", backend: "wordpress-playground", status: "ready", createdAt: "2026-01-01T00:00:00.000Z", environment: { kind: "wordpress" } },
      observations: [],
      observationRefs: [],
    }
  },
  async step(action: { command: string; args?: string[]; timeoutMs?: number }, observation?: unknown): Promise<RuntimeEpisodeStepResult> {
    steps.push({ command: action.command, args: action.args, timeoutMs: action.timeoutMs, observation })
    const index = steps.length
    const method = action.args?.find((arg) => arg.startsWith("method="))?.slice("method=".length)
    const path = action.args?.find((arg) => arg.startsWith("path="))?.slice("path=".length)
    const stdout = action.command === "wordpress.rest-request" && method === "DELETE"
      ? JSON.stringify({ method, path, route: path, status: 200, body: { deleted: true, previous: { id: 123 } } })
      : action.command === "wordpress.run-php"
        ? JSON.stringify(rollbackCapture(++rollbackCaptureIndex))
        : JSON.stringify({ ok: true })
    return {
      id: `step-${index}`,
      index,
      action: {
        schema: "wp-codebox/runtime-episode-action/v1",
        id: `action-${index}`,
        kind: "command",
        command: action.command,
        args: action.args ?? [],
        digest: { algorithm: "sha256", value: `action-${index}` },
      },
      actionRef: { kind: "action", id: `action-${index}` },
      execution: {
        id: `execution-${index}`,
        command: action.command,
        args: action.args ?? [],
        exitCode: 0,
        stdout,
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      executionRef: { kind: "execution", id: `execution-${index}` },
    }
  },
}

function rollbackCapture(index: number): Record<string, unknown> {
  const phase = index % 3 === 2 ? "after" : index % 3 === 0 ? "restore" : "before"
  return {
    schema: "wp-codebox/wordpress-rollback-capture/v1",
    phase,
    target: "/wp/v2/posts/123",
    options: {},
    tables: {},
    objects: {
      "post:123": phase === "after"
        ? { exists: false, post: null }
        : { exists: true, post: { ID: 123, post_type: "post", post_title: "Baseline" } },
    },
    diagnostics: [],
  }
}
const restoredSnapshotRefs: string[] = []
const restoredExternalSnapshotRefs: string[] = []
const episodeWithSnapshotRestore = {
  ...episode,
  async restoreSnapshot(snapshotRef: Snapshot | string): Promise<Snapshot> {
    if (typeof snapshotRef !== "string") {
      assert.equal(snapshotRef.metadata.artifactRef, "artifact:baseline/files/runtime-snapshot.json")
      restoredExternalSnapshotRefs.push(String(snapshotRef.metadata.artifactRef))
      return snapshotRef
    }
    restoredSnapshotRefs.push(snapshotRef)
    return {
      schema: "wp-codebox/runtime-episode-snapshot/v1",
      id: snapshotRef,
      createdAt: "2026-01-01T00:00:00.000Z",
      semantics: "runtime-state-artifact",
      metadata: { runtime: { backend: "wordpress-playground" } },
      artifactRefs: [{ kind: "runtime-snapshot-artifact", id: snapshotRef, path: `files/runtime-snapshots/${snapshotRef}.json`, digest: { algorithm: "sha256", value: "snapshot-sha" } }],
    }
  },
}

const externalSnapshotBundleDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-fuzz-snapshot-"))
await mkdir(join(externalSnapshotBundleDirectory, "files"), { recursive: true })
const externalSnapshotPayload = `${JSON.stringify({
  schema: "wp-codebox/wordpress-runtime-snapshot/v1",
  version: 1,
  id: "external-baseline",
  createdAt: "2026-01-01T00:00:00.000Z",
  compatibility: { backend: "wordpress-playground", wordpressVersion: "6.8", phpVersion: "8.2" },
  metadata: { runtime: { id: "runtime-1", backend: "wordpress-playground", status: "ready", createdAt: "2026-01-01T00:00:00.000Z", environment: { kind: "wordpress" } }, mounts: [], mountedInputs: [], activeTheme: "", activePlugins: [], wpContentPath: "wp-content" },
  database: { tables: [] },
  files: [],
  hashes: { database: { algorithm: "sha256", value: "database-sha" }, files: { algorithm: "sha256", value: "files-sha" } },
}, null, 2)}\n`
const externalSnapshotSha256 = createHash("sha256").update(externalSnapshotPayload).digest("hex")
await writeFile(join(externalSnapshotBundleDirectory, "files", "runtime-snapshot.json"), externalSnapshotPayload)
await writeFile(join(externalSnapshotBundleDirectory, "manifest.json"), `${JSON.stringify({
  id: "baseline",
  contentDigest: { algorithm: "sha256", inputs: ["files/runtime-snapshot.json"], value: externalSnapshotSha256 },
  createdAt: "2026-01-01T00:00:00.000Z",
  runtime: { id: "runtime-1", backend: "wordpress-playground", status: "ready", createdAt: "2026-01-01T00:00:00.000Z", environment: { kind: "wordpress" } },
  files: [{ path: "files/runtime-snapshot.json", kind: "runtime-snapshot-artifact", contentType: "application/json", sha256: { algorithm: "sha256", value: externalSnapshotSha256 } }],
}, null, 2)}\n`)

await observeWordPressRestPerformance(episode, {
  method: "POST",
  path: "/wp/v2/posts",
  params: { per_page: 1 },
  user: "admin",
  queryFingerprintLimit: 12,
  queryLengthLimit: 300,
  hookSampleLimit: 8,
  hookLimit: 100,
  timeoutMs: 5000,
})
assert.deepEqual(steps.at(-1), {
  command: "wordpress.rest-performance-observation",
  args: ["method=POST", "path=/wp/v2/posts", "params-json={\"per_page\":1}", "user=admin", "query-fingerprint-limit=12", "query-length-limit=300", "hook-sample-limit=8", "hook-limit=100"],
  timeoutMs: 5000,
  observation: { type: "command-result" },
})

await createWordPressRuntimeCheckpoint(episode, {
  name: "baseline",
  metadata: { suiteId: "suite-1" },
  snapshotDatabaseTables: ["posts", "postmeta"],
  snapshotPostTypes: ["post", "page"],
})
assert.deepEqual(steps.at(-1)?.command, "wp-codebox.checkpoint-create")
assert.deepEqual(steps.at(-1)?.args, ["name=baseline", "metadata-json={\"suiteId\":\"suite-1\"}", "snapshot-database-tables=posts,postmeta", "snapshot-post-types=post,page"])

await listWordPressRuntimeCheckpoints(episode)
assert.equal(steps.at(-1)?.command, "wp-codebox.checkpoint-list")
assert.deepEqual(steps.at(-1)?.args, [])

await restoreWordPressRuntimeCheckpoint(episode, "baseline")
assert.equal(steps.at(-1)?.command, "wp-codebox.checkpoint-restore")
assert.deepEqual(steps.at(-1)?.args, ["name=baseline"])

await inventoryWordPressDatabase(episode)
assert.equal(steps.at(-1)?.command, "wordpress.inventory-database")

const resetExecutor = createWordPressFuzzSuiteResetExecutor(episode)
const resetResult = await resetExecutor.resetFuzzSuiteCase({
  suite: fuzzSuiteContract({ id: "snapshot-suite", cases: [{ id: "case-one" }] }),
  case: { id: "case-one" },
  caseIndex: 0,
  policy: { mode: "restore-snapshot", snapshotRef: "artifact:baseline/files/runtime-snapshot.json" },
})
assert.equal(resetResult.status, "unsupported")
assert.equal(resetResult.snapshotRef, "artifact:baseline/files/runtime-snapshot.json")
assert.equal(resetResult.diagnostics?.[0]?.code, "fuzz_suite_snapshot_ref_unsupported")
assert.deepEqual(resetResult.diagnostics?.[0]?.metadata, { snapshotRef: "artifact:baseline/files/runtime-snapshot.json", supportedSnapshotRef: "same-runtime snapshot id or artifact:<bundle-id>/files/...", unsupportedReason: "trusted-artifact-bundle-unavailable", bundleId: "baseline", artifactPath: "files/runtime-snapshot.json" })
assert.deepEqual(resetResult.metadata, { resetPerformed: false, restorePerformed: false, supportedSnapshotRef: "same-runtime snapshot id or artifact:<bundle-id>/files/...", unsupportedReason: "trusted-artifact-bundle-unavailable", bundleId: "baseline", artifactPath: "files/runtime-snapshot.json" })

const suiteResult = await executeWordPressFuzzSuite(episode, fuzzSuiteContract({
  id: "snapshot-suite-run",
  resetPolicy: { mode: "restore-snapshot", snapshotRef: "artifact:baseline/files/runtime-snapshot.json" },
  cases: [{ id: "case-one", target: { kind: "command", id: "wordpress.rest-performance-observation" }, input: { command: "wordpress.rest-performance-observation", args: ["path=/wp/v2/types"] } }],
}))
assert.equal(suiteResult.status, "error")
assert.equal(suiteResult.cases[0]?.reset?.status, "unsupported")

const unsupportedExternalSnapshot = await createWordPressFuzzSuiteResetExecutor(episodeWithSnapshotRestore).resetFuzzSuiteCase({
  suite: fuzzSuiteContract({ id: "external-snapshot-suite", cases: [{ id: "case-one" }] }),
  case: { id: "case-one" },
  caseIndex: 0,
  policy: { mode: "restore-snapshot", snapshotRef: "artifact:baseline/files/runtime-snapshot.json" },
})
assert.equal(unsupportedExternalSnapshot.status, "unsupported")
assert.equal(unsupportedExternalSnapshot.diagnostics?.[0]?.code, "fuzz_suite_snapshot_ref_unsupported")
assert.deepEqual(unsupportedExternalSnapshot.metadata, { resetPerformed: false, restorePerformed: false, supportedSnapshotRef: "same-runtime snapshot id or artifact:<bundle-id>/files/...", unsupportedReason: "trusted-artifact-bundle-unavailable", bundleId: "baseline", artifactPath: "files/runtime-snapshot.json" })

const unsupportedRemoteSnapshot = await createWordPressFuzzSuiteResetExecutor(episodeWithSnapshotRestore, { artifactBundles: [{ id: "baseline", directory: externalSnapshotBundleDirectory }] }).resetFuzzSuiteCase({
  suite: fuzzSuiteContract({ id: "remote-snapshot-suite", cases: [{ id: "case-one" }] }),
  case: { id: "case-one" },
  caseIndex: 0,
  policy: { mode: "restore-snapshot", snapshotRef: "https://example.com/runtime-snapshot.json" },
})
assert.equal(unsupportedRemoteSnapshot.status, "unsupported")
assert.equal(unsupportedRemoteSnapshot.diagnostics?.[0]?.metadata?.unsupportedReason, "remote-snapshot-ref-unsupported")

const supportedExternalSnapshot = await createWordPressFuzzSuiteResetExecutor(episodeWithSnapshotRestore, { artifactBundles: [{ id: "baseline", directory: externalSnapshotBundleDirectory }] }).resetFuzzSuiteCase({
  suite: fuzzSuiteContract({ id: "external-snapshot-suite", cases: [{ id: "case-one" }] }),
  case: { id: "case-one" },
  caseIndex: 0,
  policy: { mode: "restore-snapshot", snapshotRef: "artifact:baseline/files/runtime-snapshot.json" },
})
assert.equal(supportedExternalSnapshot.status, "passed")
assert.equal(supportedExternalSnapshot.snapshotRef, "artifact:baseline/files/runtime-snapshot.json")
assert.equal(supportedExternalSnapshot.artifactRefs?.[0]?.sha256, externalSnapshotSha256)
assert.deepEqual(restoredExternalSnapshotRefs, ["artifact:baseline/files/runtime-snapshot.json"])

const externalSnapshotSuiteResult = await executeWordPressFuzzSuite(episodeWithSnapshotRestore, fuzzSuiteContract({
  id: "external-snapshot-suite-run",
  resetPolicy: { mode: "restore-snapshot", snapshotRef: "artifact:baseline/files/runtime-snapshot.json" },
  cases: [{ id: "case-one", target: { kind: "command", id: "wordpress.rest-performance-observation" }, input: { command: "wordpress.rest-performance-observation", args: ["path=/wp/v2/types"] } }],
}), { artifactBundles: [{ id: "baseline", directory: externalSnapshotBundleDirectory }] })
assert.equal(externalSnapshotSuiteResult.status, "passed")
assert.equal(externalSnapshotSuiteResult.cases[0]?.reset?.status, "passed")
assert.equal(externalSnapshotSuiteResult.cases[0]?.reset?.artifactRefs?.[0]?.sha256, externalSnapshotSha256)
assert.deepEqual(restoredExternalSnapshotRefs, ["artifact:baseline/files/runtime-snapshot.json", "artifact:baseline/files/runtime-snapshot.json"])

const snapshotRestoreResult = await executeWordPressFuzzSuite(episodeWithSnapshotRestore, fuzzSuiteContract({
  id: "same-runtime-snapshot-suite-run",
  resetPolicy: { mode: "restore-snapshot", snapshotRef: "snapshot-baseline" },
  cases: [{ id: "destructive-rest", target: { kind: "rest", id: "/wp/v2/posts/123" }, input: { method: "DELETE", bodyJson: { force: true } }, mutation: { intent: "delete", destructive: true, intensity: "high", resetRequired: true } }],
}))
assert.equal(snapshotRestoreResult.status, "passed")
assert.equal(snapshotRestoreResult.cases[0]?.reset?.status, "passed")
assert.equal(snapshotRestoreResult.cases[0]?.reset?.snapshotRef, "snapshot-baseline")
assert.equal(snapshotRestoreResult.cases[0]?.reset?.artifactRefs?.[0]?.path, "files/runtime-snapshots/snapshot-baseline.json")
assert.deepEqual(restoredSnapshotRefs, ["snapshot-baseline"])
assert.equal((snapshotRestoreResult.cases[0]?.metadata?.adapter as Record<string, unknown> | undefined)?.resetPolicyAllowsMutation, true)

const beforeMutationStepCount = steps.length
const deleteOptIn = restMutationFixtureOptInContract({
  id: "delete-post-boundary",
  route: "/wp/v2/posts/123",
  methods: ["DELETE"],
  auth: { user: "fixture-user" },
  rollbackPolicy: { mode: "checkpoint-per-case", checkpointName: "delete-post-boundary" },
  fixturePlan: fuzzFixturePlanContract({
    id: "delete-post-boundary-plan",
    operations: [mutationFixtureSeedOperation({ id: "delete-post", method: "DELETE", target: "/wp/v2/posts/123", input: { body: { force: false } } })],
  }),
})
const mutationResult = await executeWordPressFuzzSuite(episode, fuzzSuiteContract({
  id: "mutation-suite-run",
  cases: [{ id: "delete-post", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/123", restMutationFixtureOptIn: deleteOptIn } }],
}))
assert.equal(mutationResult.status, "passed")
assert.deepEqual(steps.slice(beforeMutationStepCount).map((step) => step.command), ["wp-codebox.checkpoint-create", "wordpress.run-php", "wordpress.rest-request", "wordpress.run-php", "wp-codebox.checkpoint-restore", "wordpress.run-php"])
const deleteBoundary = mutationResult.cases[0]?.metadata?.deleteBoundary as Record<string, unknown> | undefined
assert.equal(mutationResult.cases[0]?.metadata?.mutationIsolation, undefined)
assert.equal(deleteBoundary?.schema, "wp-codebox/delete-boundary-artifact/v1")
assert.equal(deleteBoundary?.method, "DELETE")
assert.equal(deleteBoundary?.target, "/wp/v2/posts/123")
assert.equal(deleteBoundary?.status, 200)
assert.equal(deleteBoundary?.artifactKind, DELETE_BOUNDARY_ARTIFACT_KIND)
assert.equal(deleteBoundary?.artifactPath, "files/delete-boundaries/delete-post.json")
assert.equal(deleteBoundary?.persisted, false)
assert.equal((deleteBoundary?.restore as Record<string, unknown> | undefined)?.status, "passed")
assert.equal((deleteBoundary?.restore as Record<string, unknown> | undefined)?.command, "wp-codebox.checkpoint-restore")
const rollback = deleteBoundary?.rollback as Record<string, unknown> | undefined
const proof = sandboxIsolationProof({
  status: rollback?.result && (rollback.result as Record<string, unknown>).status === "passed" ? "passed" : "failed",
  baseline: { status: "created", command: (deleteBoundary.beforeCheckpoint as Record<string, unknown>).command as string, stepId: (deleteBoundary.beforeCheckpoint as Record<string, unknown>).stepId as string, executionId: (deleteBoundary.beforeCheckpoint as Record<string, unknown>).executionId as string, exitCode: (deleteBoundary.beforeCheckpoint as Record<string, unknown>).exitCode as number },
  mutation: { status: "mutated", command: (deleteBoundary.afterObservation as Record<string, unknown>).command as string, stepId: (deleteBoundary.afterObservation as Record<string, unknown>).stepId as string, executionId: (deleteBoundary.afterObservation as Record<string, unknown>).executionId as string, exitCode: (deleteBoundary.afterObservation as Record<string, unknown>).exitCode as number },
  restore: { status: "restored", command: (deleteBoundary.restore as Record<string, unknown>).command as string, stepId: (deleteBoundary.restore as Record<string, unknown>).stepId as string, executionId: (deleteBoundary.restore as Record<string, unknown>).executionId as string, exitCode: (deleteBoundary.restore as Record<string, unknown>).exitCode as number },
  diff: { status: "clean-after-restore", changed: true, changedObjects: rollback?.changedObjects as Array<{ kind: string; id?: string | number; source?: string }> },
  runtimeBoundary: { backend: "wordpress-playground", environment: "wordpress", disposable: true, hostAccess: "declared-mounts-only", destroy: { status: "destroyed", metadata: { source: "runtime.destroyed lifecycle event" } } },
  artifacts: [{ path: "files/sandbox-isolation/delete-post-proof.json", kind: SANDBOX_ISOLATION_PROOF_ARTIFACT_KIND }],
  metadata: { suiteId: "mutation-suite-run", caseId: "delete-post" },
})
assert.equal(proof.schema, "wp-codebox/sandbox-isolation-proof/v1")
assert.equal(proof.baseline.command, "wp-codebox.checkpoint-create")
assert.equal(proof.mutation.command, "wordpress.rest-request")
assert.equal(proof.restore.command, "wp-codebox.checkpoint-restore")
assert.equal(proof.diff.status, "clean-after-restore")
assert.equal(proof.runtimeBoundary.destroy.status, "destroyed")
assert.throws(() => sandboxIsolationProof({ ...proof, runtimeBoundary: { ...proof.runtimeBoundary, destroy: { status: "failed" } as never } }), /runtimeBoundary\.destroy\.status=destroyed/)

console.log("playground public runtime primitives ok")
