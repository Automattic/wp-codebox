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
  normalizePreviewReviewerAccess,
  normalizeRuntimeProfile,
  normalizeTypedArtifactDTO,
  parentToolBridgeContract,
  performanceObservation,
  runtimePackageExecutionInput,
  runtimeContractManifest,
  codeboxPublicContractPrimitive,
  codeboxPublicContractPrimitives,
  restRouteInventoryToFuzzSuite,
  runtimeProfile,
  wordpressRestMatrixContract,
  persistedBrowserArtifactRefs,
  AGENT_TASK_RUN_RESULT_SCHEMA,
  ARTIFACT_APPLY_PAYLOAD_SCHEMA,
  ARTIFACT_APPLY_PREFLIGHT_SCHEMA,
  ARTIFACT_RESULT_ENVELOPE_SCHEMA,
  CODEBOX_PUBLIC_RUNTIME_ABILITIES,
  CODEBOX_RUN_FUZZ_SUITE_ABILITY,
  CODEBOX_RUN_WORDPRESS_WORKLOAD_ABILITY,
  FUZZ_COVERAGE_PLAN_SCHEMA,
  FUZZ_FIXTURE_PLAN_SCHEMA,
  FUZZ_RUNNER_READINESS_SCHEMA,
  FUZZ_SUITE_RESULT_SCHEMA,
  FUZZ_SUITE_SCHEMA,
  WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA,
  REST_MUTATION_FIXTURE_OPT_IN_SCHEMA,
  REST_MUTATION_GENERATED_FIXTURES_SCHEMA,
  DELETE_BOUNDARY_ARTIFACT_SCHEMA,
  MUTATION_ISOLATION_ARTIFACT_SCHEMA,
  SANDBOX_ISOLATION_PROOF_SCHEMA,
  PARENT_TOOL_BRIDGE_SCHEMA,
  PERFORMANCE_OBSERVATION_SCHEMA,
  WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA,
  WORDPRESS_REST_MATRIX_SCHEMA,
  RUNTIME_PROFILE_SCHEMA,
  RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS,
  RUNNER_WORKSPACE_BACKEND_FILTER,
  fuzzCoveragePlanContract,
  fuzzFixturePlanContract,
  fuzzRunnerReadinessContract,
  wordpressFuzzRuntimeContract,
  TASK_INPUT_JSON_SCHEMA,
} from "../packages/runtime-core/src/public.js"
import * as publicApi from "../packages/runtime-core/src/public.js"
import * as runResultsApi from "../packages/runtime-core/src/run-results.js"
import * as playgroundPublicApi from "../packages/runtime-playground/src/public.js"

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

function barrelExportModules(source: string): string[] {
  return Array.from(source.matchAll(/^export \* from "(.+)"$/gm), (match) => match[1])
}

const rootPackage = await readJson("package.json")
const corePackage = await readJson("packages/runtime-core/package.json")
const playgroundPackage = await readJson("packages/runtime-playground/package.json")

assert.deepEqual(exportKeys(rootPackage), [
  "./core",
  "./core/public",
  "./core/contracts",
  "./core/artifacts",
  "./core/run-results",
  "./core/php-snippets",
  "./recipe-builders",
  "./run-results",
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
  "./run-results",
  "./php-snippets",
  "./internals",
  "./recipe-builders",
  "./agent-task-recipe",
  "./runtime-presets",
])
assert.equal(exportKeys(rootPackage).some((key) => key.includes("internals")), false, "workspace package must not mirror internal package entrypoints")
assert.equal(exportKeys(corePackage).filter((key) => key.includes("internals")).length, 1, "core package internals entrypoint must stay quarantined to the package split")
assert.equal(ARTIFACT_APPLY_PREFLIGHT_SCHEMA, "wp-codebox/artifact-apply-preflight/v1")
assert.equal(ARTIFACT_APPLY_PAYLOAD_SCHEMA, "wp-codebox/artifact-apply-payload/v1")

assert.deepEqual(exportKeys(playgroundPackage), [".", "./public"])

