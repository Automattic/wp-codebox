import assert from "node:assert/strict"

import { normalizeRuntimeWordPressEnvironmentSpec, validateWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { resolveRecipeRuntimeExtensionManifests } from "../packages/cli/src/commands/recipe-run.js"
import { assertPhpWasmExternalExtensionsSupported, PhpWasmExternalExtensionCapabilityError } from "../packages/runtime-playground/src/php-wasm-preflight.js"
import { programmaticNodeRuntimeOptions } from "../packages/runtime-playground/src/programmatic-playground-runner.js"

const recipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { extensions: [{ manifest: "extensions/parser/manifest.json" }] },
  workflow: { steps: [{ command: "wordpress.run-php" }] },
}

assert.equal(validateWorkspaceRecipeJsonSchema(recipe).valid, true)
assert.equal(validateWorkspaceRecipeJsonSchema({ ...recipe, runtime: { extensions: [{ manifest: "", unexpected: true }] } }).valid, false)
assert.deepEqual(normalizeRuntimeWordPressEnvironmentSpec({ kind: "wordpress", extensions: recipe.runtime?.extensions }), { kind: "wordpress", extensions: [{ manifest: "extensions/parser/manifest.json" }] })

const resolved = resolveRecipeRuntimeExtensionManifests(recipe, "/tmp/recipe")
assert.deepEqual(resolved, [{ manifest: "/tmp/recipe/extensions/parser/manifest.json" }])
assert.throws(() => resolveRecipeRuntimeExtensionManifests({ ...recipe, runtime: { extensions: [{ manifest: "../manifest.json" }] } }, "/tmp/recipe"), /outside the recipe directory/)

const runtimeSpec = {
  backend: "wordpress-playground",
  environment: { kind: "wordpress", extensions: resolved },
  policy: { network: "deny", filesystem: "readwrite-mounts", commands: [], secrets: "none", approvals: "never" },
} as const
const firstInstance = programmaticNodeRuntimeOptions(runtimeSpec, 1)
const pooledInstance = programmaticNodeRuntimeOptions(runtimeSpec, 2)
assert.deepEqual(firstInstance.extensions, [{ source: { format: "manifest", manifestUrl: "/tmp/recipe/extensions/parser/manifest.json" } }])
assert.deepEqual(pooledInstance.extensions, firstInstance.extensions)
assert.equal(firstInstance.emscriptenOptions.processId, 1)
assert.equal(pooledInstance.emscriptenOptions.processId, 2)

await assert.rejects(
  assertPhpWasmExternalExtensionsSupported(resolved, "asyncify"),
  (error: unknown) => error instanceof PhpWasmExternalExtensionCapabilityError && error.message.includes("JSPI") && error.diagnostic.selectedMode === "asyncify",
)
await assert.doesNotReject(assertPhpWasmExternalExtensionsSupported(resolved, "jspi"))

console.log("php wasm extension manifests ok")
