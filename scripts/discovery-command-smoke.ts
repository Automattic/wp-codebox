import { resolve } from "node:path"
import { createWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "@automattic/wp-codebox-core"
import { commandRegistry, recipeCommandDefinitions } from "@automattic/wp-codebox-core/contracts"
import Ajv2020 from "ajv/dist/2020.js"
import { listCliRuntimeBackendKinds } from "../packages/cli/src/runtime-backends.js"
import { readJson, repoRoot, runCliJson, runCliText } from "./test-kit.ts"

interface CommandCatalogOutput {
  schema: "wp-codebox/command-catalog/v1"
  commands: Array<{
    id: string
    description: string
    acceptedArgs: Array<{ name: string; description: string; required?: boolean; repeatable?: boolean; format?: string }>
    outputShape: string
    policyRequirement: string
    recipe: boolean
  }>
}

interface RecipeSchemaOutput {
  schema: "wp-codebox/json-schema/v1"
  id: "wp-codebox/workspace-recipe/v1"
  jsonSchema: Record<string, unknown>
}

// Registry metadata is the source of truth for discovery and recipe help.
const expectedCommandIds = recipeCommandDefinitions().map((command) => command.id)
const expectedCatalogCommandIds = commandRegistry.map((command) => command.id)

const representativeRecipes = [
  {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      extra_plugins: [{
        source: "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
        pluginFile: "bbpress/bbpress.php",
        activate: false,
      }],
      secretEnv: ["OPENAI_API_KEY"],
      inherit: { connectors: ["primary-ai"], settings: ["site-defaults"] },
      inheritance: {
        connectors: [{ name: "primary-ai", status: "resolved", provider: "openai", model: "gpt-5.5", providerPluginPaths: ["/tmp/ai-provider-test"], secretEnv: ["OPENAI_API_KEY"] }],
        settings: [{ name: "site-defaults", status: "resolved", scope: "site" }],
      },
    },
    workflow: { steps: [{ command: "wp-codebox.agent-sandbox-run", args: ["task=Cook dinner"] }] },
  },
  {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      workspaces: [{ target: "/wordpress/wp-content/plugins/demo", mode: "readwrite", sourceMode: "repo-backed", seed: { type: "plugin_scaffold", slug: "demo" } }],
      stagedFiles: [{ source: "fixtures/demo.php", target: "/wordpress/wp-content/plugins/demo/demo.php" }],
      siteSeeds: [{ type: "fixture", name: "demo-content", source: "fixtures/content.json", format: "json", scopes: { posts: { postTypes: ["post"], maxRecords: 3 } } }],
    },
    workflow: {
      before: [{ command: "inspect-mounted-inputs" }],
      steps: [{ command: "wordpress.wp-cli", args: ["command=plugin list --format=json"] }],
      after: [{ command: "wordpress.run-php", args: ["code=<?php echo 'done';"] }],
    },
    artifacts: { directory: "./artifacts", verify: { enabled: true, strict: true }, workspacePolicy: { enabled: true, writableRoots: ["/wordpress/wp-content/plugins/demo"] } },
  },
] satisfies WorkspaceRecipe[]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function main(): Promise<void> {
  const catalog = await runCliJson<CommandCatalogOutput>(["commands", "--json"])
  assert(catalog.schema === "wp-codebox/command-catalog/v1", "Unexpected command catalog schema")
  assert(JSON.stringify(catalog.commands.map((command) => command.id)) === JSON.stringify(expectedCatalogCommandIds), "Command ids changed unexpectedly")

  for (const command of catalog.commands) {
    assert(command.description.length > 0, `${command.id} is missing description`)
    assert(Array.isArray(command.acceptedArgs), `${command.id} acceptedArgs must be an array`)
    assert(command.outputShape.length > 0, `${command.id} is missing outputShape`)
    assert(command.policyRequirement.length > 0, `${command.id} is missing policyRequirement`)
  }

  const wpCli = catalog.commands.find((command) => command.id === "wordpress.wp-cli")
  assert(wpCli?.acceptedArgs.some((arg) => arg.name === "command" && arg.required), "wordpress.wp-cli must document required command arg")
  const themeCheck = catalog.commands.find((command) => command.id === "wordpress.theme-check")
  assert(themeCheck?.acceptedArgs.some((arg) => arg.name === "theme" && arg.required), "wordpress.theme-check must document required theme arg")

  const pluginCheck = catalog.commands.find((command) => command.id === "wordpress.plugin-check")
  assert(pluginCheck?.acceptedArgs.some((arg) => arg.name === "plugin-slug" && arg.required), "wordpress.plugin-check must document required plugin-slug arg")

  const help = await runCliText(["--help"])
  const recipeHelp = help.slice(help.indexOf("Recipe commands:"))
  assert(recipeHelp.startsWith("Recipe commands:"), "Help output must include generated recipe command section")
  for (const commandId of expectedCommandIds) {
    assert(recipeHelp.includes(`  ${commandId}\n`) || recipeHelp.includes(`  ${commandId}`), `Help output is missing recipe command: ${commandId}`)
  }

  const schemaOutput = await runCliJson<RecipeSchemaOutput>(["schema", "recipe", "--json"])
  assert(schemaOutput.schema === "wp-codebox/json-schema/v1", "Unexpected recipe schema envelope")
  assert(schemaOutput.id === "wp-codebox/workspace-recipe/v1", "Unexpected recipe schema id")
  assert(
    JSON.stringify(schemaOutput.jsonSchema) === JSON.stringify(createWorkspaceRecipeJsonSchema({ recipeCommandIds: expectedCommandIds, runtimeBackendKinds: listCliRuntimeBackendKinds() })),
    "CLI recipe schema must come from the shared runtime-core schema factory"
  )

  const ajv = new Ajv2020({ strict: false })
  const validate = ajv.compile(schemaOutput.jsonSchema)
  for (const recipePath of [
    "examples/recipes/simple-plugin.json",
    "examples/recipes/seeded-plugin-workspace.json",
    "examples/recipes/bench-plugin.json",
    "examples/recipes/cookbook/seeded-content.json",
  ]) {
    const recipe = await readJson(resolve(repoRoot, recipePath))
    assert(validate(recipe), `${recipePath} does not validate against discovery schema: ${ajv.errorsText(validate.errors)}`)
  }

  for (const recipe of representativeRecipes) {
    assert(validate(recipe), `representative recipe does not validate against discovery schema: ${ajv.errorsText(validate.errors)}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
