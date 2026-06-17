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

export class RuntimeBackendRegistry {
  readonly #providers = new Map<RuntimeBackendKind, RuntimeBackendProvider>()

  constructor(providers: readonly RuntimeBackendProvider[] = []) {
    for (const provider of providers) {
      this.register(provider)
    }
  }

  register(provider: RuntimeBackendProvider): void {
    if (this.#providers.has(provider.kind)) {
      throw new Error(`Runtime backend provider is already registered: ${provider.kind}`)
    }

    this.#providers.set(provider.kind, provider)
  }

  list(): RuntimeBackendKind[] {
    return [...this.#providers.keys()]
  }

  resolve(kind: RuntimeBackendKind, context?: RuntimeBackendFactoryContext): RuntimeBackend {
    const provider = this.#providers.get(kind)
    if (!provider) {
      throw new Error(unsupportedRuntimeBackendMessage(kind, this.list()))
    }

    return provider.createBackend(context)
  }
}

export function createRuntimeBackendRegistry(providers: readonly RuntimeBackendProvider[] = []): RuntimeBackendRegistry {
  return new RuntimeBackendRegistry(providers)
}

export function resolveRuntimeBackend(kind: RuntimeBackendKind, providers: readonly RuntimeBackendProvider[], context?: RuntimeBackendFactoryContext): RuntimeBackend {
  return createRuntimeBackendRegistry(providers).resolve(kind, context)
}

function unsupportedRuntimeBackendMessage(kind: RuntimeBackendKind, knownKinds: readonly RuntimeBackendKind[]): string {
  const known = knownKinds.length > 0 ? knownKinds.join(", ") : "none"
  return `Unsupported runtime backend: ${kind}; known runtime backends: ${known}`
}