const docs = await readFile(new URL("docs/public-api-contract.md", root), "utf8")
const pluginReadme = await readFile(new URL("packages/wordpress-plugin/README.md", root), "utf8")
const agentsApiAdapter = await readFile(new URL("packages/wordpress-plugin/src/class-wp-codebox-agents-api-adapter.php", root), "utf8")
const publicBarrel = await readFile(new URL("packages/runtime-core/src/public.ts", root), "utf8")
const contractsBarrel = await readFile(new URL("packages/runtime-core/src/contracts.ts", root), "utf8")
const rootBarrel = await readFile(new URL("packages/runtime-core/src/index.ts", root), "utf8")
const runnerWorkspaceAdapter = await readFile(new URL("packages/wordpress-plugin/src/class-wp-codebox-runner-workspace-adapter.php", root), "utf8")

assert.deepEqual(barrelExportModules(publicBarrel), [
  "./agent-runtime-workload.js",
  "./agent-workload.js",
  "./agent-task-run-result.js",
  "./headless-agent-task-contracts.js",
  "./agent-terminal-result.js",
  "./artifact-apply-adapter.js",
  "./artifact-capture-policy.js",
  "./artifact-diagnostics.js",
  "./artifact-export-links.js",
  "./artifact-layout.js",
  "./artifact-manifest.js",
  "./artifact-paths.js",
  "./artifact-references.js",
  "./artifact-result-envelope.js",
  "./artifact-review.js",
  "./artifact-storage.js",
  "./artifact-test-results.js",
  "./browser-artifact-lifecycle.js",
  "./browser-callback-contracts.js",
  "./browser-interaction.js",
  "./browser-probe-contract.js",
  "./browser-playground-session-run.js",
  "./browser-result-shapes.js",
  "./browser-run-result.js",
  "./browser-review-bridge.js",
  "./browser-session-origin.js",
  "./command-agent-run.js",
  "./command-codecs.js",
  "./component-contracts.js",
  "./evidence-artifact-envelope.js",
  "./fanout-contracts.js",
  "./fixture-import-primitives.js",
  "./fuzz-fixture-plan-contracts.js",
  "./fuzz-coverage-plan-contracts.js",
  "./fuzz-case-minimizer.js",
  "./fuzz-suite-contracts.js",
  "./fuzz-suite-runner.js",
  "./rest-matrix-contracts.js",
  "./host-command-executor.js",
  "./host-tool-registry.js",
  "./managed-host-command.js",
  "./materialization-contracts.js",
  "./live-progress.js",
  "./mcp-client-configs.js",
  "./mount-primitives.js",
  "./mutation-isolation-contracts.js",
  "./parent-tool-bridge.js",
  "./performance-observation.js",
  "./query-observation-contracts.js",
  "./recipe-builders.js",
  "./recipe-run-summary.js",
  "./recipe-schema.js",
  "./recipe-source-packages.js",
  "./run-plan.js",
  "./run-registry.js",
  "./runner-workspace-publication.js",
  "./runtime-boundary-contracts.js",
  "./public-contract-primitives.js",
  "./runtime-contract-manifest.js",
  "./runtime-command-result.js",
  "./runtime-contracts.js",
  "./runtime-episode.js",
  "./runtime-neutral-contracts.js",
  "./runtime-overlay-bundle.js",
  "./runtime-overlay-descriptors.js",
  "./runtime-package-contracts.js",
  "./runtime-package-execution.js",
  "./runtime-policy.js",
  "./runtime-preset-registry.js",
  "./sandbox-tool-policy.js",
  "./sandbox-isolation-proof-contracts.js",
  "./source-root-preparation.js",
  "./structured-artifacts.js",
  "./task-input.js",
  "./tool-call-artifacts.js",
  "./transfer-proof.js",
  "./workspace-policy.js",
  "./workspace-preload-artifacts.js",
  "./wordpress-crud-contracts.js",
  "./wordpress-block-exercise-contracts.js",
  "./wordpress-admin-action-contracts.js",
  "./wordpress-page-load-contracts.js",
  "./wordpress-db-contracts.js",
  "./wordpress-db-write-set-contracts.js",
  "./wordpress-runtime-discovery-contracts.js",
  "./wordpress-fuzz-suite-builders.js",
  "./wordpress-runtime-discovery-coverage-plan.js",
  "./wordpress-block-fuzz-suite.js",
  "./wordpress-runtime-actions.js",
  "./wordpress-hotspots-contracts.js",
])

