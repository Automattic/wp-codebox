import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  componentManifestForRuntimePlugins,
  countRunPlanChildResults,
  normalizeAgentTaskStatus,
  normalizeCheckStatus,
  normalizeCommandEnvelopeStatus,
  normalizePhaseRecipeStatus,
  normalizeRuntimeMountTarget,
  redactJsonValue,
  resolveEffectiveRuntimeToolPolicy,
  resolveRuntimeToolAlias,
  runPlanSucceeded,
  runtimeDependencyPlanContract,
  RUN_PLAN_EVENT_SCHEMA,
  RUN_PLAN_RESULT_SCHEMA,
  RUN_PLAN_SCHEMA,
  safeArtifactRelativePath,
  type SandboxToolPolicySnapshot,
  type WorkspaceRecipeExtraPlugin,
} from "../packages/runtime-core/src/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/primitive-contracts.json", import.meta.url), "utf8"))

for (const [profile, contract] of Object.entries(fixture.redaction.profiles) as Array<[string, { input: unknown; expected: unknown }]>) {
  assert.deepEqual(redactJsonValue(contract.input, { profile: profile as never, redactStrings: false }), contract.expected, `${profile} redaction contract`)
}

for (const contract of fixture.pathPolicy.mountTargets as Array<{ input: string; expected?: string; error?: boolean }>) {
  if (contract.error) {
    assert.throws(() => normalizeRuntimeMountTarget(contract.input), /directory/)
  } else {
    assert.equal(normalizeRuntimeMountTarget(contract.input), contract.expected)
  }
}

for (const contract of fixture.pathPolicy.artifactPaths as Array<{ input: string; expected?: string; error?: boolean }>) {
  if (contract.error) {
    assert.throws(() => safeArtifactRelativePath(contract.input), /directory/)
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
assert.deepEqual(fixture.runPlan.schemas, {
  plan: RUN_PLAN_SCHEMA,
  event: RUN_PLAN_EVENT_SCHEMA,
  result: RUN_PLAN_RESULT_SCHEMA,
})

console.log("primitive contract parity passed")
