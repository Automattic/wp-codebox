import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

export const RUNTIME_OVERLAY_DESCRIPTOR_MANIFEST_SCHEMA = "wp-codebox/runtime-overlay-descriptors/v1" as const

export interface RuntimeOverlayDescriptorCapabilities {
  provided?: string[]
  required?: string[]
  optional?: string[]
}

export interface RuntimeOverlayDescriptorManifestEntry {
  kind: string
  library: string
  strategy: string
  defaultTarget: string
  capabilities?: RuntimeOverlayDescriptorCapabilities
  metadata?: Record<string, unknown>
}

export interface RuntimeOverlayDescriptorManifest {
  schema: typeof RUNTIME_OVERLAY_DESCRIPTOR_MANIFEST_SCHEMA
  descriptors: RuntimeOverlayDescriptorManifestEntry[]
  capabilities?: RuntimeOverlayDescriptorCapabilities
  metadata?: Record<string, unknown>
}

export interface RuntimeOverlayDescriptorValidationOptions {
  availableCapabilities?: string[]
}

export interface RuntimeOverlayDescriptorDiscoveryOptions extends RuntimeOverlayDescriptorValidationOptions {
  directories?: string[]
  packages?: string[]
}

export interface DiscoveredRuntimeOverlayDescriptorManifest {
  source: string
  manifest: RuntimeOverlayDescriptorManifest
}

const descriptorManifestFileNames = ["wp-codebox-runtime-overlays.json", join(".wp-codebox", "runtime-overlays.json")]

export function runtimeOverlayDescriptorManifest(input: unknown, options: RuntimeOverlayDescriptorValidationOptions = {}): RuntimeOverlayDescriptorManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Runtime overlay descriptor manifest must be an object.")
  }

  const manifest = input as Partial<RuntimeOverlayDescriptorManifest>
  if (manifest.schema !== RUNTIME_OVERLAY_DESCRIPTOR_MANIFEST_SCHEMA) {
    throw new Error(`Runtime overlay descriptor manifest schema must be ${RUNTIME_OVERLAY_DESCRIPTOR_MANIFEST_SCHEMA}.`)
  }
  if (!Array.isArray(manifest.descriptors) || manifest.descriptors.length === 0) {
    throw new Error("Runtime overlay descriptor manifest must include descriptors.")
  }

  const normalized: RuntimeOverlayDescriptorManifest = {
    schema: RUNTIME_OVERLAY_DESCRIPTOR_MANIFEST_SCHEMA,
    descriptors: manifest.descriptors.map(normalizeDescriptor),
    capabilities: manifest.capabilities ? normalizeCapabilities(manifest.capabilities, "manifest capabilities") : undefined,
    metadata: normalizeMetadata(manifest.metadata, "manifest metadata"),
  }
  if (options.availableCapabilities) {
    validateRequiredCapabilities(normalized, options.availableCapabilities)
  }
  return normalized
}

export function discoverRuntimeOverlayDescriptorManifests(options: RuntimeOverlayDescriptorDiscoveryOptions): DiscoveredRuntimeOverlayDescriptorManifest[] {
  const manifestPaths = new Set<string>()
  for (const directory of options.directories ?? []) {
    for (const manifestPath of descriptorManifestPaths(directory)) {
      manifestPaths.add(manifestPath)
    }
  }
  for (const packagePath of options.packages ?? []) {
    for (const manifestPath of packageDescriptorManifestPaths(packagePath)) {
      manifestPaths.add(manifestPath)
    }
  }

  return [...manifestPaths].map((manifestPath) => ({
    source: manifestPath,
    manifest: runtimeOverlayDescriptorManifest(JSON.parse(readFileSync(manifestPath, "utf8")), options),
  }))
}

function descriptorManifestPaths(directory: string): string[] {
  const root = resolve(directory)
  return descriptorManifestFileNames.map((fileName) => join(root, fileName)).filter((fileName) => existsSync(fileName) && statSync(fileName).isFile())
}

