import { createWorkspaceRecipeJsonSchema, runtimeDescriptor, type RuntimeDescriptor, type WorkspaceRecipeJsonSchema } from "@automattic/wp-codebox-core"
import { commandRegistry, type CommandDefinition } from "@automattic/wp-codebox-core/contracts"
import { printCommandCatalogHumanOutput, printRecipeSchemaHumanOutput, printRuntimeDescriptorHumanOutput } from "../output.js"
import { cliRuntimeBackendRecipePolicy, listCliRecipeCommandDefinitions, listCliRuntimeBackendKinds } from "../runtime-backends.js"
import { nativeMariaDbHostReadiness, settleNativeMariaDbHostReadiness } from "../runtime-services.js"
import { playwrightBrowserReadiness } from "@automattic/wp-codebox-playground"

const RUNTIME_DESCRIPTOR_TIMEOUT_MS = 120_000
const RUNTIME_DESCRIPTOR_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]

interface RuntimeDescriptorSignalTarget {
  on(signal: NodeJS.Signals, handler: () => void): unknown
  off(signal: NodeJS.Signals, handler: () => void): unknown
}

type RuntimeDescriptorInterruption = NodeJS.Signals | "timeout"

export class RuntimeDescriptorInterruptedError extends Error {
  constructor(readonly interruption: RuntimeDescriptorInterruption, readonly exitCode: number) {
    super(interruption === "timeout" ? "Runtime descriptor discovery timed out" : `Runtime descriptor discovery interrupted by ${interruption}`)
    this.name = "RuntimeDescriptorInterruptedError"
  }
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

export async function runRuntimeDescriptorCommand(args: string[], options: { descriptorOutput?: (signal: AbortSignal) => Promise<RuntimeDescriptor>; signalTarget?: RuntimeDescriptorSignalTarget; timeoutMs?: number } = {}): Promise<number> {
  const json = parseDiscoveryJsonOption(args)
  let output: RuntimeDescriptor
  try {
    output = await withRuntimeDescriptorInterruption(options.descriptorOutput ?? runtimeDescriptorOutput, options.signalTarget, options.timeoutMs)
  } catch (error) {
    if (error instanceof RuntimeDescriptorInterruptedError) return error.exitCode
    throw error
  }
  if (!json) {
    printRuntimeDescriptorHumanOutput(output)
    return 0
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return 0
}

export async function withRuntimeDescriptorInterruption<T>(run: (signal: AbortSignal) => Promise<T>, target: RuntimeDescriptorSignalTarget = process, timeoutMs = RUNTIME_DESCRIPTOR_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  let interruption: RuntimeDescriptorInterruption | undefined
  const interrupt = (signal: NodeJS.Signals) => { interruption ??= signal; controller.abort() }
  const timeout = () => { interruption ??= "timeout"; controller.abort() }
  const handlers = new Map(RUNTIME_DESCRIPTOR_SIGNALS.map((signal) => [signal, () => interrupt(signal)] as const))
  for (const [signal, handler] of handlers) target.on(signal, handler)
  const timer = setTimeout(timeout, timeoutMs)
  try {
    const result = await run(controller.signal)
    if (interruption) throw runtimeDescriptorInterruptedError(interruption)
    return result
  } catch (error) {
    if (interruption) throw runtimeDescriptorInterruptedError(interruption)
    throw error
  } finally {
    clearTimeout(timer)
    for (const [signal, handler] of handlers) target.off(signal, handler)
  }
}

function runtimeDescriptorInterruptedError(interruption: RuntimeDescriptorInterruption): RuntimeDescriptorInterruptedError {
  const signalExitCodes: Record<NodeJS.Signals, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as Record<NodeJS.Signals, number>
  return new RuntimeDescriptorInterruptedError(interruption, interruption === "timeout" ? 124 : signalExitCodes[interruption])
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
  const nativeMariaDb = await nativeMariaDbHostReadiness(undefined, signal)
  if (signal.aborted) {
    await settleNativeMariaDbHostReadiness()
    throw new Error("Runtime descriptor discovery interrupted")
  }
  const browserRuntime = await playwrightBrowserReadiness({ signal })
  if (signal.aborted) throw new Error("Runtime descriptor discovery interrupted")
  return runtimeDescriptor({ nativeMariaDb, browserRuntime })
}
