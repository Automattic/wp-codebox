import assert from "node:assert/strict"
import { createRuntimeBackendRegistry, createWorkspaceRecipeJsonSchema, type RuntimeBackend, type RuntimeBackendProvider, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { listCliRuntimeBackendKinds, resolveCliRuntimeBackend } from "../packages/cli/src/runtime-backends.ts"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.ts"

const exampleBackend: RuntimeBackend = {
  kind: "example-backend",
  async create() {
    throw new Error("example backend should not create runtimes in registry smoke")
  },
}

const exampleProvider: RuntimeBackendProvider = {
  kind: "example-backend",
  createBackend() {
    return exampleBackend
  },
}

const registry = createRuntimeBackendRegistry([exampleProvider])

assert.deepEqual(registry.list(), ["example-backend"])
assert.equal(registry.resolve("example-backend"), exampleBackend)
assert.throws(
  () => registry.register(exampleProvider),
  /Runtime backend provider is already registered: example-backend/,
)
assert.throws(
  () => registry.resolve("missing-backend"),
  /Unsupported runtime backend: missing-backend; known runtime backends: example-backend/,
)

assert.deepEqual(listCliRuntimeBackendKinds(), ["wordpress-playground"])
assert.equal(resolveCliRuntimeBackend("wordpress-playground").kind, "wordpress-playground")
assert.throws(
  () => resolveCliRuntimeBackend("missing-backend"),
  /Unsupported runtime backend: missing-backend; known runtime backends: wordpress-playground/,
)

const openSchema = createWorkspaceRecipeJsonSchema()
assert.deepEqual((openSchema as any).properties.runtime.properties.backend, { type: "string" })

const cliSchema = createWorkspaceRecipeJsonSchema({ runtimeBackendKinds: listCliRuntimeBackendKinds() })
assert.deepEqual((cliSchema as any).properties.runtime.properties.backend, { enum: ["wordpress-playground"] })

const customBackendRecipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { backend: "example-backend" },
  workflow: { steps: [{ command: "host/example" }] },
}
const validationIssues = await validateWorkspaceRecipeSemantics(customBackendRecipe, "/tmp/example-recipe.json")
assert.deepEqual(validationIssues, [])
