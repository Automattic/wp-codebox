import { createWorkspaceRecipeJsonSchema, type WorkspaceRecipeJsonSchema } from "@automattic/wp-codebox-core"
import { commandRegistry, recipeCommandDefinitions, type CommandDefinition } from "@automattic/wp-codebox-core/contracts"
import { printCommandCatalogHumanOutput, printRecipeSchemaHumanOutput } from "../output.js"

interface CommandCatalogOutput {
  schema: "wp-codebox/command-catalog/v1"
  commands: Array<Omit<CommandDefinition, "handler">>
}

interface RecipeSchemaOutput {
  schema: "wp-codebox/json-schema/v1"
  id: "wp-codebox/workspace-recipe/v1"
  jsonSchema: WorkspaceRecipeJsonSchema
}

export async function runCommandsCommand(args: string[]): Promise<number> {
  const json = parseDiscoveryJsonOption(args)
  const output = commandCatalogOutput()
  if (!json) {
    printCommandCatalogHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

export async function runRecipeSchemaCommand(args: string[]): Promise<number> {
  const json = parseDiscoveryJsonOption(args)
  const output = recipeSchemaOutput()
  if (!json) {
    printRecipeSchemaHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

function parseDiscoveryJsonOption(args: string[]): boolean {
  let json = false
  for (const arg of args) {
    if (arg === "--json") {
      json = true
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  return json
}

function commandCatalogOutput(): CommandCatalogOutput {
  return {
    schema: "wp-codebox/command-catalog/v1",
    commands: commandRegistry.map(({ handler, ...metadata }) => metadata),
  }
}

function recipeSchemaOutput(): RecipeSchemaOutput {
  return {
    schema: "wp-codebox/json-schema/v1",
    id: "wp-codebox/workspace-recipe/v1",
    jsonSchema: createWorkspaceRecipeJsonSchema({
      recipeCommandIds: recipeCommandDefinitions().map((command) => command.id),
    }),
  }
}
