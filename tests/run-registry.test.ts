import assert from "node:assert/strict"

import { withTempDir } from "../scripts/test-kit.js"
import { RuntimeRunRegistry, runtimeRunResultFromRecipeSummary, transitionRuntimeRunStatus, type RecipeRunSummary } from "../packages/runtime-core/src/index.js"
import { finalizeRecipeValidationFailure } from "../packages/cli/src/commands/recipe-run-finalizer.js"
import { runRunsArtifactsCommand } from "../packages/cli/src/commands/runs.js"

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
    result: runtimeRunResultFromRecipeSummary(recipeRunSummaryFixture()),
    now: new Date("2026-01-02T03:04:08.000Z"),
  })
  assert.equal(succeeded.lifecycle.terminal, true)
  assert.equal(succeeded.lifecycle.outcome, "succeeded")
  assert.equal(succeeded.result?.schema, "wp-codebox/runtime-run-result/v1")
  assert.equal(succeeded.result?.status, "succeeded")
  assert.equal(succeeded.result?.artifacts[0]?.path, "files/summary.json")

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

await withTempDir("wp-codebox-run-registry-artifacts-", async (directory) => {
  const registry = new RuntimeRunRegistry(directory)
  const run = await registry.create({ runId: "result-artifacts", status: "running" })
  await registry.update(run.runId, {
    status: "succeeded",
    artifactRefs: [{ kind: "artifact-bundle", path: "artifacts/run.json" }],
    result: runtimeRunResultFromRecipeSummary(recipeRunSummaryFixture()),
  })

  const { code, stdout } = await captureStdout(() => runRunsArtifactsCommand(["--registry", directory, "--run-id", run.runId, "--json"]))
  const output = JSON.parse(stdout)

  assert.equal(code, 0)
  assert.equal(output.result.schema, "wp-codebox/runtime-run-result/v1")
  assert.equal(output.resultArtifacts[0].path, "files/summary.json")
  assert.equal(output.resultRefs.logs[0].path, "files/summary.json")
})

await withTempDir("wp-codebox-run-registry-finalizer-", async (directory) => {
  const registry = new RuntimeRunRegistry(directory)
  const run = await registry.create({ runId: "finalizer-result", status: "running" })
  const output = await finalizeRecipeValidationFailure({
    recipePath: "recipe.json",
    runRegistry: registry,
    runRecord: run,
    artifactPointer: { update: async () => {} },
    startedAtMs: Date.now(),
    failure: { name: "RecipeValidationError", message: "recipe failed validation" },
    validation: { issues: [{ code: "invalid", path: "$.workflow", message: "invalid workflow" }] },
  })
  const record = await registry.read(run.runId)

  assert.equal(output.run?.result?.schema, "wp-codebox/runtime-run-result/v1")
  assert.equal(record.result?.schema, "wp-codebox/runtime-run-result/v1")
  assert.equal(record.result?.summary?.failure_summary, "recipe failed validation")
})

await withTempDir("wp-codebox-run-registry-cancel-", async (directory) => {
  const registry = new RuntimeRunRegistry(directory)
  const run = await registry.create({ runId: "cancel-active", status: "running", now: new Date("2026-01-02T03:04:05.000Z") })

  assert.equal(run.lifecycle.cancellable, true)
  assert.equal(run.lifecycle.cancelRequested, false)

  const requested = await registry.requestCancellation(run.runId, {
    reason: "caller stopped",
    now: new Date("2026-01-02T03:04:06.000Z"),
  })
  assert.equal(requested.schema, "wp-codebox/run-cancellation-request/v1")
  assert.equal(requested.cancellationRequested, true)
  assert.equal(requested.alreadyRequested, false)
  assert.equal(requested.terminal, false)
  assert.equal(requested.record.status, "running")
  assert.equal(requested.record.lifecycle.cancelRequested, true)
  assert.deepEqual(requested.record.lifecycle.cancellation, {
    requestedAt: "2026-01-02T03:04:06.000Z",
    reason: "caller stopped",
  })

  const repeated = await registry.requestCancellation(run.runId, {
    reason: "ignored duplicate",
    now: new Date("2026-01-02T03:04:07.000Z"),
  })
  assert.equal(repeated.cancellationRequested, true)
  assert.equal(repeated.alreadyRequested, true)
  assert.deepEqual(repeated.record.lifecycle.cancellation, requested.record.lifecycle.cancellation)

  const cancelled = await registry.update(run.runId, {
    status: "cancelled",
    now: new Date("2026-01-02T03:04:08.000Z"),
  })
  assert.equal(cancelled.lifecycle.terminal, true)
  assert.equal(cancelled.lifecycle.cancelled, true)
  assert.equal(cancelled.lifecycle.outcome, "cancelled")
})

function recipeRunSummaryFixture(): RecipeRunSummary {
  return {
    schema: "wp-codebox/recipe-run-summary/v1",
    success: true,
    status: "succeeded",
    diagnostics: [],
    artifacts: [{ id: "summary", kind: "codebox-command-log", path: "files/summary.json" }],
    commands: [],
    refs: {
      startup_logs: [],
      probe_json: [],
      screenshots: [],
      side_effects: [],
      declared_artifacts: [],
      artifact_bundles: [],
      changed_files: [],
      patches: [],
      transcripts: [],
      logs: [{ id: "summary", kind: "codebox-command-log", path: "files/summary.json" }],
      runtimes: [],
    },
    metadata: { run_id: "result-artifacts" },
  }
}

async function captureStdout(callback: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  let stdout = ""
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stdout += chunk.toString()
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback()
    } else if (callback) {
      callback()
    }
    return true
  }) as typeof process.stdout.write

  try {
    return { code: await callback(), stdout }
  } finally {
    process.stdout.write = write
  }
}
