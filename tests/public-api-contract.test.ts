import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import * as contractsApi from "../packages/runtime-core/src/contracts.js"
import {
  artifactBundleFileManifest,
  artifactResultEnvelope,
  buildRuntimePackageRunRecipe,
  browserArtifactPersistenceProjection,
  browserRunResultEnvelope,
  fuzzSuiteContract,
  fuzzSuiteResultEnvelope,
  normalizeAgentTaskRunResult,
  normalizeArtifactResultEnvelope,
  normalizeBrowserRunResult,
  parentToolBridgeContract,
  performanceObservation,
  runtimePackageExecutionInput,
  runtimeProfile,
  persistedBrowserArtifactRefs,
  AGENT_TASK_RUN_RESULT_SCHEMA,
  ARTIFACT_RESULT_ENVELOPE_SCHEMA,
  FUZZ_SUITE_RESULT_SCHEMA,
  FUZZ_SUITE_SCHEMA,
  PARENT_TOOL_BRIDGE_SCHEMA,
  PERFORMANCE_OBSERVATION_SCHEMA,
  RUNTIME_PROFILE_SCHEMA,
  RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS,
  RUNNER_WORKSPACE_BACKEND_FILTER,
} from "../packages/runtime-core/src/public.js"
import * as publicApi from "../packages/runtime-core/src/public.js"

const root = new URL("..", import.meta.url)

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as Record<string, unknown>
}

