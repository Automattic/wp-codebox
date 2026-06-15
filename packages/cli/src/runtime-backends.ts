import { resolveRuntimeBackend, type RuntimeBackend, type RuntimeBackendFactoryContext, type RuntimeBackendKind } from "@automattic/wp-codebox-core"
import { playgroundRuntimeBackendProvider } from "@automattic/wp-codebox-playground"

const cliRuntimeBackendProviders = [playgroundRuntimeBackendProvider]

export function resolveCliRuntimeBackend(kind: RuntimeBackendKind, context?: RuntimeBackendFactoryContext): RuntimeBackend {
  return resolveRuntimeBackend(kind, cliRuntimeBackendProviders, context)
}
