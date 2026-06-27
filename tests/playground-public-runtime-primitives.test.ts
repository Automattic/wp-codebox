import assert from "node:assert/strict"

import { fuzzSuiteContract, type RuntimeEpisodeStepResult } from "../packages/runtime-core/src/public.js"
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
assert.equal(resetResult.diagnostics?.[0]?.code, "fuzz_suite_snapshot_restore_unsupported")
assert.deepEqual(resetResult.metadata, { resetPerformed: false, restorePerformed: false, supportedResetModes: ["none", "checkpoint-per-case"] })

const suiteResult = await executeWordPressFuzzSuite(episode, fuzzSuiteContract({
  id: "snapshot-suite-run",
  resetPolicy: { mode: "restore-snapshot", snapshotRef: "artifact:baseline/files/runtime-snapshot.json" },
  cases: [{ id: "case-one", target: { kind: "command", id: "wordpress.rest-performance-observation" }, input: { command: "wordpress.rest-performance-observation", args: ["path=/wp/v2/types"] } }],
}))
assert.equal(suiteResult.status, "error")
assert.equal(suiteResult.cases[0]?.reset?.status, "unsupported")

const beforeMutationStepCount = steps.length
const mutationResult = await executeWordPressFuzzSuite(episode, fuzzSuiteContract({
  id: "mutation-suite-run",
  metadata: { allowRestMutations: true },
  cases: [{ id: "delete-post", target: { kind: "runtime-action" }, input: { type: "rest_request", method: "DELETE", path: "/wp/v2/posts/123" } }],
}))
assert.equal(mutationResult.status, "passed")
assert.deepEqual(steps.slice(beforeMutationStepCount).map((step) => step.command), ["wp-codebox.checkpoint-create", "wordpress.rest-request", "wp-codebox.checkpoint-restore"])
assert.equal(mutationResult.cases[0]?.artifactRefs?.some((ref) => ref.kind === "delete-boundary" && ref.path === "files/delete-boundaries/delete-post.json"), true)
const deleteBoundary = mutationResult.cases[0]?.metadata?.deleteBoundary as Record<string, unknown> | undefined
assert.equal(deleteBoundary?.schema, "wp-codebox/delete-boundary-artifact/v1")
assert.equal(deleteBoundary?.method, "DELETE")
assert.equal(deleteBoundary?.target, "/wp/v2/posts/123")
assert.equal(deleteBoundary?.status, 200)
assert.equal((deleteBoundary?.restore as Record<string, unknown> | undefined)?.status, "passed")
assert.equal((deleteBoundary?.restore as Record<string, unknown> | undefined)?.command, "wp-codebox.checkpoint-restore")

console.log("playground public runtime primitives ok")
