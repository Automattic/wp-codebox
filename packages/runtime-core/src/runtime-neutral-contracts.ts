export type BackendNeutralRuntimeBackendKind = string & {}

export type RuntimeWordPressComponentIntentKind = "wordpress-core" | "plugin" | "mu-plugin" | "theme" | "runtime-overlay" | (string & {})
export type RuntimeWordPressFilesystemIntentType = "directory" | "file" | (string & {})
export type RuntimeWordPressFilesystemIntentMode = "readonly" | "readwrite" | "generated" | (string & {})

export interface RuntimeWordPressComponentIntent {
  kind: RuntimeWordPressComponentIntentKind
  slug?: string
  source?: string
  target?: string
  activate?: boolean
  capabilities?: string[]
  metadata?: Record<string, unknown>
}

export interface RuntimeWordPressFilesystemIntent {
  type?: RuntimeWordPressFilesystemIntentType
  source?: string
  target: string
  mode?: RuntimeWordPressFilesystemIntentMode
  purpose?: string
  metadata?: Record<string, unknown>
}

/**
 * Bytes materialized into a WordPress runtime before caller-provided Blueprint
 * steps execute. Backends must reject targets outside the WordPress root.
 */
export interface RuntimeWordPressFilesystemOverlay {
  target: string
  content?: string
  contentBase64?: string
  overwrite: boolean
  purpose?: string
  metadata?: Record<string, unknown>
}

export interface RuntimeWordPressSetupPlanIntent {
  schema: "wp-codebox/wordpress-runtime-setup-plan/v1"
  backend?: BackendNeutralRuntimeBackendKind
  components?: RuntimeWordPressComponentIntent[]
  filesystem?: RuntimeWordPressFilesystemIntent[]
  filesystemOverlays?: RuntimeWordPressFilesystemOverlay[]
  metadata?: Record<string, unknown>
}

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
export type RuntimeWordPressDatabaseSetupContract = "runtime-managed" | "external" | "custom-drop-in"
export type RuntimeWorkerCount = number | "auto"

export interface RuntimeWordPressAssetSpec extends BackendNeutralRuntimeAssetSpec {
  wordpressDirectory?: string
  wordpressZip?: string
}

/** A startup-time PHP.wasm extension manifest. External extensions are JSPI-only. */
export interface RuntimePHPWasmExtensionManifest {
  manifest: string
}

export const RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS = ["intl", "redis", "memcached", "xdebug"] as const
export type RuntimePHPWasmBundledExtension = typeof RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS[number]

export interface RuntimeWordPressEnvironmentSpec extends BackendNeutralEnvironmentSpec {
  blueprint?: unknown
  phpVersion?: string
  workers?: RuntimeWorkerCount
  assets?: RuntimeWordPressAssetSpec
  wordpressInstallMode?: RuntimeWordPressInstallModeContract
  databaseSetup?: RuntimeWordPressDatabaseSetupContract
  extensions?: RuntimePHPWasmExtensionManifest[]
  bundledExtensions?: RuntimePHPWasmBundledExtension[]
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
    workers: normalizeRuntimeWorkerCount(value.workers),
    assets: normalizeRuntimeWordPressAssetSpec(value.assets),
    wordpressInstallMode: optionalString(value.wordpressInstallMode, "environment.wordpressInstallMode") as RuntimeWordPressInstallModeContract | undefined,
    databaseSetup: optionalString(value.databaseSetup, "environment.databaseSetup") as RuntimeWordPressDatabaseSetupContract | undefined,
    extensions: normalizeRuntimePHPWasmExtensionManifests(value.extensions),
    bundledExtensions: normalizeRuntimePHPWasmBundledExtensions(value.bundledExtensions),
  })
}

function normalizeRuntimeWorkerCount(value: unknown): RuntimeWorkerCount | undefined {
  if (value === undefined) return undefined
  if (value === "auto") return value
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error("environment.workers must be an integer from 1 to 64 or auto.")
  }
  return value
}

function normalizeRuntimePHPWasmExtensionManifests(input: unknown): RuntimePHPWasmExtensionManifest[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new Error("environment.extensions must be an array.")
  return input.map((entry, index) => {
    const value = requireObject(entry, `environment.extensions[${index}]`) as Partial<RuntimePHPWasmExtensionManifest>
    const manifest = requiredString(value.manifest, `environment.extensions[${index}].manifest`)
    if (manifest.includes("\0")) throw new Error(`environment.extensions[${index}].manifest must not contain a null byte.`)
    return { manifest }
  })
}

function normalizeRuntimePHPWasmBundledExtensions(input: unknown): RuntimePHPWasmBundledExtension[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new Error("environment.bundledExtensions must be an array.")
  return input.map((extension, index) => {
    if (!RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS.includes(extension as RuntimePHPWasmBundledExtension)) {
      throw new Error(`environment.bundledExtensions[${index}] must be one of: ${RUNTIME_PHP_WASM_BUNDLED_EXTENSIONS.join(", ")}.`)
    }
    return extension as RuntimePHPWasmBundledExtension
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
