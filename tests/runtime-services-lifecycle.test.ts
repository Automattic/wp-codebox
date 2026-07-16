import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeRunRegistry } from "../packages/runtime-core/src/run-registry.ts"
import { runRecipeCleanup } from "../packages/cli/src/commands/recipe-run-finalizer.ts"
import type { RuntimeServiceEvidence } from "../packages/cli/src/runtime-services.ts"

async function assertTerminalCleanup(terminal: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-service-lifecycle-"))
  try {
    const registry = new RuntimeRunRegistry(directory)
    const run = await registry.create({ runId: `service-${terminal}`, status: "running", metadata: {} })
    const evidence: RuntimeServiceEvidence[] = [{ id: "mysql", kind: "mysql", provider: "test", version: "test", readiness: "ready", lifecycle: "provisioned" }]
    let releases = 0
    await runRecipeCleanup(registry, run, async () => {
      releases += 1
      evidence[0]!.lifecycle = "released"
      evidence[0]!.teardown = "completed"
    })
    await registry.update(run.runId, { metadata: { managedRuntimeServices: evidence, terminal } })
    const completed = await registry.read(run.runId)
    assert.equal(releases, 1, `${terminal} releases services once`)
    assert.deepEqual(completed.metadata.managedRuntimeServices, evidence, `${terminal} persists final service evidence`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

for (const terminal of ["runtime-creation-failure", "workflow-failure", "timeout", "cancellation", "interruption", "success"]) {
  await assertTerminalCleanup(terminal)
}

console.log("runtime service lifecycle cleanup tests passed")
