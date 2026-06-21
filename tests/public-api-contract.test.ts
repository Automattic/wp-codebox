import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  artifactBundleFileManifest,
  buildRuntimePackageRunRecipe,
  browserArtifactPersistenceProjection,
  browserRunResultEnvelope,
  normalizeBrowserRunResult,
  runtimePackageExecutionInput,
  persistedBrowserArtifactRefs,
  RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS,
  RUNNER_WORKSPACE_BACKEND_FILTER,
} from "../packages/runtime-core/src/public.js"

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
const publicBarrel = await readFile(new URL("packages/runtime-core/src/public.ts", root), "utf8")
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
  "Browser task and contained site",
  "Browser SDK",
  "Browser metrics",
  "Artifacts",
  "Inspect",
]) {
  assert.match(docs, new RegExp(`\\*\\*${contractArea}:\\*\\*`), `docs must define ${contractArea}`)
}

for (const publicModule of [
  "./agent-runtime-workload.js",
  "./artifact-result-envelope.js",
  "./browser-callback-contracts.js",
  "./recipe-builders.js",
  "./runtime-contracts.js",
  "./runtime-episode.js",
  "./runtime-package-execution.js",
  "./wordpress-workload-primitives.js",
]) {
  assert.ok(publicBarrel.includes(`export * from "${publicModule}"`), `public barrel must export ${publicModule}`)
}

for (const internalModule of [
  "./benchmark-substrate.js",
  "./fanout-aggregation.js",
  "./object-utils.js",
  "./prepared-source-staging.js",
  "./runtime-action-adapter.js",
]) {
  assert.ok(!publicBarrel.includes(`export * from "${internalModule}"`), `public barrel must not export ${internalModule}`)
}

assert.match(docs, /@automattic\/wp-codebox-core\/internals` exists for this monorepo's package split/)
assert.match(docs, /not a stable compatibility surface for external integrations/)
assert.match(docs, /New external TypeScript\s+consumers should prefer/)
assert.match(docs, /## Integration Boundary/)
assert.match(docs, /Codebox may adapt those upstream systems into\s+generic Codebox inputs internally/)
assert.match(docs, /Data Machine must not parse, validate, or emit\s+WP Codebox-specific schemas as a compatibility requirement/)
assert.match(docs, /Codebox adapter translates from generic\s+Data Machine inputs into the Codebox task\/recipe\/runtime contracts/)
assert.match(docs, /RUNNER_WORKSPACE_BACKEND_FILTER/)
assert.match(docs, /RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS/)
assert.match(docs, /RunnerWorkspaceBackendConfig/)

assert.equal(typeof normalizeBrowserRunResult, "function")
assert.equal(typeof browserRunResultEnvelope, "function")
assert.equal(typeof browserArtifactPersistenceProjection, "function")
assert.equal(typeof persistedBrowserArtifactRefs, "function")
assert.equal(typeof artifactBundleFileManifest, "function")
assert.equal(typeof buildRuntimePackageRunRecipe, "function")
assert.equal(typeof runtimePackageExecutionInput, "function")
assert.equal(RUNNER_WORKSPACE_BACKEND_FILTER, "wp_codebox_runner_workspace_backend")
assert.ok(RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS.includes("publish_runner_workspace"))
assert.match(runnerWorkspaceAdapter, new RegExp(escapeRegExp(RUNNER_WORKSPACE_BACKEND_FILTER)))
for (const key of RUNNER_WORKSPACE_BACKEND_ABILITY_KEYS) {
  assert.match(runnerWorkspaceAdapter, new RegExp(escapeRegExp(key)), `PHP adapter must recognize backend ability key ${key}`)
}

console.log("public API contract ok")
