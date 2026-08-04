export interface RuntimePackageManifest {
  schema: string
  package: string
  package_root: string
  profiles: Record<string, RuntimePackageProfile>
}

export interface RuntimePackageProfile {
  description?: string
  abilities: string[]
  selectors: Array<{ type: "file" | "prefix"; path: string }>
  required_files: string[]
}

export interface RuntimePackageFileSelection {
  sourcePath: string
  targetPath: string
}

export function parseRuntimePackageManifest(source: string): RuntimePackageManifest {
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new Error("Runtime package manifest is not valid JSON.") }
  if (!isRecord(value) || typeof value.schema !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*\/runtime-package-manifest\/v1$/.test(value.schema)) throw new Error("Runtime package manifest schema is invalid.")
  if (!isSlug(value.package) || !isSlug(value.package_root) || !isRecord(value.profiles) || !Object.keys(value.profiles).length) throw new Error("Runtime package manifest identity is invalid.")
  const profiles: Record<string, RuntimePackageProfile> = {}
  for (const [name, profile] of Object.entries(value.profiles)) profiles[name] = parseProfile(name, profile)
  return { schema: value.schema, package: value.package, package_root: value.package_root, profiles }
}

export function selectRuntimePackageProfileFiles(manifest: RuntimePackageManifest, profileName: string, archivePaths: string[], manifestPath: string): RuntimePackageFileSelection[] {
  if (!isSlug(profileName)) throw new Error("Runtime package profile name is invalid.")
  const profile = manifest.profiles[profileName]
  if (!profile) throw new Error(`Runtime package profile is unavailable: ${profileName}`)
  if (!isSafeFilePath(manifestPath) || !manifestPath.endsWith("/runtime-package-manifest.json")) throw new Error("Runtime package manifest archive path is invalid.")
  if (archivePaths.some((path) => !isSafeFilePath(path)) || new Set(archivePaths).size !== archivePaths.length) throw new Error("Runtime package archive paths are invalid or duplicated.")
  const archiveRoot = manifestPath.slice(0, -"runtime-package-manifest.json".length)
  if (archiveRoot !== `${manifest.package_root}/`) throw new Error("Runtime package manifest root does not match its package root.")
  const selected = archivePaths
    .filter((path) => path.startsWith(archiveRoot))
    .map((sourcePath) => ({ sourcePath, relativePath: sourcePath.slice(archiveRoot.length) }))
    .filter(({ relativePath }) => profile.selectors.some((selector) => selector.type === "file" ? relativePath === selector.path : relativePath.startsWith(selector.path)))
    .map(({ sourcePath, relativePath }) => ({ sourcePath, targetPath: `${manifest.package_root}/${relativePath}` }))
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath))
  if (!selected.length) throw new Error(`Runtime package profile selected no files: ${profileName}`)
  const selectedRelative = new Set(selected.map(({ targetPath }) => targetPath.slice(manifest.package_root.length + 1)))
  for (const required of profile.required_files) if (!selectedRelative.has(required)) throw new Error(`Runtime package profile is missing required file: ${required}`)
  if (new Set(selected.map(({ targetPath }) => targetPath)).size !== selected.length) throw new Error("Runtime package profile produced duplicate target paths.")
  return selected
}

function parseProfile(name: string, value: unknown): RuntimePackageProfile {
  if (!isSlug(name) || !isRecord(value) || !Array.isArray(value.abilities) || !value.abilities.length || value.abilities.some((ability) => typeof ability !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ability)) || new Set(value.abilities).size !== value.abilities.length) throw new Error(`Runtime package profile abilities are invalid: ${name}`)
  if (!Array.isArray(value.selectors) || !value.selectors.length) throw new Error(`Runtime package profile selectors are invalid: ${name}`)
  const selectors = value.selectors.map((selector) => {
    if (!isRecord(selector) || (selector.type !== "file" && selector.type !== "prefix") || !isSafeRelativePath(selector.path) || (selector.type === "prefix") !== selector.path.endsWith("/")) throw new Error(`Runtime package profile selector is invalid: ${name}`)
    return { type: selector.type as "file" | "prefix", path: selector.path }
  })
  if (new Set(selectors.map(({ type, path }) => `${type}:${path}`)).size !== selectors.length) throw new Error(`Runtime package profile selectors are duplicated: ${name}`)
  if (!Array.isArray(value.required_files) || !value.required_files.length || value.required_files.some((path) => !isSafeFilePath(path)) || new Set(value.required_files).size !== value.required_files.length) throw new Error(`Runtime package profile required files are invalid: ${name}`)
  return { ...(typeof value.description === "string" ? { description: value.description } : {}), abilities: [...value.abilities], selectors, required_files: [...value.required_files] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2_048 || value.startsWith("/") || value.includes("\\") || !/^[A-Za-z0-9._/-]+$/.test(value)) return false
  return value.split("/").every((segment, index, segments) => (segment !== "" || index === segments.length - 1) && segment !== "." && segment !== "..")
}

function isSafeFilePath(value: unknown): value is string {
  return isSafeRelativePath(value) && !value.endsWith("/")
}
