import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeRunRegistry } from "../packages/runtime-core/src/run-registry.ts"
import { runManagedServiceCleanup } from "../packages/cli/src/commands/recipe-run.ts"
import { RunResourceCleanupError } from "../packages/cli/src/commands/recipe-run-finalizer.ts"
import type { RuntimeServiceEvidence } from "../packages/cli/src/runtime-services.ts"

const directory = await mkdtemp(join(tmpdir(), "wp-codebox-service-lifecycle-"))
try {
  const registry = new RuntimeRunRegistry(directory)

  const succeeded = await registry.create({ runId: "service-success", status: "running", metadata: {} })
  const succeededEvidence: RuntimeServiceEvidence[] = [{ id: "mysql", kind: "mysql", provider: "test", version: "test", readiness: "ready", lifecycle: "provisioned" }]
  const cleanup = await runManagedServiceCleanup(registry, succeeded, succeededEvidence, false, async () => {
    succeededEvidence[0]!.lifecycle = "released"
    succeededEvidence[0]!.teardown = "completed"
  })
  assert.equal(cleanup.state, "completed")
  assert.deepEqual((await registry.read(succeeded.runId)).metadata.managedRuntimeServices, succeededEvidence)

  const failed = await registry.create({ runId: "service-failure", status: "running", metadata: {} })
  const failedEvidence: RuntimeServiceEvidence[] = [{ id: "mysql", kind: "mysql", provider: "test", version: "test", readiness: "ready", lifecycle: "provisioned" }]
  const preserved = await runManagedServiceCleanup(registry, failed, failedEvidence, true, async () => {
    failedEvidence[0]!.lifecycle = "failed"
    failedEvidence[0]!.teardown = "failed"
    failedEvidence[0]!.diagnostic = { code: "teardown-failed" }
    throw new Error("fixture teardown failure")
  })
  assert.equal(preserved.state, "failed", "a primary recipe failure keeps structured cleanup evidence")
  assert.deepEqual((await registry.read(failed.runId)).metadata.managedRuntimeServices, failedEvidence)

  const terminal = await registry.create({ runId: "service-terminal-cleanup-failure", status: "running", metadata: {} })
  await assert.rejects(
    runManagedServiceCleanup(registry, terminal, [], false, async () => { throw new Error("fixture teardown failure") }),
    (error: unknown) => error instanceof RunResourceCleanupError && error.evidence.state === "failed",
    "cleanup failure becomes the terminal error when there is no earlier recipe failure",
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log("runtime service lifecycle cleanup tests passed")
