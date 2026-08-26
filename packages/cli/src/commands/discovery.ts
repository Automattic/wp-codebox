import { createWorkspaceRecipeJsonSchema, runtimeDescriptor, type RuntimeDescriptor, type WorkspaceRecipeJsonSchema } from "@automattic/wp-codebox-core"
import { commandRegistry, type CommandDefinition } from "@automattic/wp-codebox-core/contracts"
import { printCommandCatalogHumanOutput, printRecipeSchemaHumanOutput, printRuntimeDescriptorHumanOutput } from "../output.js"
import { cliRuntimeBackendRecipePolicy, listCliRecipeCommandDefinitions, listCliRuntimeBackendKinds } from "../runtime-backends.js"
import { nativeMariaDbHostReadiness } from "../runtime-services.js"
import { playwrightBrowserReadiness } from "@automattic/wp-codebox-playground"

const RUNTIME_DESCRIPTOR_TIMEOUT_MS = 120_000
const RUNTIME_DESCRIPTOR_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]

interface RuntimeDescriptorSignalTarget {
  on(signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void): unknown
  off(signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void): unknown
}

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

export async function runRuntimeDescriptorCommand(args: string[]): Promise<number> {
  const json = parseDiscoveryJsonOption(args)
  const output = await withRuntimeDescriptorInterruption((signal) => runtimeDescriptorOutput(signal))
  if (!json) {
    printRuntimeDescriptorHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

export async function withRuntimeDescriptorInterruption<T>(run: (signal: AbortSignal) => Promise<T>, target: RuntimeDescriptorSignalTarget = process, timeoutMs = RUNTIME_DESCRIPTOR_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  for (const signal of RUNTIME_DESCRIPTOR_SIGNALS) target.on(signal, interrupt)
  const timer = setTimeout(interrupt, timeoutMs)
  timer.unref()
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    for (const signal of RUNTIME_DESCRIPTOR_SIGNALS) target.off(signal, interrupt)
  }
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

const PRODUCT_HIDDEN_ARGS: Record<string, Set<string>> = {
  "wp-codebox.agent-sandbox-run": new Set(["code", "code-file"]),
}

export function commandCatalogOutput(): CommandCatalogOutput {
  const commands = new Map<string, Omit<CommandDefinition, "handler">>()
  for (const { handler, ...metadata } of commandRegistry.filter((command) => command.recipe === false)) {
    commands.set(metadata.id, productCatalogCommand(metadata))
  }
  for (const { handler, ...metadata } of listCliRecipeCommandDefinitions()) {
    commands.set(metadata.id, productCatalogCommand(metadata))
  }

  return {
    schema: "wp-codebox/command-catalog/v1",
    commands: [...commands.values()],
  }
}

function productCatalogCommand(command: Omit<CommandDefinition, "handler">): Omit<CommandDefinition, "handler"> {
  const hiddenArgs = PRODUCT_HIDDEN_ARGS[command.id]
  if (!hiddenArgs) return command

  return {
    ...command,
    acceptedArgs: command.acceptedArgs.filter((arg) => !hiddenArgs.has(arg.name)),
  }
}

function recipeSchemaOutput(): RecipeSchemaOutput {
  const recipePolicy = cliRuntimeBackendRecipePolicy()
  return {
    schema: "wp-codebox/json-schema/v1",
    id: "wp-codebox/workspace-recipe/v1",
    jsonSchema: createWorkspaceRecipeJsonSchema({
      recipeCommandIds: listCliRecipeCommandDefinitions().map((command) => command.id),
      runtimeBackendKinds: listCliRuntimeBackendKinds(),
      runtimeWordPressInstallModes: recipePolicy.wordpressInstallModes,
      runtimeOverlayKinds: recipePolicy.runtimeOverlayKinds,
      runtimeOverlayLibraries: recipePolicy.runtimeOverlayLibraries,
      runtimeOverlayStrategies: recipePolicy.runtimeOverlayStrategies,
    }),
  }
}

async function runtimeDescriptorOutput(signal: AbortSignal): Promise<RuntimeDescriptor> {
  return runtimeDescriptor({ nativeMariaDb: await nativeMariaDbHostReadiness(undefined, signal), browserRuntime: await playwrightBrowserReadiness() })
}
