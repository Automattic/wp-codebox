import assert from "node:assert/strict"

import { getCommandDefinition } from "../packages/runtime-core/src/command-registry.js"
import { runtimeCheckpointUnsupportedDiagnostic, type ArtifactBundle, type ArtifactSpec, type ExecutionResult, type ExecutionSpec, type MountSpec, type ObservationResult, type ObservationSpec, type Runtime, type RuntimeCheckpointResult, type RuntimeInfo, type Snapshot } from "../packages/runtime-core/src/runtime-contracts.js"
import { executeRecipeWorkflowStep } from "../packages/cli/src/commands/recipe-run-workflow-evidence.js"

class UnsupportedRuntime implements Runtime {
  async info(): Promise<RuntimeInfo> {
    return { id: "runtime-unsupported", backend: "test-backend", environment: { kind: "test" }, createdAt: "2026-01-02T03:04:05.000Z", status: "created" }
  }

  async mount(_spec: MountSpec): Promise<void> {}
  async execute(_spec: ExecutionSpec): Promise<ExecutionResult> { throw new Error("not used") }
  async observe(_spec: ObservationSpec): Promise<ObservationResult> { throw new Error("not used") }
  async snapshot(_options?: unknown): Promise<Snapshot> { throw new Error("not used") }
  async collectArtifacts(_spec?: ArtifactSpec): Promise<ArtifactBundle> { throw new Error("not used") }
  async destroy(): Promise<void> {}
}

class CheckpointRuntime extends UnsupportedRuntime {
  private readonly checkpoints = new Map<string, RuntimeCheckpointResult["checkpoint"]>()

  async createCheckpoint(spec: { name: string; metadata?: Record<string, unknown> }): Promise<RuntimeCheckpointResult> {
    const checkpoint = { name: spec.name, snapshotId: `snapshot-${spec.name}`, createdAt: "2026-01-02T03:04:05.000Z", metadata: spec.metadata }
    this.checkpoints.set(spec.name, checkpoint)
    return { schema: "wp-codebox/runtime-checkpoint-result/v1", status: "created", operation: "create", checkpoint }
  }

  async restoreCheckpoint(name: string): Promise<RuntimeCheckpointResult> {
    const checkpoint = this.checkpoints.get(name)
    if (!checkpoint) {
      throw new Error(`missing checkpoint ${name}`)
    }
    return { schema: "wp-codebox/runtime-checkpoint-result/v1", status: "restored", operation: "restore", checkpoint: { ...checkpoint, restoredAt: "2026-01-02T03:04:06.000Z" } }
  }

  async listCheckpoints(): Promise<RuntimeCheckpointResult> {
    return { schema: "wp-codebox/runtime-checkpoint-result/v1", status: "listed", operation: "list", checkpoints: [...this.checkpoints.values()].filter((checkpoint): checkpoint is NonNullable<typeof checkpoint> => Boolean(checkpoint)) }
  }
}

assert.equal(getCommandDefinition("wp-codebox.checkpoint-create")?.recipe, true)
assert.equal(getCommandDefinition("wp-codebox.checkpoint-restore")?.recipe, true)
assert.equal(getCommandDefinition("wp-codebox.checkpoint-list")?.recipe, true)

assert.deepEqual(runtimeCheckpointUnsupportedDiagnostic("create", await new UnsupportedRuntime().info(), "baseline"), {
  schema: "wp-codebox/runtime-checkpoint-failure/v1",
  status: "unsupported",
  operation: "create",
  backend: "test-backend",
  name: "baseline",
  code: "runtime-checkpoints-unsupported",
  message: "Runtime backend does not support checkpoints: test-backend",
  supported: false,
})

const unsupported = await executeRecipeWorkflowStep(new UnsupportedRuntime(), { phase: "steps", index: 0, step: { command: "wp-codebox.checkpoint-create", args: ["name=baseline"] } }, process.cwd())
assert.equal(unsupported.exitCode, 1)
assert.equal(JSON.parse(unsupported.stdout).schema, "wp-codebox/runtime-checkpoint-failure/v1")
assert.equal(JSON.parse(unsupported.stdout).status, "unsupported")

const runtime = new CheckpointRuntime()
const created = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 0, step: { command: "wp-codebox.checkpoint-create", args: ["name=baseline", "metadata-json={\"case\":\"one\"}"] } }, process.cwd())
assert.equal(created.exitCode, 0)
assert.equal(JSON.parse(created.stdout).checkpoint.name, "baseline")

const listed = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 1, step: { command: "wp-codebox.checkpoint-list" } }, process.cwd())
assert.equal(listed.exitCode, 0)
assert.equal(JSON.parse(listed.stdout).checkpoints.length, 1)

const restored = await executeRecipeWorkflowStep(runtime, { phase: "steps", index: 2, step: { command: "wp-codebox.checkpoint-restore", args: ["name=baseline"] } }, process.cwd())
assert.equal(restored.exitCode, 0)
assert.equal(JSON.parse(restored.stdout).checkpoint.restoredAt, "2026-01-02T03:04:06.000Z")

console.log("runtime checkpoint primitives ok")
