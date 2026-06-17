import assert from "node:assert/strict"
import { createRuntimeBackendRegistry, createWorkspaceRecipeJsonSchema, type RuntimeBackend, type RuntimeBackendProvider, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { cliRuntimeBackendRecipePolicy, listCliRecipeCommandDefinitions, listCliRuntimeBackendKinds, resolveCliRuntimeBackend } from "../packages/cli/src/runtime-backends.ts"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.ts"

const exampleBackend: RuntimeBackend = {
  kind: "example-backend",
  async create() {
    throw new Error("example backend should not create runtimes in registry smoke")
  },
}

const exampleProvider: RuntimeBackendProvider = {
  kind: "example-backend",
  recipePolicy: {
    recipeCommands: [{
      id: "example.recipe-command",
      description: "Example provider recipe command.",
      acceptedArgs: [],
      outputShape: "Example output.",
      policyRequirement: "Example policy.",
      recipe: true,
      handler: { kind: "recipe-alias", command: "example.recipe-command" },
    }],
    wordpressInstallModes: ["do-not-attempt-installing"],
  },
  createBackend() {
    return exampleBackend
  },
}

const registry = createRuntimeBackendRegistry([exampleProvider])

assert.deepEqual(registry.list(), ["example-backend"])
assert.equal(registry.resolve("example-backend"), exampleBackend)
assert.deepEqual(registry.recipeCommands().map((command) => command.id), ["example.recipe-command"])
assert.deepEqual(registry.recipePolicy().wordpressInstallModes, ["do-not-attempt-installing"])
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
assert.equal(listCliRecipeCommandDefinitions().some((command) => command.id === "wordpress.run-php"), true)
assert.deepEqual(cliRuntimeBackendRecipePolicy().runtimeOverlayLibraries, ["php-ai-client"])
assert.throws(
  () => resolveCliRuntimeBackend("missing-backend"),
  /Unsupported runtime backend: missing-backend; known runtime backends: wordpress-playground/,
)

const openSchema = createWorkspaceRecipeJsonSchema()
assert.deepEqual((openSchema as any).properties.runtime.properties.backend, { type: "string" })

const cliSchema = createWorkspaceRecipeJsonSchema({ runtimeBackendKinds: listCliRuntimeBackendKinds() })
assert.deepEqual((cliSchema as any).properties.runtime.properties.backend, { enum: ["wordpress-playground"] })

const cliPolicy = cliRuntimeBackendRecipePolicy()
const cliProviderSchema = createWorkspaceRecipeJsonSchema({
  recipeCommandIds: listCliRecipeCommandDefinitions().map((command) => command.id),
  runtimeBackendKinds: listCliRuntimeBackendKinds(),
  runtimeWordPressInstallModes: cliPolicy.wordpressInstallModes,
  runtimeOverlayKinds: cliPolicy.runtimeOverlayKinds,
  runtimeOverlayLibraries: cliPolicy.runtimeOverlayLibraries,
  runtimeOverlayStrategies: cliPolicy.runtimeOverlayStrategies,
})
assert.deepEqual((cliProviderSchema as any).properties.runtime.properties.wordpressInstallMode.enum, ["install-from-existing-files", "install-from-existing-files-if-needed", "do-not-attempt-installing"])
assert.deepEqual((cliProviderSchema as any).$defs.runtimeOverlay.oneOf[0].properties.library, { enum: ["php-ai-client"] })

const customBackendRecipe: WorkspaceRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: { backend: "example-backend" },
  workflow: { steps: [{ command: "host/example" }] },
}
const validationIssues = await validateWorkspaceRecipeSemantics(customBackendRecipe, "/tmp/example-recipe.json")
assert.deepEqual(validationIssues, [])
