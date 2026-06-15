import type { RuntimeBackend, RuntimeBackendKind } from "./runtime-contracts.js"

/**
 * Runtime-specific dependencies that backend providers may need while creating a backend.
 *
 * The core contract intentionally keeps these values opaque so CLI orchestration can pass
 * prepared backend-package modules through without importing a concrete backend directly.
 */
export interface RuntimeBackendFactoryContext {
  readonly cliModule?: unknown
}

export interface RuntimeBackendProvider {
  readonly kind: RuntimeBackendKind
  createBackend(context?: RuntimeBackendFactoryContext): RuntimeBackend
}

export function resolveRuntimeBackend(kind: RuntimeBackendKind, providers: readonly RuntimeBackendProvider[], context?: RuntimeBackendFactoryContext): RuntimeBackend {
  const provider = providers.find((candidate) => candidate.kind === kind)
  if (!provider) {
    throw new Error(`Unsupported runtime backend: ${kind}`)
  }

  return provider.createBackend(context)
}
