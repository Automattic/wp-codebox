import { assertRuntimeEnvName } from "@automattic/wp-codebox-core"

export const SECRET_ENV_PROJECTIONS_ENV = "WP_CODEBOX_SECRET_ENV_PROJECTIONS"

export interface RecipeSecretEnvProviderContext {
  readonly source: Record<string, string | undefined>
}

export interface RecipeSecretEnvProviderResult {
  readonly value?: string
  readonly source: string
}

export type RecipeSecretEnvProvider = (name: string, context: RecipeSecretEnvProviderContext) => RecipeSecretEnvProviderResult | undefined

export interface RecipeSecretEnvSummaryEntry {
  name: string
  status: "available" | "missing"
  source?: string
}

export interface RecipeSecretEnvResolution {
  values: Record<string, string>
  summary: RecipeSecretEnvSummaryEntry[]
}

export interface ResolveRecipeSecretEnvOptions {
  source?: Record<string, string | undefined>
  providers?: readonly RecipeSecretEnvProvider[]
  field?: string
}

type SecretEnvProjectionSpec = Record<string, string> | Array<{ name?: unknown; from?: unknown }>

export function resolveRecipeSecretEnv(names: readonly string[], options: ResolveRecipeSecretEnvOptions = {}): RecipeSecretEnvResolution {
  const source = options.source ?? process.env
  const providers = options.providers ?? defaultRecipeSecretEnvProviders(source)
  const field = options.field ?? "secretEnv"
  const values: Record<string, string> = {}
  const summary: RecipeSecretEnvSummaryEntry[] = []

  for (const rawName of names) {
    const name = rawName.trim()
    assertRuntimeEnvName(name, field)
    const result = resolveFromProviders(name, providers, { source })
    if (result?.value !== undefined) {
      values[name] = result.value
      summary.push({ name, status: "available", source: result.source })
      continue
    }
    summary.push({ name, status: "missing" })
  }

  return { values, summary }
}

export function defaultRecipeSecretEnvProviders(source: Record<string, string | undefined> = process.env): RecipeSecretEnvProvider[] {
  return [
    directProcessEnvSecretProvider,
    projectionSecretEnvProvider(parseSecretEnvProjections(source[SECRET_ENV_PROJECTIONS_ENV])),
  ]
}

export const directProcessEnvSecretProvider: RecipeSecretEnvProvider = (name, context) => {
  const value = context.source[name]
  return value === undefined ? undefined : { value, source: "process-env" }
}

export function projectionSecretEnvProvider(projections: ReadonlyMap<string, string>): RecipeSecretEnvProvider {
  return (name, context) => {
    const sourceName = projections.get(name)
    if (!sourceName) {
      return undefined
    }
    const value = context.source[sourceName]
    return value === undefined ? undefined : { value, source: "env-projection" }
  }
}

export function parseSecretEnvProjections(raw: string | undefined): ReadonlyMap<string, string> {
  if (!raw?.trim()) {
    return new Map()
  }

  const parsed = JSON.parse(raw) as SecretEnvProjectionSpec
  const entries = Array.isArray(parsed)
    ? parsed.map((entry) => [entry.name, entry.from])
    : Object.entries(parsed)
  const projections = new Map<string, string>()

  for (const [rawName, rawFrom] of entries) {
    if (typeof rawName !== "string" || typeof rawFrom !== "string") {
      throw new Error(`${SECRET_ENV_PROJECTIONS_ENV} entries must map secret env names to source env names`)
    }
    const name = rawName.trim()
    const from = rawFrom.trim()
    assertRuntimeEnvName(name, SECRET_ENV_PROJECTIONS_ENV)
    assertRuntimeEnvName(from, SECRET_ENV_PROJECTIONS_ENV)
    projections.set(name, from)
  }

  return projections
}

function resolveFromProviders(name: string, providers: readonly RecipeSecretEnvProvider[], context: RecipeSecretEnvProviderContext): RecipeSecretEnvProviderResult | undefined {
  for (const provider of providers) {
    const result = provider(name, context)
    if (result?.value !== undefined) {
      return result
    }
  }
  return undefined
}
