import { createRuntimeBackendRegistry, runtimeBackendRecipeAliases, type RuntimeBackend, type RuntimeBackendFactoryContext, type RuntimeBackendKind, type RuntimeBackendRecipePolicy } from "@automattic/wp-codebox-core"
import type { CommandDefinition } from "@automattic/wp-codebox-core/contracts"
import { playgroundRuntimeBackendProvider } from "@automattic/wp-codebox-playground"
import { nativeRuntimeBackendProvider } from "@automattic/wp-codebox-native"

const cliRuntimeBackendRegistry = createRuntimeBackendRegistry([playgroundRuntimeBackendProvider, nativeRuntimeBackendProvider])

export function listCliRuntimeBackendKinds(): RuntimeBackendKind[] {
  return cliRuntimeBackendRegistry.list().flatMap((kind) => [kind, ...runtimeBackendRecipeAliases(kind)])
}

export function cliRuntimeBackendRecipePolicy(): Required<RuntimeBackendRecipePolicy> {
  return cliRuntimeBackendRegistry.recipePolicy()
}

export function listCliRecipeCommandDefinitions(): CommandDefinition[] {
  return cliRuntimeBackendRegistry.recipeCommands()
}

export function listCliRecipeCommandIds(): string[] {
  return listCliRecipeCommandDefinitions().map((command) => command.id)
}

export function resolveCliRuntimeBackend(kind: RuntimeBackendKind, context?: RuntimeBackendFactoryContext): RuntimeBackend {
  return cliRuntimeBackendRegistry.resolve(kind, context)
}