function packageDescriptorManifestPaths(packagePath: string): string[] {
  const root = resolve(packagePath)
  const paths = descriptorManifestPaths(root)
  const packageJsonPath = join(root, "package.json")
  if (!existsSync(packageJsonPath) || !statSync(packageJsonPath).isFile()) {
    return paths
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { wpCodebox?: { runtimeOverlayDescriptors?: string | string[] } }
  const declared = packageJson.wpCodebox?.runtimeOverlayDescriptors
  const declaredPaths = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : []
  return [...paths, ...declaredPaths.map((declaredPath) => resolve(root, declaredPath)).filter((fileName) => existsSync(fileName) && statSync(fileName).isFile())]
}

function normalizeDescriptor(descriptor: RuntimeOverlayDescriptorManifestEntry): RuntimeOverlayDescriptorManifestEntry {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Runtime overlay descriptor entries must be objects.")
  }
  requireIdentifier(descriptor.kind, "descriptor kind")
  requireIdentifier(descriptor.library, "descriptor library")
  requireIdentifier(descriptor.strategy, "descriptor strategy")
  requireAbsolutePath(descriptor.defaultTarget, "descriptor defaultTarget")
  return {
    kind: descriptor.kind,
    library: descriptor.library,
    strategy: descriptor.strategy,
    defaultTarget: descriptor.defaultTarget,
    capabilities: descriptor.capabilities ? normalizeCapabilities(descriptor.capabilities, `${descriptor.kind}/${descriptor.library}/${descriptor.strategy} capabilities`) : undefined,
    metadata: normalizeMetadata(descriptor.metadata, `${descriptor.kind}/${descriptor.library}/${descriptor.strategy} metadata`),
  }
}

function normalizeCapabilities(capabilities: RuntimeOverlayDescriptorCapabilities, label: string): RuntimeOverlayDescriptorCapabilities {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error(`Runtime overlay descriptor ${label} must be an object.`)
  }
  return {
    provided: normalizeCapabilityList(capabilities.provided, `${label}.provided`),
    required: normalizeCapabilityList(capabilities.required, `${label}.required`),
    optional: normalizeCapabilityList(capabilities.optional, `${label}.optional`),
  }
}

function validateRequiredCapabilities(manifest: RuntimeOverlayDescriptorManifest, availableCapabilities: string[]): void {
  const available = new Set(availableCapabilities)
  for (const descriptor of manifest.descriptors) {
    const missing = (descriptor.capabilities?.required ?? []).filter((capability) => !available.has(capability))
    if (missing.length > 0) {
      throw new Error(`Runtime overlay descriptor ${descriptor.kind}/${descriptor.library}/${descriptor.strategy} requires unavailable capabilities: ${missing.join(", ")}.`)
    }
  }
}

function normalizeCapabilityList(values: string[] | undefined, label: string): string[] | undefined {
  if (values === undefined) return undefined
  if (!Array.isArray(values)) throw new Error(`Runtime overlay descriptor ${label} must be an array.`)
  const normalized = values.map((value) => {
    requireCapability(value, label)
    return value
  })
  return [...new Set(normalized)]
}

function normalizeMetadata(metadata: Record<string, unknown> | undefined, label: string): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`Runtime overlay descriptor ${label} must be an object.`)
  }
  return metadata
}

function requireIdentifier(value: string | undefined, label: string): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`Runtime overlay ${label} must be a stable identifier.`)
  }
}

function requireCapability(value: string, label: string): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_./:-]*$/.test(value)) {
    throw new Error(`Runtime overlay descriptor ${label} entries must be stable capability identifiers.`)
  }
}

function requireAbsolutePath(path: string | undefined, label: string): void {
  if (!path || !path.startsWith("/")) throw new Error(`Runtime overlay ${label} must be absolute.`)
  if (path.split("/").includes("..")) throw new Error(`Runtime overlay ${label} cannot contain parent-directory segments.`)
}
