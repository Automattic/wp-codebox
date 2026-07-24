export const RUNTIME_PACKAGE_MANIFEST_SCHEMA = "static-site-importer/runtime-package-manifest/v1" as const

export interface RuntimePackageManifest {
  schema: typeof RUNTIME_PACKAGE_MANIFEST_SCHEMA
  package: string
  package_root: string
  profiles: Record<string, {
    description?: string
    abilities: string[]
    selectors: Array<{ type: "file" | "prefix"; path: string }>
    required_files: string[]
  }>
}

export interface RuntimePackageFileSelection {
  sourcePath: string
  targetPath: string
}

export function parseRuntimePackageManifest(value: string): RuntimePackageManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Runtime package manifest is not valid JSON.")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Runtime package manifest must be an object.")
  const manifest = parsed as Partial<RuntimePackageManifest>
  if (manifest.schema !== RUNTIME_PACKAGE_MANIFEST_SCHEMA) throw new Error("Runtime package manifest schema is invalid.")
  if (!isSafeSegment(manifest.package) || !isSafeSegment(manifest.package_root)) throw new Error("Runtime package manifest identity is invalid.")
  if (!manifest.profiles || typeof manifest.profiles !== "object" || Array.isArray(manifest.profiles)) throw new Error("Runtime package manifest profiles are invalid.")
  return manifest as RuntimePackageManifest
}

export function selectRuntimePackageProfileFiles(manifest: RuntimePackageManifest, profileName: string, archivePaths: string[], manifestPath: string): RuntimePackageFileSelection[] {
  const profile = manifest.profiles[profileName]
  if (!profile || !Array.isArray(profile.abilities) || !Array.isArray(profile.selectors) || !Array.isArray(profile.required_files)) throw new Error(`Runtime package profile is unavailable: ${profileName}`)
  if (!profile.abilities.length || profile.abilities.some((ability) => typeof ability !== "string" || !ability.trim())) throw new Error(`Runtime package profile abilities are invalid: ${profileName}`)
  if (!profile.selectors.length) throw new Error(`Runtime package profile selectors are empty: ${profileName}`)
  const selectors = profile.selectors.map((selector) => {
    if (!selector || !["file", "prefix"].includes(selector.type) || !isSafeRelativePath(selector.path)) throw new Error(`Runtime package profile selector is invalid: ${profileName}`)
    if ((selector.type === "prefix") !== selector.path.endsWith("/")) throw new Error(`Runtime package profile selector type does not match its path: ${profileName}`)
    return selector
  })
  if (!manifestPath.endsWith("/runtime-package-manifest.json") || !isSafeRelativePath(manifestPath)) throw new Error("Runtime package manifest archive path is invalid.")
  const archiveRoot = manifestPath.slice(0, -"runtime-package-manifest.json".length)
  const selected = archivePaths
    .filter((path) => path.startsWith(archiveRoot) && isSafeRelativePath(path))
    .map((sourcePath) => ({ sourcePath, relativePath: sourcePath.slice(archiveRoot.length) }))
    .filter(({ relativePath }) => selectors.some((selector) => selector.type === "file" ? relativePath === selector.path : relativePath.startsWith(selector.path)))
    .map(({ sourcePath, relativePath }) => ({ sourcePath, targetPath: `${manifest.package_root}/${relativePath}` }))
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath))
  const selectedRelative = new Set(selected.map(({ targetPath }) => targetPath.slice(manifest.package_root.length + 1)))
  for (const required of profile.required_files) {
    if (!isSafeRelativePath(required) || required.endsWith("/") || !selectedRelative.has(required)) throw new Error(`Runtime package profile is missing required file: ${required}`)
  }
  if (new Set(selected.map(({ targetPath }) => targetPath)).size !== selected.length) throw new Error("Runtime package profile produced duplicate target paths.")
  return selected
}

function isSafeSegment(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || !/^[A-Za-z0-9._/-]+$/.test(value)) return false
  const segments = value.split("/")
  return segments.every((segment, index) => (segment !== "" || index === segments.length - 1) && segment !== "." && segment !== "..")
}
