import { createRuntimeBackendRegistry, type RuntimeBackend, type RuntimeBackendFactoryContext, type RuntimeBackendKind } from "@automattic/wp-codebox-core"
import { playgroundRuntimeBackendProvider } from "@automattic/wp-codebox-playground"

const cliRuntimeBackendRegistry = createRuntimeBackendRegistry([playgroundRuntimeBackendProvider])

export function listCliRuntimeBackendKinds(): RuntimeBackendKind[] {
  return cliRuntimeBackendRegistry.list()
}

export function resolveCliRuntimeBackend(kind: RuntimeBackendKind, context?: RuntimeBackendFactoryContext): RuntimeBackend {
  return cliRuntimeBackendRegistry.resolve(kind, context)
}
