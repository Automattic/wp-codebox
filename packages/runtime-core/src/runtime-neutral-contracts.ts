export type BackendNeutralRuntimeBackendKind = string & {}

export interface BackendNeutralRuntimeAssetSpec {
  directory?: string
  archive?: string
  metadata?: Record<string, unknown>
}

export interface BackendNeutralEnvironmentSpec {
  kind: string
  name?: string
  version?: string
  assets?: BackendNeutralRuntimeAssetSpec
  metadata?: Record<string, unknown>
}

export type RuntimeWordPressInstallModeContract = "install-from-existing-files" | "install-from-existing-files-if-needed" | "do-not-attempt-installing"

export interface RuntimeWordPressAssetSpec extends BackendNeutralRuntimeAssetSpec {
  wordpressDirectory?: string
  wordpressZip?: string
}

export interface RuntimeWordPressEnvironmentSpec extends BackendNeutralEnvironmentSpec {
  blueprint?: unknown
  phpVersion?: string
  assets?: RuntimeWordPressAssetSpec
  wordpressInstallMode?: RuntimeWordPressInstallModeContract
}

export type BackendNeutralReplayStatus = "metadata-only" | "partial-replay" | "replayable-runtime-state" | "runtime-state-artifact" | "not-replayable" | (string & {})

export interface BackendNeutralReplaySpec {
  status: BackendNeutralReplayStatus
  environment?: BackendNeutralEnvironmentSpec
  artifactRefs?: BackendNeutralArtifactRef[]
  metadata?: Record<string, unknown>
}

export interface BackendNeutralArtifactRef {
  path: string
  kind: string
  contentType?: string
  sha256?: string
  metadata?: Record<string, unknown>
}

export interface BackendNeutralRuntimeProvenance {
  backend: BackendNeutralRuntimeBackendKind
  version?: string
  backendPackage?: Record<string, unknown>
  environment?: BackendNeutralEnvironmentSpec
  metadata?: Record<string, unknown>
}

export interface RuntimeWordPressProvenance extends BackendNeutralRuntimeProvenance {
  wordpressVersion?: string
}

export function normalizeBackendNeutralEnvironmentSpec(input: unknown): BackendNeutralEnvironmentSpec {
  const value = requireObject(input, "Runtime environment") as Partial<RuntimeWordPressEnvironmentSpec>
  const assets = normalizeBackendNeutralAssetSpec(value.assets)
  return stripUndefined({
    kind: requiredString(value.kind, "environment.kind"),
    name: optionalString(value.name, "environment.name"),
    version: optionalString(value.version, "environment.version"),
    assets,
    metadata: normalizeOptionalObject(value.metadata, "environment.metadata"),
  })
}

export function normalizeRuntimeWordPressEnvironmentSpec(input: unknown): RuntimeWordPressEnvironmentSpec {
  const value = requireObject(input, "Runtime environment") as Partial<RuntimeWordPressEnvironmentSpec>
  const neutral = normalizeBackendNeutralEnvironmentSpec(value)
  return stripUndefined({
    ...neutral,
    blueprint: value.blueprint,
    phpVersion: optionalString(value.phpVersion, "environment.phpVersion"),
    assets: normalizeRuntimeWordPressAssetSpec(value.assets),
    wordpressInstallMode: optionalString(value.wordpressInstallMode, "environment.wordpressInstallMode") as RuntimeWordPressInstallModeContract | undefined,
  })
}

export function normalizeBackendNeutralReplaySpec(input: unknown): BackendNeutralReplaySpec {
  const value = requireObject(input, "Runtime replay") as Partial<BackendNeutralReplaySpec>
  return stripUndefined({
    status: requiredString(value.status, "replay.status") as BackendNeutralReplayStatus,
    environment: value.environment === undefined ? undefined : normalizeBackendNeutralEnvironmentSpec(value.environment),
    artifactRefs: normalizeArtifactRefs(value.artifactRefs, "replay.artifactRefs"),
    metadata: normalizeOptionalObject(value.metadata, "replay.metadata"),
  })
}

export function wordpressEnvironmentToBackendNeutral(input: RuntimeWordPressEnvironmentSpec): BackendNeutralEnvironmentSpec {
  return normalizeBackendNeutralEnvironmentSpec(input)
}

export const normalizeEnvironmentSpec = normalizeRuntimeWordPressEnvironmentSpec

function normalizeRuntimeWordPressAssetSpec(input: unknown): RuntimeWordPressAssetSpec | undefined {
  const value = normalizeBackendNeutralAssetSpec(input) as RuntimeWordPressAssetSpec | undefined
  if (input === undefined) return value
  const source = requireObject(input, "environment.assets") as Partial<RuntimeWordPressAssetSpec>
  return stripUndefined({
    ...value,
    wordpressDirectory: optionalString(source.wordpressDirectory, "environment.assets.wordpressDirectory"),
    wordpressZip: optionalString(source.wordpressZip, "environment.assets.wordpressZip"),
  })
}

function normalizeBackendNeutralAssetSpec(input: unknown): BackendNeutralRuntimeAssetSpec | undefined {
  if (input === undefined) return undefined
  const value = requireObject(input, "environment.assets") as Partial<BackendNeutralRuntimeAssetSpec>
  return stripUndefined({
    directory: optionalString(value.directory, "environment.assets.directory"),
    archive: optionalString(value.archive, "environment.assets.archive"),
    metadata: normalizeOptionalObject(value.metadata, "environment.assets.metadata"),
  })
}

function normalizeArtifactRefs(input: unknown, label: string): BackendNeutralArtifactRef[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new Error(`${label} must be an array.`)
  return input.map((entry, index) => normalizeArtifactRef(entry, `${label}[${index}]`))
}

function normalizeArtifactRef(input: unknown, label: string): BackendNeutralArtifactRef {
  const value = requireObject(input, label) as Partial<BackendNeutralArtifactRef>
  return stripUndefined({
    path: requiredString(value.path, `${label}.path`),
    kind: requiredString(value.kind, `${label}.kind`),
    contentType: optionalString(value.contentType, `${label}.contentType`),
    sha256: optionalString(value.sha256, `${label}.sha256`),
    metadata: normalizeOptionalObject(value.metadata, `${label}.metadata`),
  })
}

function normalizeOptionalObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return requireObject(value, label)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value, label)
  if (!normalized) throw new Error(`${label} must be a non-empty string.`)
  return normalized
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  return normalized === "" ? undefined : normalized
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
