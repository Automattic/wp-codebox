import assert from "node:assert/strict"

import { withTempDir } from "../scripts/test-kit.js"
import { RuntimeRunRegistry, transitionRuntimeRunStatus } from "../packages/runtime-core/src/index.js"

assert.equal(transitionRuntimeRunStatus("queued", "running"), "running")
assert.equal(transitionRuntimeRunStatus("queued", "collecting_artifacts"), "collecting_artifacts")
assert.equal(transitionRuntimeRunStatus("succeeded", "succeeded"), "succeeded")
assert.throws(() => transitionRuntimeRunStatus("queued", "succeeded"), /Invalid runtime run status transition/)
assert.throws(() => transitionRuntimeRunStatus("failed", "running"), /terminal runtime run status/)

await withTempDir("wp-codebox-run-registry-", async (directory) => {
  const registry = new RuntimeRunRegistry(directory)
  const run = await registry.create({ runId: "retry-safe", status: "running", now: new Date("2026-01-02T03:04:05.000Z") })

  assert.equal(run.status, "running")

  await assert.rejects(registry.update(run.runId, { status: "queued", now: new Date("2026-01-02T03:04:06.000Z") }), /Invalid runtime run status transition/)

  const finalizing = await registry.update(run.runId, { status: "collecting_artifacts", now: new Date("2026-01-02T03:04:07.000Z") })
  assert.equal(finalizing.lifecycle.phase, "finalizing")

  const succeeded = await registry.update(run.runId, {
    status: "succeeded",
    artifactRefs: [{ kind: "artifact-bundle", path: "artifacts/run.json" }],
    now: new Date("2026-01-02T03:04:08.000Z"),
  })
  assert.equal(succeeded.lifecycle.terminal, true)
  assert.equal(succeeded.lifecycle.outcome, "succeeded")

  await assert.rejects(registry.update(run.runId, { status: "failed", now: new Date("2026-01-02T03:04:09.000Z") }), /terminal runtime run status/)

  const retry = await registry.update(run.runId, {
    status: "succeeded",
    artifactRefs: [{ kind: "artifact-bundle", path: "artifacts/retry.json" }],
    cleanup: { status: "running" },
    now: new Date("2026-01-02T03:04:10.000Z"),
  })
  assert.equal(retry.status, "succeeded")
  assert.deepEqual(retry.artifactRefs, [{ kind: "artifact-bundle", path: "artifacts/retry.json" }])
  assert.equal(retry.lifecycle.cleanup.status, "running")
  assert.equal(retry.lifecycle.cleanup.attempts, 1)
})