assert.deepEqual(barrelExportModules(contractsBarrel), [
  "./browser-probe-contract.js",
  "./command-registry.js",
  "./fuzz-fixture-plan-contracts.js",
  "./fuzz-coverage-plan-contracts.js",
  "./fuzz-case-minimizer.js",
  "./fuzz-suite-contracts.js",
  "./mutation-isolation-contracts.js",
  "./performance-observation.js",
  "./cache-churn-observation.js",
  "./query-observation-contracts.js",
  "./rest-matrix-contracts.js",
  "./runtime-contract-manifest.js",
  "./runtime-package-contracts.js",
  "./runtime-package-execution.js",
  "./sandbox-isolation-proof-contracts.js",
  "./wordpress-crud-contracts.js",
  "./wordpress-block-exercise-contracts.js",
  "./wordpress-admin-action-contracts.js",
  "./wordpress-db-contracts.js",
  "./wordpress-fuzz-suite-builders.js",
  "./wordpress-hotspots-contracts.js",
  "./wordpress-page-load-contracts.js",
  "./wordpress-runtime-discovery-contracts.js",
])

for (const publicEntry of [
  "@automattic/wp-codebox-core",
  "@automattic/wp-codebox-core/public",
  "@automattic/wp-codebox-core/contracts",
  "@automattic/wp-codebox-core/artifacts",
  "@automattic/wp-codebox-core/run-results",
  "@automattic/wp-codebox-core/php-snippets",
  "@automattic/wp-codebox-core/recipe-builders",
  "@automattic/wp-codebox-core/agent-task-recipe",
  "@automattic/wp-codebox-core/runtime-presets",
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
  "WordPress hotspot artifacts",
  "Fuzz suite",
  "Sandbox isolation proof",
  "Artifacts",
  "Run results",
  "Inspect",
]) {
  assert.match(docs, new RegExp(`\\*\\*${contractArea}:\\*\\*`), `docs must define ${contractArea}`)
}

for (const publicModule of [
  "./agent-runtime-workload.js",
  "./agent-task-run-result.js",
  "./artifact-result-envelope.js",
  "./browser-callback-contracts.js",
  "./fuzz-coverage-plan-contracts.js",
  "./fuzz-suite-contracts.js",
  "./rest-matrix-contracts.js",
  "./parent-tool-bridge.js",
  "./performance-observation.js",
  "./recipe-builders.js",
  "./runtime-boundary-contracts.js",
  "./public-contract-primitives.js",
  "./runtime-contracts.js",
  "./runtime-episode.js",
  "./runtime-package-execution.js",
  "./wordpress-hotspots-contracts.js",
  "./wordpress-page-load-contracts.js",
  "./wordpress-fuzz-suite-builders.js",
  "./sandbox-isolation-proof-contracts.js",
]) {
  assert.ok(publicBarrel.includes(`export * from "${publicModule}"`), `public barrel must export ${publicModule}`)
}

for (const internalModule of [
  "./agent-task-recipe.js",
  "./benchmark-substrate.js",
  "./fanout-aggregation.js",
  "./generic-ability-runtime-run.js",
  "./object-utils.js",
  "./prepared-source-staging.js",
  "./provider-runtime-contracts.js",
  "./runtime-action-adapter.js",
  "./wordpress-workload-primitives.js",
]) {
  assert.ok(!publicBarrel.includes(`export * from "${internalModule}"`), `public barrel must not export ${internalModule}`)
  assert.ok(!contractsBarrel.includes(`export * from "${internalModule}"`), `contracts barrel must not export ${internalModule}`)
}

for (const internalRequestField of [
  "provider_plugin_paths",
  "runtime_stack_mounts",
  "runtime_overlays",
  "runtime_state_mounts",
  "runtime_config_mounts",
  "secret_env",
  "wp_codebox_bin",
]) {
  assert.equal(JSON.stringify(TASK_INPUT_JSON_SCHEMA).includes(internalRequestField), false, `public task input schema must not expose ${internalRequestField}`)
}

assert.equal(TASK_INPUT_JSON_SCHEMA.required.includes("agent_bundles"), false, "agent_bundles must not be required by the public task input schema")

assert.ok(!contractsBarrel.includes(`export * from "./index.js"`), "contracts barrel must not re-export the root package barrel")

