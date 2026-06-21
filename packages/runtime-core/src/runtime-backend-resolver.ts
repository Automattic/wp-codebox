import type { CommandDefinition } from "./command-registry.js"
import type { RuntimeBackend, RuntimeBackendKind } from "./runtime-contracts.js"

export const WORDPRESS_RUNTIME_BACKEND_KIND = "wordpress-playground" as const
export const WORDPRESS_RUNTIME_BACKEND_ALIAS = "wordpress" as const

/**
 * Runtime-specific dependencies that backend providers may need while creating a backend.
 *
 * The core contract intentionally keeps these values opaque so CLI orchestration can pass
 * prepared backend-package modules through without importing a concrete backend directly.
 */
export interface RuntimeBackendFactoryContext {
  readonly cliModule?: unknown
}

export interface RuntimeBackendRecipePolicy {
  readonly recipeCommands?: readonly CommandDefinition[]
  readonly wordpressInstallModes?: readonly string[]
  readonly runtimeOverlayKinds?: readonly string[]
  readonly runtimeOverlayLibraries?: readonly string[]
  readonly runtimeOverlayStrategies?: readonly string[]
}

export interface RuntimeBackendProvider {
  readonly kind: RuntimeBackendKind
  readonly recipePolicy?: RuntimeBackendRecipePolicy
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

    for (const command of provider.recipePolicy?.recipeCommands ?? []) {
      const existingProvider = this.providers().find((registeredProvider) => registeredProvider.recipePolicy?.recipeCommands?.some((registeredCommand) => registeredCommand.id === command.id))
      if (existingProvider) {
        throw new Error(`Runtime backend recipe command is already registered: ${command.id}`)
      }
    }

    this.#providers.set(provider.kind, provider)
  }

  list(): RuntimeBackendKind[] {
    return [...this.#providers.keys()]
  }

  resolve(kind: RuntimeBackendKind, context?: RuntimeBackendFactoryContext): RuntimeBackend {
    const provider = this.#providers.get(normalizeRuntimeBackendKind(kind))
    if (!provider) {
      throw new Error(unsupportedRuntimeBackendMessage(kind, this.list()))
    }

    return provider.createBackend(context)
  }

  recipeCommands(): CommandDefinition[] {
    return this.providers().flatMap((provider) => [...(provider.recipePolicy?.recipeCommands ?? [])])
  }

  recipePolicy(): Required<RuntimeBackendRecipePolicy> {
    return {
      recipeCommands: this.recipeCommands(),
      wordpressInstallModes: uniquePolicyValues(this.providers().flatMap((provider) => provider.recipePolicy?.wordpressInstallModes ?? [])),
      runtimeOverlayKinds: uniquePolicyValues(this.providers().flatMap((provider) => provider.recipePolicy?.runtimeOverlayKinds ?? [])),
      runtimeOverlayLibraries: uniquePolicyValues(this.providers().flatMap((provider) => provider.recipePolicy?.runtimeOverlayLibraries ?? [])),
      runtimeOverlayStrategies: uniquePolicyValues(this.providers().flatMap((provider) => provider.recipePolicy?.runtimeOverlayStrategies ?? [])),
    }
  }

  private providers(): RuntimeBackendProvider[] {
    return [...this.#providers.values()]
  }
}

export function createRuntimeBackendRegistry(providers: readonly RuntimeBackendProvider[] = []): RuntimeBackendRegistry {
  return new RuntimeBackendRegistry(providers)
}

export function resolveRuntimeBackend(kind: RuntimeBackendKind, providers: readonly RuntimeBackendProvider[], context?: RuntimeBackendFactoryContext): RuntimeBackend {
  return createRuntimeBackendRegistry(providers).resolve(kind, context)
}

export function normalizeRuntimeBackendKind(kind: RuntimeBackendKind | undefined | null): RuntimeBackendKind {
  const normalized = typeof kind === "string" ? kind.trim() : ""
  if (!normalized || normalized === WORDPRESS_RUNTIME_BACKEND_ALIAS) {
    return WORDPRESS_RUNTIME_BACKEND_KIND
  }

  return normalized as RuntimeBackendKind
}

export function runtimeBackendRecipeAliases(kind: RuntimeBackendKind): RuntimeBackendKind[] {
  return kind === WORDPRESS_RUNTIME_BACKEND_KIND ? [WORDPRESS_RUNTIME_BACKEND_ALIAS] : []
}

function unsupportedRuntimeBackendMessage(kind: RuntimeBackendKind, knownKinds: readonly RuntimeBackendKind[]): string {
  const known = knownKinds.length > 0 ? knownKinds.join(", ") : "none"
  return `Unsupported runtime backend: ${kind}; known runtime backends: ${known}`
}

function uniquePolicyValues<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