function exportKeys(packageJson: Record<string, unknown>): string[] {
  const exportsField = packageJson.exports
  assert.ok(exportsField && typeof exportsField === "object" && !Array.isArray(exportsField), "package must declare object exports")
  return Object.keys(exportsField as Record<string, unknown>)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const rootPackage = await readJson("package.json")
const corePackage = await readJson("packages/runtime-core/package.json")
const playgroundPackage = await readJson("packages/runtime-playground/package.json")

assert.deepEqual(exportKeys(rootPackage), [
  "./core",
  "./core/public",
  "./core/contracts",
  "./core/artifacts",
  "./core/internals",
  "./recipe-builders",
  "./agent-task-recipe",
  "./runtime-presets",
  "./playground",
  "./playground/public",
  "./cli",
  "./cli/recipe-secret-env",
])

assert.deepEqual(exportKeys(corePackage), [
  ".",
  "./public",
  "./contracts",
  "./artifacts",
  "./internals",
  "./recipe-builders",
  "./agent-task-recipe",
  "./runtime-presets",
])

assert.deepEqual(exportKeys(playgroundPackage), [".", "./public"])

const docs = await readFile(new URL("docs/public-api-contract.md", root), "utf8")
const pluginReadme = await readFile(new URL("packages/wordpress-plugin/README.md", root), "utf8")
const agentsApiAdapter = await readFile(new URL("packages/wordpress-plugin/src/class-wp-codebox-agents-api-adapter.php", root), "utf8")
const publicBarrel = await readFile(new URL("packages/runtime-core/src/public.ts", root), "utf8")
const contractsBarrel = await readFile(new URL("packages/runtime-core/src/contracts.ts", root), "utf8")
const runnerWorkspaceAdapter = await readFile(new URL("packages/wordpress-plugin/src/class-wp-codebox-runner-workspace-adapter.php", root), "utf8")

for (const publicEntry of [
  "@automattic/wp-codebox-core",
  "@automattic/wp-codebox-core/public",
  "@automattic/wp-codebox-core/contracts",
  "@automattic/wp-codebox-core/artifacts",
  "@automattic/wp-codebox-core/recipe-builders",
  "@automattic/wp-codebox-core/agent-task-recipe",
  "@automattic/wp-codebox-core/runtime-presets",
  "@automattic/wp-codebox-playground",
  "@automattic/wp-codebox-playground/public",
  "@automattic/wp-codebox-cli",
  "./cli/recipe-secret-env",
  "@automattic/wp-codebox-cli/recipe-secret-env",
]) {
  assert.match(docs, new RegExp(escapeRegExp(publicEntry)), `docs must mention ${publicEntry}`)
}

for (const contractArea of [
  "Runtime task/package",
  "Runner workspace",
  "Tool bridge",
  "Parent tool bridge",
  "Browser task and contained site",
  "Browser SDK",
  "Browser metrics",
  "Performance observation",
  "Fuzz suite",
  "Artifacts",
  "Inspect",
]) {
  assert.match(docs, new RegExp(`\\*\\*${contractArea}:\\*\\*`), `docs must define ${contractArea}`)
}

for (const publicModule of [
  "./agent-runtime-workload.js",
  "./agent-task-run-result.js",
  "./artifact-result-envelope.js",
  "./browser-callback-contracts.js",
  "./fuzz-suite-contracts.js",
  "./parent-tool-bridge.js",
  "./performance-observation.js",
  "./recipe-builders.js",
  "./runtime-boundary-contracts.js",
  "./runtime-contracts.js",
  "./runtime-episode.js",
  "./runtime-package-execution.js",
]) {
  assert.ok(publicBarrel.includes(`export * from "${publicModule}"`), `public barrel must export ${publicModule}`)
}

for (const internalModule of [
  "./benchmark-substrate.js",
  "./fanout-aggregation.js",
  "./generic-ability-runtime-run.js",
  "./object-utils.js",
  "./prepared-source-staging.js",
  "./provider-runtime-contracts.js",
  "./runtime-action-adapter.js",
  "./wordpress-runtime-actions.js",
  "./wordpress-workload-primitives.js",
]) {
  assert.ok(!publicBarrel.includes(`export * from "${internalModule}"`), `public barrel must not export ${internalModule}`)
  assert.ok(!contractsBarrel.includes(`export * from "${internalModule}"`), `contracts barrel must not export ${internalModule}`)
}

assert.ok(!contractsBarrel.includes(`export * from "./index.js"`), "contracts barrel must not re-export the root package barrel")

for (const internalExport of [
  "GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA",
  "buildGenericAbilityRuntimeRunRecipe",
  "PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA",
  "providerRuntimeInvocationContract",
  "PROVIDER_RUNTIME_TASK_NAMES",
  "requestWordPressRest",
  "runWordPressPhp",
  "runWordPressWpCli",
  "WORDPRESS_RUNTIME_ACTION_SCHEMA",
  "WORDPRESS_WORKLOAD_RUN_SCHEMA",
  "wordpressAbilityStep",
  "wordpressWorkloadRunRecipe",
  "buildWordPressWorkloadRunRecipe",
  "PLAYGROUND_PREVIEW_URL_SCHEMA",
  "playgroundPreviewUrl",
]) {
  assert.equal(internalExport in publicApi, false, `public facade must not expose internal export ${internalExport}`)
  assert.equal(internalExport in contractsApi, false, `contracts facade must not expose internal export ${internalExport}`)
}

assert.match(docs, /@automattic\/wp-codebox-core\/internals` exists for this monorepo's package split/)
assert.match(docs, /External integrations use the stable entrypoints listed above/)
assert.match(docs, /New external TypeScript\s+consumers should prefer/)
assert.match(docs, /WordPress consumers should prefer `WP_Codebox_API`/)
assert.match(docs, /`wp-codebox\/\*` ability ids/)
assert.match(docs, /`@automattic\/wp-codebox-playground`: advanced backend adapter entrypoint/)
assert.match(docs, /New consumers should prefer\s+`@automattic\/wp-codebox-playground\/public`/)
assert.match(docs, /## Integration Boundary/)
assert.match(docs, /Codebox adapts those upstream systems into\s+generic Codebox inputs/)
assert.match(docs, /Codebox adapter translates from generic Data Machine inputs into the Codebox\s+task\/recipe\/runtime contracts/)
assert.match(docs, /wp-codebox\/runner-workspace-backend\/v1/)
assert.match(docs, /backend adapter config schema/)
assert.match(docs, /adapter config maps each operation to its\s+integration-provided backend ability/)
assert.match(pluginReadme, /Consumers running inside WordPress should prefer `WP_Codebox_API`/)
assert.match(pluginReadme, /`wp-codebox\/\*` ability/)
assert.match(agentsApiAdapter, /Advanced internal adapter around the upstream Agents API abilities/)
assert.match(agentsApiAdapter, /@internal Adapter boundary for WP Codebox runtime integration/)
assert.doesNotMatch(docs + pluginReadme, /agents\/[a-z0-9._/-]+|datamachine-code\/[a-z0-9._/-]+/i)

assert.equal(typeof normalizeBrowserRunResult, "function")
assert.equal(typeof browserRunResultEnvelope, "function")
assert.equal(typeof browserArtifactPersistenceProjection, "function")
assert.equal(typeof persistedBrowserArtifactRefs, "function")
assert.equal(typeof artifactBundleFileManifest, "function")
assert.equal(typeof normalizeAgentTaskRunResult, "function")
assert.equal(typeof artifactResultEnvelope, "function")
assert.equal(typeof normalizeArtifactResultEnvelope, "function")
assert.equal(typeof runtimeProfile, "function")
assert.equal(typeof parentToolBridgeContract, "function")
assert.equal(typeof fuzzSuiteContract, "function")
assert.equal(typeof fuzzSuiteResultEnvelope, "function")
assert.equal(typeof buildRuntimePackageRunRecipe, "function")
assert.equal(typeof runtimePackageExecutionInput, "function")
assert.equal(normalizeAgentTaskRunResult({ status: "completed", success: true }).schema, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(artifactResultEnvelope({ operation: "agent-task-run" }).schema, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(normalizeArtifactResultEnvelope({ success: true }).schema, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(runtimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, components: [] }).schema, RUNTIME_PROFILE_SCHEMA)
assert.equal(parentToolBridgeContract({ allowedTools: ["workspace.read"], dispatcher: { mode: "host_command", command: { argv: ["dispatch"] } } }).schema, PARENT_TOOL_BRIDGE_SCHEMA)
assert.equal(performanceObservation({ command: "wordpress.run-php", timing: { durationMs: 12.5 }, memory: { deltaBytes: 1024 } }).schema, PERFORMANCE_OBSERVATION_SCHEMA)
assert.equal(fuzzSuiteContract({ id: "ability-boundary", cases: [{ id: "empty-input" }] }).schema, FUZZ_SUITE_SCHEMA)
assert.deepEqual(fuzzSuiteResultEnvelope({
  suite: { id: "ability-boundary" },
  cases: [
    { id: "empty-input", status: "passed", success: true, diagnostics: [], artifactRefs: [{ path: "fuzz/case.json", kind: "json" }] },
    { id: "bad-input", status: "failed", success: false, diagnostics: [{ severity: "error", message: "Rejected bad input." }] },
  ],
}).summary, { total: 2, passed: 1, failed: 1, error: 0, skipped: 0 })
assert.equal(fuzzSuiteResultEnvelope({ suite: { id: "ability-boundary" } }).schema, FUZZ_SUITE_RESULT_SCHEMA)
assert.equal(RUNNER_WORKSPACE_BACKEND_FILTER, "wp_codebox_runner_workspace_backend")
assert.ok(RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS.includes("publish_runner_workspace"))
assert.match(runnerWorkspaceAdapter, new RegExp(escapeRegExp(RUNNER_WORKSPACE_BACKEND_FILTER)))
for (const key of RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS) {
  assert.match(runnerWorkspaceAdapter, new RegExp(escapeRegExp(key)), `PHP adapter must recognize backend ability key ${key}`)
}

console.log("public API contract ok")