for (const internalExport of [
  "GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA",
  "buildGenericAbilityRuntimeRunRecipe",
  "PROVIDER_RUNTIME_INVOCATION_CONTRACT_SCHEMA",
  "providerRuntimeInvocationContract",
  "PROVIDER_RUNTIME_TASK_NAMES",
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
assert.match(docs, /workspace package does not expose a `\.\/core\/internals` mirror/)
assert.match(docs, /External\s+integrations use the stable entrypoints listed above/)
assert.match(docs, /New external TypeScript\s+consumers should prefer/)
assert.match(docs, /`@automattic\/wp-codebox-core`: compatibility-only broad barrel/)
assert.match(rootBarrel, /Stable root package barrel kept for existing consumers/)
assert.match(rootBarrel, /prefer the curated `@automattic\/wp-codebox-core\/public` facade or narrower/)
assert.match(docs, /WordPress consumers should prefer `WP_Codebox_API`/)
assert.match(docs, /`wp-codebox\/\*` ability ids/)
assert.match(docs, /runtime backend implementation package is used by the CLI and plugin\s+distribution/)
assert.match(docs, /External integrations should compose the Codebox core facades,\s+WordPress abilities, CLI, or browser SDK/)
assert.match(docs, /Product consumers should use the Codebox-owned public surfaces/)
for (const handoffAbility of [
  "wp-codebox/create-browser-task-contract",
  "wp-codebox/normalize-browser-artifact-bundle",
  "wp-codebox/persist-browser-artifact",
  "wp-codebox/import-artifact-bundle",
  "wp-codebox/reimport-artifact-bundle",
  "wp-codebox/run-agent-task-fanout",
]) {
  assert.match(docs, new RegExp(escapeRegExp(handoffAbility)), `public docs must cover ${handoffAbility}`)
  assert.match(pluginReadme, new RegExp(escapeRegExp(handoffAbility.replace("wp-codebox/", "")) + "|" + escapeRegExp(handoffAbility)), `plugin README must cover ${handoffAbility}`)
}
assert.match(docs + pluginReadme, /WP Codebox owns the contract envelope/)
assert.match(docs + pluginReadme, /callers? own durable job state|host owns durable job state/)
assert.match(docs + pluginReadme, /normalize-browser-artifact-bundle[\s\S]*persist-browser-artifact[\s\S]*reimport-artifact-bundle/)
assert.doesNotMatch(docs + pluginReadme, /Studio Native/i)
assert.match(docs, /`@automattic\/wp-codebox-playground`: advanced runtime backend entrypoint/)
assert.match(docs, /New consumers should prefer\s+`@automattic\/wp-codebox-playground\/public`/)
assert.match(docs, /## Integration Boundary/)
assert.match(docs, /Codebox adapts host systems into generic\s+Codebox inputs/)
assert.match(docs, /Codebox adapter\s+translates from host-owned inputs into the Codebox task\/recipe\/runtime contracts/)
assert.match(docs, /wp-codebox\/runner-workspace-backend\/v1/)
assert.match(docs, /backend adapter config schema/)
assert.match(docs, /adapter config maps each operation to its\s+integration-provided backend ability/)
assert.match(docs, /runtimeContractManifest\(\)/)
assert.match(docs, /## External Orchestrator Migration/)
assert.match(docs, /Root package import for command names, schema ids, ability metadata, WordPress runtime discovery, CRUD\/DB contracts, REST matrix\/fuzz suite builders, or performance observation \| `@automattic\/wp-codebox-core\/contracts`/)
assert.match(docs, /Root package import for artifact refs, export links, bundle verification, or apply\/materialization handoff \| `@automattic\/wp-codebox-core\/artifacts`/)
assert.match(docs, /Root package import for runtime package, phpunit, or bench recipe assembly \| `@automattic\/wp-codebox-core\/recipe-builders`/)
assert.match(docs, /Root package import for task, command, browser, recipe, artifact, or fuzz result DTOs \| `@automattic\/wp-codebox-core\/run-results`/)
assert.match(docs, /External orchestrators and other dist\/dynamic package loaders should import/)
assert.match(docs, /The root barrel remains published so existing integrations keep working/)
assert.match(docs, /Treat it\s+as compatibility-only/)
assert.match(docs, /wp-codebox\/run-agent-task/)
assert.match(docs, /wp-codebox\/run-runtime-package/)
assert.match(docs, /wp-codebox\/run-wordpress-workload/)
assert.match(docs, /wp-codebox\/run-fuzz-suite/)
assert.match(docs, /ability is an in-process WordPress ability only/)
assert.match(docs, /supported_by_this_ability: false/)
assert.match(docs, /ability_execution_mode: "php-in-process-only"/)
assert.match(docs, /wp-codebox run-fuzz-suite --runner-mode=runtime-backed/)
assert.match(docs, /wp-codebox\/wordpress-fuzz-runtime-contract\/v1/)
assert.match(docs, /WP_Codebox_API::wordpress_fuzz_runtime_contract\(\)/)
assert.match(docs, /wp-codebox fuzz descriptor --format=json/)
assert.match(docs, /unsupportedCapabilities/)
assert.match(docs, /delete-boundary-artifact/)
assert.match(docs, /executeWordPressFuzzSuite/)
assert.match(docs, /manifest intentionally excludes backend handler bindings/)
assert.doesNotMatch(docs + pluginReadme, /\bData Machine\b|\bData Machine Code\b|\bAgents API\b|\bWordPress Playground\b|generic Data Machine inputs/)
assert.match(pluginReadme, /Consumers running inside WordPress should prefer `WP_Codebox_API`/)
assert.match(pluginReadme, /`wp-codebox\/\*` ability/)
assert.match(agentsApiAdapter, /Advanced internal adapter around the upstream Agents API abilities/)
assert.match(agentsApiAdapter, /@internal Adapter boundary for WP Codebox runtime integration/)
assert.match(agentsApiAdapter, /Consumers should[\s*]+call WP_Codebox_API or wp-codebox\/\* abilities/)
assert.doesNotMatch(agentsApiAdapter, /Consumers should depend on this class/)
assert.doesNotMatch(docs + pluginReadme, /agents\/[a-z0-9._/-]+|agents-api\/[a-z0-9._/-]+|datamachine-code\/[a-z0-9._/-]+/i)
assert.doesNotMatch(docs + pluginReadme, /WP_Codebox_Agents_API_Adapter/)
assert.doesNotMatch(docs + pluginReadme, /call raw upstream ability names|invoke raw upstream ability names/)

assert.equal(typeof normalizeBrowserRunResult, "function")
assert.equal(typeof browserRunResultEnvelope, "function")
assert.equal(typeof browserArtifactPersistenceProjection, "function")
assert.equal(typeof persistedBrowserArtifactRefs, "function")
assert.equal(typeof artifactBundleFileManifest, "function")
assert.equal(typeof normalizeAgentTaskRunResult, "function")
assert.equal(typeof artifactResultEnvelope, "function")
assert.equal(typeof normalizeArtifactResultEnvelope, "function")
assert.equal(typeof runResultsApi.normalizeAgentTaskRunResult, "function")
assert.equal(typeof runResultsApi.artifactResultEnvelope, "function")
assert.equal(typeof runResultsApi.normalizeArtifactResultEnvelope, "function")
assert.equal(typeof runResultsApi.browserRunResultEnvelope, "function")
assert.equal(typeof runResultsApi.createRuntimeCommandResultEnvelope, "function")
assert.equal(typeof runResultsApi.normalizeRecipeRunSummary, "function")
assert.equal(typeof runResultsApi.fuzzSuiteResultEnvelope, "function")
assert.equal(contractsApi.WORDPRESS_RUNTIME_DISCOVERY_SCHEMA, "wp-codebox/wordpress-runtime-discovery/v1")
assert.equal(contractsApi.WORDPRESS_CRUD_OPERATION_SCHEMA, "wp-codebox/wordpress-crud-operation/v1")
assert.equal(contractsApi.WORDPRESS_DB_OPERATION_SCHEMA, "wp-codebox/wordpress-db-operation/v1")
assert.equal(typeof contractsApi.wordpressRestMatrixContract, "function")
assert.equal(typeof contractsApi.restRouteInventoryToFuzzSuite, "function")
assert.equal(typeof contractsApi.performanceObservation, "function")
assert.equal(typeof contractsApi.adminPageInventoryToFuzzSuite, "function")
assert.equal(typeof contractsApi.normalizeWordPressCrudOperation, "function")
assert.equal(typeof contractsApi.normalizeWordPressDbOperation, "function")
assert.equal(typeof runtimeProfile, "function")
assert.equal(typeof normalizeRuntimeProfile, "function")
assert.equal(typeof normalizeTypedArtifactDTO, "function")
assert.equal(typeof normalizePreviewReviewerAccess, "function")
assert.equal(typeof parentToolBridgeContract, "function")
assert.equal(typeof fuzzCoveragePlanContract, "function")
assert.equal(typeof fuzzSuiteContract, "function")
assert.equal(typeof fuzzSuiteResultEnvelope, "function")
assert.equal(typeof wordpressRestMatrixContract, "function")
assert.equal(typeof restRouteInventoryToFuzzSuite, "function")
assert.equal(typeof buildRuntimePackageRunRecipe, "function")
assert.equal(typeof runtimePackageExecutionInput, "function")
assert.equal(typeof runtimeContractManifest, "function")
assert.equal(typeof codeboxPublicContractPrimitives, "function")
assert.equal(codeboxPublicContractPrimitive("runtimeSession").schemas.access, "wp-codebox/runtime-access/v1")
assert.equal(codeboxPublicContractPrimitive("runtimeProfile").schemas.profile, RUNTIME_PROFILE_SCHEMA)
assert.equal(codeboxPublicContractPrimitive("task").schemas.headlessResult, "wp-codebox/headless-agent-task-result/v1")
assert.equal(codeboxPublicContractPrimitive("agent").abilities.runTask, CODEBOX_PUBLIC_RUNTIME_ABILITIES.agentTask.run)
assert.equal(codeboxPublicContractPrimitive("artifact").schemas.resultEnvelope, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(codeboxPublicContractPrimitive("fuzzing").schemas.sandboxIsolationProof, SANDBOX_ISOLATION_PROOF_SCHEMA)
assert.equal(codeboxPublicContractPrimitive("credential").redacted, true)
assert.deepEqual(codeboxPublicContractPrimitives().task.abilities, CODEBOX_PUBLIC_RUNTIME_ABILITIES.agentTask)
assert.deepEqual(runtimeContractManifest().abilities, CODEBOX_PUBLIC_RUNTIME_ABILITIES)
assert.equal(runtimeContractManifest().abilities.wordpressRuntime.runWorkload, CODEBOX_RUN_WORDPRESS_WORKLOAD_ABILITY)
assert.equal(runtimeContractManifest().abilities.wordpressRuntime.runFuzzSuite, CODEBOX_RUN_FUZZ_SUITE_ABILITY)
assert.equal(runtimeContractManifest().schemas.wordpressRuntime.workloadRun, "wp-codebox/wordpress-workload-run/v1")
assert.equal(runtimeContractManifest().schemas.wordpressRuntime.fuzzCoveragePlan, FUZZ_COVERAGE_PLAN_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntime.fuzzSuite, FUZZ_SUITE_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntime.fuzzSuiteResult, FUZZ_SUITE_RESULT_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntime.fuzzRunnerReadiness, FUZZ_RUNNER_READINESS_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntime.wordpressFuzzRuntimeContract, WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntime.blockExerciseResult, WORDPRESS_BLOCK_EXERCISE_RESULT_SCHEMA)
assert.equal(runtimeContractManifest().schemas.wordpressRuntime.sandboxIsolationProof, SANDBOX_ISOLATION_PROOF_SCHEMA)
assert.equal(runtimeContractManifest().schemas.agentTask.runRequest, "wp-codebox/agent-task-run-request/v1")
assert.equal(runtimeContractManifest().providerRuntime.tasks.workspaceCommand, "wp-codebox.runner-workspace.command")
assert.equal("runnerWorkspaceBackend" in runtimeContractManifest(), false)
assert.equal(normalizeAgentTaskRunResult({ status: "completed", success: true }).schema, AGENT_TASK_RUN_RESULT_SCHEMA)
assert.equal(wordpressRestMatrixContract({ id: "public-rest-matrix" }).schema, WORDPRESS_REST_MATRIX_SCHEMA)
assert.equal(artifactResultEnvelope({ operation: "agent-task-run" }).schema, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(normalizeArtifactResultEnvelope({ success: true }).schema, ARTIFACT_RESULT_ENVELOPE_SCHEMA)
assert.equal(runtimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, components: [] }).schema, RUNTIME_PROFILE_SCHEMA)
assert.equal(normalizeRuntimeProfile({ schema: RUNTIME_PROFILE_SCHEMA, components: [] }).schema, RUNTIME_PROFILE_SCHEMA)
assert.equal(normalizeTypedArtifactDTO({ name: "report", type: "json", artifact: { path: "files/report.json", sha256: "a".repeat(64) } })?.artifact.kind, "typed-artifact")
assert.equal(normalizePreviewReviewerAccess(undefined).status, "unavailable")
assert.equal(parentToolBridgeContract({ allowedTools: ["workspace.read"], dispatcher: { mode: "host_command", command: { argv: ["dispatch"] } } }).schema, PARENT_TOOL_BRIDGE_SCHEMA)
assert.equal(performanceObservation({ command: "wordpress.run-php", timing: { durationMs: 12.5 }, memory: { deltaBytes: 1024 } }).schema, PERFORMANCE_OBSERVATION_SCHEMA)
assert.equal(publicApi.mutationIsolationArtifact({ operation: "rest_request", target: "/wp/v2/posts", method: "POST" }).schema, MUTATION_ISOLATION_ARTIFACT_SCHEMA)
assert.equal(publicApi.deleteBoundaryArtifact({ operation: "rest_request", target: "/wp/v2/posts/1", method: "DELETE" }).schema, DELETE_BOUNDARY_ARTIFACT_SCHEMA)
assert.equal(publicApi.sandboxIsolationProof({
  status: "passed",
  baseline: { status: "created", command: "wp-codebox.checkpoint-create" },
  mutation: { status: "mutated", command: "wordpress.rest-request" },
  runtimeBoundary: { backend: "wordpress-playground", environment: "wordpress", disposable: true, hostAccess: "declared-mounts-only", destroy: { status: "discarded" } },
  artifacts: [{ path: "files/sandbox-isolation/proof.json", kind: "sandbox-isolation-proof" }],
}).schema, SANDBOX_ISOLATION_PROOF_SCHEMA)
assert.equal(fuzzCoveragePlanContract({ id: "coverage-boundary" }).schema, FUZZ_COVERAGE_PLAN_SCHEMA)
assert.equal(fuzzFixturePlanContract({ id: "fixture-plan-boundary" }).schema, FUZZ_FIXTURE_PLAN_SCHEMA)
const runtimeBackedFuzzReadiness = fuzzRunnerReadinessContract(publicApi.RUNTIME_BACKED_FUZZ_SUITE_RUNNER_CAPABILITIES)
assert.equal(runtimeBackedFuzzReadiness.schema, FUZZ_RUNNER_READINESS_SCHEMA)
assert.equal(runtimeBackedFuzzReadiness.disposable, true)
assert.deepEqual(runtimeBackedFuzzReadiness.destructiveModeRequirements?.requiredSandboxBoundary, { disposable: true, destructivePermission: true, teardown: "discard" })
assert.equal(runtimeBackedFuzzReadiness.capabilities.capabilities.includes("disposable-runtime"), true)
assert.equal(runtimeBackedFuzzReadiness.capabilities.capabilities.includes("external-side-effect-guardrail"), true)
assert.equal(runtimeBackedFuzzReadiness.capabilities.capabilities.includes("artifact-export"), true)
const wordpressFuzzDescriptor = wordpressFuzzRuntimeContract()
assert.equal(wordpressFuzzDescriptor.schema, WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA)
assert.equal(wordpressFuzzDescriptor.publicSurfaces.phpFacade, "WP_Codebox_API::wordpress_fuzz_runtime_contract()")
assert.equal(wordpressFuzzDescriptor.publicSurfaces.ability, CODEBOX_RUN_FUZZ_SUITE_ABILITY)
assert.equal(wordpressFuzzDescriptor.publicSurfaces.nodeCli, "wp-codebox fuzz descriptor --format=json")
assert.deepEqual(wordpressFuzzDescriptor.destructiveModeRequirements.requiredSandboxBoundary, { disposable: true, destructivePermission: true, teardown: "discard" })
assert.deepEqual(wordpressFuzzDescriptor.destructiveModeRequirements.optionalResetModes, ["checkpoint-per-case", "restore-snapshot"])
assert.equal(wordpressFuzzDescriptor.destructiveModeRequirements.rawDeleteCapability, null)
assert.equal(wordpressFuzzDescriptor.actionFamilies.some((family) => family.runtimeActionTypes.includes("crud_operation")), true)
assert.equal(wordpressFuzzDescriptor.resetModes.some((mode) => mode.id === "restore-snapshot" && mode.supported === false), true)
assert.equal(wordpressFuzzDescriptor.artifactExpectations.some((artifact) => artifact.schema === "wp-codebox/delete-boundary-artifact/v1" && artifact.required), true)
assert.equal(wordpressFuzzDescriptor.unsupportedCapabilities.some((capability) => capability.id === "private-runtime-probing"), true)
assert.equal(wordpressFuzzDescriptor.hbex.schemaIds.descriptor, WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA)
assert.equal(wordpressFuzzDescriptor.hbex.schemaIds.restMutationGeneratedFixtures, REST_MUTATION_GENERATED_FIXTURES_SCHEMA)
assert.equal(publicApi.runtimeDescriptor().wordpressFuzzRuntimeContract.schema, WORDPRESS_FUZZ_RUNTIME_CONTRACT_SCHEMA)
assert.equal(publicApi.restMutationFixtureOptInContract({ id: "rest-mutation-opt-in", route: "/example/v1/items", methods: ["post", "DELETE"] }).schema, REST_MUTATION_FIXTURE_OPT_IN_SCHEMA)
assert.equal(publicApi.restMutationGeneratedFixturesContract({ id: "rest-mutation-generated", route: { route: "/example/v1/items", namespace: "example/v1", methods: ["POST"], argNames: [], endpoints: [{ methods: ["POST"], permission: { mode: "callback" }, args: [] }] } }).schema, REST_MUTATION_GENERATED_FIXTURES_SCHEMA)
assert.equal(fuzzSuiteContract({ id: "ability-boundary", cases: [{ id: "empty-input" }] }).schema, FUZZ_SUITE_SCHEMA)
assert.deepEqual(fuzzSuiteResultEnvelope({
  suite: { id: "ability-boundary" },
  cases: [
    { id: "empty-input", status: "passed", success: true, diagnostics: [], artifactRefs: [{ path: "fuzz/case.json", kind: "json" }] },
    { id: "bad-input", status: "failed", success: false, diagnostics: [{ severity: "error", message: "Rejected bad input." }] },
  ],
}).summary, { total: 2, passed: 1, failed: 1, error: 0, skipped: 0 })
assert.equal(fuzzSuiteResultEnvelope({ suite: { id: "ability-boundary" } }).schema, FUZZ_SUITE_RESULT_SCHEMA)
assert.equal(typeof playgroundPublicApi.runWordPressWpCli, "function")
assert.equal(typeof playgroundPublicApi.runWordPressPhp, "function")
assert.equal(typeof playgroundPublicApi.requestWordPressRest, "function")
assert.equal(typeof playgroundPublicApi.observeWordPressRestPerformance, "function")
assert.equal(typeof playgroundPublicApi.createWordPressRuntimeCheckpoint, "function")
assert.equal(typeof playgroundPublicApi.listWordPressRuntimeCheckpoints, "function")
assert.equal(typeof playgroundPublicApi.restoreWordPressRuntimeCheckpoint, "function")
assert.equal(typeof playgroundPublicApi.inventoryWordPressDatabase, "function")
assert.equal(typeof playgroundPublicApi.runWordPressBrowserAction, "function")
assert.equal(typeof playgroundPublicApi.probeWordPressBrowser, "function")
assert.equal(typeof playgroundPublicApi.openWordPressEditor, "function")
assert.equal(typeof playgroundPublicApi.collectWordPressArtifacts, "function")
assert.equal(RUNNER_WORKSPACE_BACKEND_FILTER, "wp_codebox_runner_workspace_backend")
assert.ok(RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS.includes("publish_runner_workspace"))
assert.match(runnerWorkspaceAdapter, new RegExp(escapeRegExp(RUNNER_WORKSPACE_BACKEND_FILTER)))
for (const key of RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS) {
  assert.match(runnerWorkspaceAdapter, new RegExp(escapeRegExp(key)), `PHP adapter must recognize backend ability key ${key}`)
}

console.log("public API contract ok")
