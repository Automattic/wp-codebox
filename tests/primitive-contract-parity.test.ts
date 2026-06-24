import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  componentManifestForRuntimePlugins,
  countRunPlanChildResults,
  normalizeAgentTaskStatus,
  normalizeCheckStatus,
  normalizeCommandEnvelopeStatus,
  normalizePhaseRecipeStatus,
  normalizeRunPlanConcurrency,
  normalizeRunPlanProgressSnapshot,
  normalizeRunPlanWorkerDescriptors,
  normalizeRuntimeMountTarget,
  redactJsonValue,
  resolveEffectiveRuntimeToolPolicy,
  resolveRuntimeToolAlias,
  runPlanSucceeded,
  runtimeDependencyPlanContract,
  RUN_PLAN_EVENT_SCHEMA,
  RUN_PLAN_PROGRESS_SCHEMA,
  RUN_PLAN_RESULT_SCHEMA,
  RUN_PLAN_SCHEMA,
  safeArtifactRelativePath,
  type SandboxToolPolicySnapshot,
  type WorkspaceRecipeExtraPlugin,
} from "../packages/runtime-core/src/index.js"
import { primitiveContractsFixture } from "../scripts/primitive-contract-fixture.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/primitive-contracts.json", import.meta.url), "utf8"))
assert.deepEqual(fixture, primitiveContractsFixture(), "primitive contracts fixture must match generated TS contracts")

for (const [profile, contract] of Object.entries(fixture.redaction.profiles) as Array<[string, { input: unknown; expected: unknown }]>) {
  assert.deepEqual(redactJsonValue(contract.input, { profile: profile as never, redactStrings: false }), contract.expected, `${profile} redaction contract`)
}

for (const contract of fixture.pathPolicy.mountTargets as Array<{ input: string; expected?: string; error?: boolean }>) {
  if (contract.error) {
    assert.throws(() => normalizeRuntimeMountTarget(contract.input), /absolute|directory/)
  } else {
    assert.equal(normalizeRuntimeMountTarget(contract.input), contract.expected)
  }
}

for (const contract of fixture.pathPolicy.artifactPaths as Array<{ input: string; expected?: string; error?: boolean }>) {
  if (contract.error) {
    assert.throws(() => safeArtifactRelativePath(contract.input), /relative|directory/)
  } else {
    assert.equal(safeArtifactRelativePath(contract.input), contract.expected)
  }
}

const toolPolicy = fixture.toolPolicy.snapshot as SandboxToolPolicySnapshot
const effectiveToolPolicy = resolveEffectiveRuntimeToolPolicy(toolPolicy)
assert.deepEqual(
  {
    schema: effectiveToolPolicy.schema,
    version: effectiveToolPolicy.version,
    allowedRuntimeToolIds: effectiveToolPolicy.allowedRuntimeToolIds,
    visibleRuntimeToolIds: effectiveToolPolicy.visibleRuntimeToolIds,
    parentOnlyRuntimeToolIds: effectiveToolPolicy.parentOnlyRuntimeToolIds,
    hiddenRuntimeToolIds: effectiveToolPolicy.hiddenRuntimeToolIds,
    metadata: effectiveToolPolicy.metadata,
  },
  fixture.toolPolicy.effective,
)
for (const [alias, runtimeToolId] of Object.entries(fixture.toolPolicy.aliases) as Array<[string, string]>) {
  assert.equal(resolveRuntimeToolAlias(effectiveToolPolicy, alias)?.runtimeToolId, runtimeToolId, `${alias} alias contract`)
}

for (const contract of fixture.statusTaxonomy as Array<{ input: Record<string, unknown>; command: string; phase: string; agentTask: string; check: string }>) {
  assert.equal(normalizeCommandEnvelopeStatus(contract.input), contract.command)
  assert.equal(normalizePhaseRecipeStatus(contract.input), contract.phase)
  assert.equal(normalizeAgentTaskStatus(contract.input), contract.agentTask)
  assert.equal(normalizeCheckStatus(contract.input), contract.check)
}

assert.deepEqual(runtimeDependencyPlanContract(fixture.runtimeDependencyPlan.input), fixture.runtimeDependencyPlan.expected)
assert.deepEqual(
  componentManifestForRuntimePlugins(fixture.componentManifest.components as WorkspaceRecipeExtraPlugin[], fixture.componentManifest.providers as WorkspaceRecipeExtraPlugin[]),
  fixture.componentManifest.expected,
)

assert.deepEqual(countRunPlanChildResults(fixture.runPlan.children), fixture.runPlan.counts)
assert.equal(runPlanSucceeded(fixture.runPlan.counts), fixture.runPlan.succeeded)
assert.deepEqual(
  runPlanDependencyBatches(normalizeRunPlanWorkerDescriptors(fixture.runPlan.dependencyWorkers)),
  fixture.runPlan.dependencyBatches,
)
assert.equal(normalizeRunPlanConcurrency("", { defaultConcurrency: 3, maxConcurrency: 5 }), fixture.runPlan.concurrency.defaulted)
assert.equal(normalizeRunPlanConcurrency(99, { maxConcurrency: 2 }), fixture.runPlan.concurrency.clamped)
assert.deepEqual(normalizeRunPlanProgressSnapshot(fixture.runPlan.progressInput), fixture.runPlan.progress)
assert.deepEqual(fixture.runPlan.schemas, {
  plan: RUN_PLAN_SCHEMA,
  event: RUN_PLAN_EVENT_SCHEMA,
  progress: RUN_PLAN_PROGRESS_SCHEMA,
  result: RUN_PLAN_RESULT_SCHEMA,
})

console.log("primitive contract parity passed")

function runPlanDependencyBatches(workers: ReturnType<typeof normalizeRunPlanWorkerDescriptors>): string[][] {
  const remaining = new Set(workers.map((worker) => worker.id))
  const batches: string[][] = []
  while (remaining.size > 0) {
    const batch = workers.filter((worker) => remaining.has(worker.id) && worker.dependsOn.every((dependency) => !remaining.has(dependency))).map((worker) => worker.id)
    if (batch.length === 0) throw new Error("Run plan dependencies could not be scheduled.")
    batch.forEach((worker) => remaining.delete(worker))
    batches.push(batch)
  }
  return batches
}
