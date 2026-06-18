import { existsSync, readFileSync, statSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"
import type { GenericAbilityRuntimeComponentContract, GenericAbilityRuntimeProviderPluginContract } from "./generic-ability-runtime-run.js"
import type { WorkspaceRecipeRuntimeOverlay } from "./runtime-contracts.js"
import { isPlainObject, stringList } from "./object-utils.js"

export const RUNTIME_PRESET_REGISTRY_SCHEMA = "wp-codebox/runtime-preset-registry/v1" as const

export interface RuntimePresetModelDefaults {
  provider?: string
  model?: string
  mode?: string
  agent?: string
  maxTurns?: number
  timeoutSeconds?: number
  metadata?: Record<string, unknown>
}

export interface RuntimePresetProviderPlugin extends GenericAbilityRuntimeProviderPluginContract {
  id?: string
  capabilities?: string[]
  requiredCapabilities?: string[]
}

export interface RuntimePresetComponent extends GenericAbilityRuntimeComponentContract {
  id?: string
  capabilities?: string[]
  requiredCapabilities?: string[]
}

export interface RuntimePresetExpectedSchemas {
  abilityResult?: string | Record<string, unknown>
  runtimeTask?: string | Record<string, unknown>
  artifacts?: Record<string, string | Record<string, unknown>>
  metadata?: Record<string, unknown>
}

export interface RuntimePresetRequiredEnv {
  runtime?: string[]
  secret?: string[]
}

export interface RuntimePresetProvider {
  plugin?: RuntimePresetProviderPlugin
  plugins?: RuntimePresetProviderPlugin[]
  capabilities?: string[]
  requiredCapabilities?: string[]
  metadata?: Record<string, unknown>
}

export interface RuntimePresetDefinition {
  id: string
  label?: string
  description?: string
  components?: RuntimePresetComponent[]
  provider?: RuntimePresetProvider
  requiredEnv?: RuntimePresetRequiredEnv
  modelDefaults?: RuntimePresetModelDefaults
  expectedSchemas?: RuntimePresetExpectedSchemas
  runtimeOverlays?: WorkspaceRecipeRuntimeOverlay[]
  metadata?: Record<string, unknown>
}

export interface RuntimePresetRegistryManifest {
  schema: typeof RUNTIME_PRESET_REGISTRY_SCHEMA
  presets: RuntimePresetDefinition[]
  metadata?: Record<string, unknown>
}

export interface RuntimePresetRegistryValidationOptions {
  availableCapabilities?: string[]
  availableEnv?: string[]
}

export interface RuntimePresetRegistryDiscoveryOptions extends RuntimePresetRegistryValidationOptions {
  directories?: string[]
  packages?: string[]
}

export interface DiscoveredRuntimePresetRegistryManifest {
  source: string
  manifest: RuntimePresetRegistryManifest
}

const presetRegistryFileNames = ["wp-codebox-runtime-presets.json", join(".wp-codebox", "runtime-presets.json")]

export function runtimePresetRegistryManifest(input: unknown, options: RuntimePresetRegistryValidationOptions = {}): RuntimePresetRegistryManifest {
  if (!isPlainObject(input)) {
    throw new Error("Runtime preset registry manifest must be an object.")
  }

  const manifest = input as Partial<RuntimePresetRegistryManifest>
  if (manifest.schema !== RUNTIME_PRESET_REGISTRY_SCHEMA) {
    throw new Error(`Runtime preset registry manifest schema must be ${RUNTIME_PRESET_REGISTRY_SCHEMA}.`)
  }
  if (!Array.isArray(manifest.presets) || manifest.presets.length === 0) {
    throw new Error("Runtime preset registry manifest must include presets.")
  }

  const seen = new Set<string>()
  const normalized: RuntimePresetRegistryManifest = {
    schema: RUNTIME_PRESET_REGISTRY_SCHEMA,
    presets: manifest.presets.map((preset) => normalizePreset(preset, seen)),
    metadata: normalizeMetadata(manifest.metadata, "manifest metadata"),
  }
  validatePresetCapabilities(normalized, options.availableCapabilities)
  validatePresetEnv(normalized, options.availableEnv)
  return normalized
}

export function runtimePresetById(manifest: RuntimePresetRegistryManifest, id: string): RuntimePresetDefinition | undefined {
  return manifest.presets.find((preset) => preset.id === id)
}

export function runtimePresetRegistryPathList(rawPaths = process.env.WP_CODEBOX_RUNTIME_PRESET_REGISTRY_PATHS): string[] {
  return rawPaths ? rawPaths.split(delimiter).map((path) => path.trim()).filter(Boolean) : []
}

export function discoverRuntimePresetRegistryManifests(options: RuntimePresetRegistryDiscoveryOptions): DiscoveredRuntimePresetRegistryManifest[] {
  const manifestPaths = new Set<string>()
  for (const directory of options.directories ?? []) {
    for (const manifestPath of presetRegistryPaths(directory)) {
      manifestPaths.add(manifestPath)
    }
  }
  for (const packagePath of options.packages ?? []) {
    for (const manifestPath of packagePresetRegistryPaths(packagePath)) {
      manifestPaths.add(manifestPath)
    }
  }

  return [...manifestPaths].map((manifestPath) => ({
    source: manifestPath,
    manifest: runtimePresetRegistryManifest(JSON.parse(readFileSync(manifestPath, "utf8")), options),
  }))
}

function presetRegistryPaths(directory: string): string[] {
  const root = resolve(directory)
  return presetRegistryFileNames.map((fileName) => join(root, fileName)).filter((fileName) => existsSync(fileName) && statSync(fileName).isFile())
}

function packagePresetRegistryPaths(packagePath: string): string[] {
  const root = resolve(packagePath)
  const paths = presetRegistryPaths(root)
  const packageJsonPath = join(root, "package.json")
  if (!existsSync(packageJsonPath) || !statSync(packageJsonPath).isFile()) {
    return paths
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { wpCodebox?: { runtimePresetRegistry?: string | string[] } }
  const declared = packageJson.wpCodebox?.runtimePresetRegistry
  const declaredPaths = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : []
  return [...paths, ...declaredPaths.map((declaredPath) => resolve(root, declaredPath)).filter((fileName) => existsSync(fileName) && statSync(fileName).isFile())]
}

function normalizePreset(preset: RuntimePresetDefinition, seen: Set<string>): RuntimePresetDefinition {
  if (!isPlainObject(preset)) {
    throw new Error("Runtime preset entries must be objects.")
  }
  requireIdentifier(preset.id, "preset id")
  if (seen.has(preset.id)) {
    throw new Error(`Runtime preset registry includes duplicate preset id: ${preset.id}.`)
  }
  seen.add(preset.id)

  return {
    id: preset.id,
    label: optionalString(preset.label, `${preset.id} label`),
    description: optionalString(preset.description, `${preset.id} description`),
    components: normalizeComponentList(preset.components, `${preset.id} components`),
    provider: normalizeProvider(preset.provider, `${preset.id} provider`),
    requiredEnv: normalizeRequiredEnv(preset.requiredEnv, `${preset.id} requiredEnv`),
    modelDefaults: normalizeModelDefaults(preset.modelDefaults, `${preset.id} modelDefaults`),
    expectedSchemas: normalizeExpectedSchemas(preset.expectedSchemas, `${preset.id} expectedSchemas`),
    runtimeOverlays: normalizeRuntimeOverlays(preset.runtimeOverlays, `${preset.id} runtimeOverlays`),
    metadata: normalizeMetadata(preset.metadata, `${preset.id} metadata`),
  }
}

function normalizeProvider(provider: RuntimePresetProvider | undefined, label: string): RuntimePresetProvider | undefined {
  if (provider === undefined) return undefined
  if (!isPlainObject(provider)) throw new Error(`Runtime preset ${label} must be an object.`)
  const typedProvider = provider as RuntimePresetProvider
  const plugins = [typedProvider.plugin, ...(Array.isArray(typedProvider.plugins) ? typedProvider.plugins : [])].filter((plugin): plugin is RuntimePresetProviderPlugin => plugin !== undefined)
  return {
    plugins: plugins.length > 0 ? plugins.map((plugin, index) => normalizePlugin(plugin, `${label}.plugins[${index}]`)) : undefined,
    capabilities: normalizeCapabilityList(typedProvider.capabilities, `${label}.capabilities`),
    requiredCapabilities: normalizeCapabilityList(typedProvider.requiredCapabilities, `${label}.requiredCapabilities`),
    metadata: normalizeMetadata(typedProvider.metadata, `${label}.metadata`),
  }
}

function normalizeComponentList(components: RuntimePresetComponent[] | undefined, label: string): RuntimePresetComponent[] | undefined {
  if (components === undefined) return undefined
  if (!Array.isArray(components)) throw new Error(`Runtime preset ${label} must be an array.`)
  return components.map((component, index) => normalizePlugin(component, `${label}[${index}]`))
}

function normalizePlugin<T extends RuntimePresetComponent | RuntimePresetProviderPlugin>(plugin: T, label: string): T {
  if (!isPlainObject(plugin)) throw new Error(`Runtime preset ${label} must be an object.`)
  requireNonEmptyString(plugin.source, `${label}.source`)
  if (plugin.id !== undefined) requireIdentifier(plugin.id, `${label}.id`)
  if (plugin.slug !== undefined) requireIdentifier(plugin.slug, `${label}.slug`)
  if (plugin.pluginFile !== undefined) requireNonEmptyString(plugin.pluginFile, `${label}.pluginFile`)
  if (plugin.loadAs !== undefined && plugin.loadAs !== "plugin" && plugin.loadAs !== "mu-plugin") {
    throw new Error(`Runtime preset ${label}.loadAs must be plugin or mu-plugin.`)
  }
  return {
    ...plugin,
    capabilities: normalizeCapabilityList(plugin.capabilities, `${label}.capabilities`),
    requiredCapabilities: normalizeCapabilityList(plugin.requiredCapabilities, `${label}.requiredCapabilities`),
    metadata: normalizeMetadata(plugin.metadata, `${label}.metadata`),
  }
}

function normalizeRequiredEnv(requiredEnv: RuntimePresetRequiredEnv | undefined, label: string): RuntimePresetRequiredEnv | undefined {
  if (requiredEnv === undefined) return undefined
  if (!isPlainObject(requiredEnv)) throw new Error(`Runtime preset ${label} must be an object.`)
  const typedRequiredEnv = requiredEnv as RuntimePresetRequiredEnv
  return {
    runtime: normalizeEnvList(typedRequiredEnv.runtime, `${label}.runtime`),
    secret: normalizeEnvList(typedRequiredEnv.secret, `${label}.secret`),
  }
}

function normalizeModelDefaults(defaults: RuntimePresetModelDefaults | undefined, label: string): RuntimePresetModelDefaults | undefined {
  if (defaults === undefined) return undefined
  if (!isPlainObject(defaults)) throw new Error(`Runtime preset ${label} must be an object.`)
  const typedDefaults = defaults as RuntimePresetModelDefaults
  return {
    provider: optionalString(typedDefaults.provider, `${label}.provider`),
    model: optionalString(typedDefaults.model, `${label}.model`),
    mode: optionalString(typedDefaults.mode, `${label}.mode`),
    agent: optionalString(typedDefaults.agent, `${label}.agent`),
    maxTurns: optionalPositiveInteger(typedDefaults.maxTurns, `${label}.maxTurns`),
    timeoutSeconds: optionalPositiveInteger(typedDefaults.timeoutSeconds, `${label}.timeoutSeconds`),
    metadata: normalizeMetadata(typedDefaults.metadata, `${label}.metadata`),
  }
}

function normalizeExpectedSchemas(schemas: RuntimePresetExpectedSchemas | undefined, label: string): RuntimePresetExpectedSchemas | undefined {
  if (schemas === undefined) return undefined
  if (!isPlainObject(schemas)) throw new Error(`Runtime preset ${label} must be an object.`)
  const typedSchemas = schemas as RuntimePresetExpectedSchemas
  if (typedSchemas.artifacts !== undefined && !isPlainObject(typedSchemas.artifacts)) {
    throw new Error(`Runtime preset ${label}.artifacts must be an object.`)
  }
  return {
    abilityResult: normalizeSchemaReference(typedSchemas.abilityResult, `${label}.abilityResult`),
    runtimeTask: normalizeSchemaReference(typedSchemas.runtimeTask, `${label}.runtimeTask`),
    artifacts: typedSchemas.artifacts,
    metadata: normalizeMetadata(typedSchemas.metadata, `${label}.metadata`),
  }
}

function normalizeRuntimeOverlays(overlays: WorkspaceRecipeRuntimeOverlay[] | undefined, label: string): WorkspaceRecipeRuntimeOverlay[] | undefined {
  if (overlays === undefined) return undefined
  if (!Array.isArray(overlays)) throw new Error(`Runtime preset ${label} must be an array.`)
  return overlays.map((overlay, index) => {
    if (!isPlainObject(overlay)) throw new Error(`Runtime preset ${label}[${index}] must be an object.`)
    requireIdentifier(overlay.kind, `${label}[${index}].kind`)
    requireIdentifier(overlay.library, `${label}[${index}].library`)
    requireIdentifier(overlay.strategy, `${label}[${index}].strategy`)
    requireNonEmptyString(overlay.source, `${label}[${index}].source`)
    return overlay
  })
}

function validatePresetCapabilities(manifest: RuntimePresetRegistryManifest, availableCapabilities: string[] | undefined): void {
  if (!availableCapabilities) return
  const available = new Set(availableCapabilities)
  for (const preset of manifest.presets) {
    const required = [
      ...(preset.provider?.requiredCapabilities ?? []),
      ...(preset.provider?.plugins ?? []).flatMap((plugin) => plugin.requiredCapabilities ?? []),
      ...(preset.components ?? []).flatMap((component) => component.requiredCapabilities ?? []),
    ]
    const missing = required.filter((capability) => !available.has(capability))
    if (missing.length > 0) {
      throw new Error(`Runtime preset ${preset.id} requires unavailable capabilities: ${[...new Set(missing)].join(", ")}.`)
    }
  }
}

function validatePresetEnv(manifest: RuntimePresetRegistryManifest, availableEnv: string[] | undefined): void {
  if (!availableEnv) return
  const available = new Set(availableEnv)
  for (const preset of manifest.presets) {
    const missing = [...(preset.requiredEnv?.runtime ?? []), ...(preset.requiredEnv?.secret ?? [])].filter((name) => !available.has(name))
    if (missing.length > 0) {
      throw new Error(`Runtime preset ${preset.id} requires unavailable env: ${[...new Set(missing)].join(", ")}.`)
    }
  }
}

function normalizeCapabilityList(values: string[] | undefined, label: string): string[] | undefined {
  if (values === undefined) return undefined
  if (!Array.isArray(values)) throw new Error(`Runtime preset ${label} must be an array.`)
  const normalized = values.map((value) => {
    requireCapability(value, label)
    return value
  })
  return [...new Set(normalized)]
}

function normalizeEnvList(values: string[] | undefined, label: string): string[] | undefined {
  if (values === undefined) return undefined
  if (!Array.isArray(values)) throw new Error(`Runtime preset ${label} must be an array.`)
  const normalized = stringList(values)
  for (const value of normalized) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
      throw new Error(`Runtime preset ${label} entries must be environment variable names.`)
    }
  }
  return normalized.length > 0 ? normalized : undefined
}

function normalizeSchemaReference(value: string | Record<string, unknown> | undefined, label: string): string | Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") {
    requireNonEmptyString(value, label)
    return value
  }
  if (!isPlainObject(value)) throw new Error(`Runtime preset ${label} must be a schema id or object.`)
  return value
}

function normalizeMetadata(metadata: Record<string, unknown> | undefined, label: string): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined
  if (!isPlainObject(metadata)) throw new Error(`Runtime preset ${label} must be an object.`)
  return metadata
}

function optionalString(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  requireNonEmptyString(value, label)
  return value
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Runtime preset ${label} must be a positive integer.`)
  return value
}

function requireIdentifier(value: string | undefined, label: string): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`Runtime preset ${label} must be a stable identifier.`)
  }
}

function requireCapability(value: string, label: string): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(value)) {
    throw new Error(`Runtime preset ${label} entries must be stable capability identifiers.`)
  }
}

function requireNonEmptyString(value: string | undefined, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Runtime preset ${label} must be a non-empty string.`)
  }
}
