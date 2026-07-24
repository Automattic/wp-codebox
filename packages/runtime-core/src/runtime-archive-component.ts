export const RUNTIME_ARCHIVE_COMPONENT_SCHEMA = "wp-codebox/runtime-archive-component/v1" as const
export const RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA = "wp-codebox/runtime-archive-component-source/v1" as const

export interface RuntimeArchiveComponent {
  schema: typeof RUNTIME_ARCHIVE_COMPONENT_SCHEMA
  id: string
  package: { profile: string; root: string }
  wordpress: { install_path: string; bootstrap_file: string; loader_path?: string; version_constant?: string }
  abilities: Record<string, string>
  limits: { files: number; bytes: number }
}

export interface RuntimeArchiveComponentSource {
  schema: typeof RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA
  source: { url: string; version?: string; identity?: string; sha256: string }
  component: RuntimeArchiveComponent
  migration?: {
    source_sha256: string
    selectors: Array<{ type: "file" | "prefix"; path: string }>
    required_files: string[]
  }
}

export function runtimeArchiveComponent(value: unknown): RuntimeArchiveComponent {
  if (!isRecord(value) || value.schema !== RUNTIME_ARCHIVE_COMPONENT_SCHEMA || !isSlug(value.id)) throw new Error("Runtime archive component identity is invalid.")
  if (!isRecord(value.package) || !isSlug(value.package.profile) || !isSlug(value.package.root)) throw new Error("Runtime archive component package is invalid.")
  if (!isRecord(value.wordpress) || !isWpContentPath(value.wordpress.install_path) || !isSafeRelativePath(value.wordpress.bootstrap_file) || value.wordpress.bootstrap_file.endsWith("/")) throw new Error("Runtime archive component WordPress contract is invalid.")
  if (value.wordpress.loader_path !== undefined && (!isWpContentPath(value.wordpress.loader_path) || !String(value.wordpress.loader_path).startsWith("mu-plugins/") || String(value.wordpress.loader_path).endsWith("/"))) throw new Error("Runtime archive component loader path is invalid.")
  if (value.wordpress.version_constant !== undefined && (typeof value.wordpress.version_constant !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value.wordpress.version_constant))) throw new Error("Runtime archive component version constant is invalid.")
  if (!isRecord(value.abilities) || !Object.keys(value.abilities).length || Object.entries(value.abilities).some(([name, ability]) => !isSlug(name) || typeof ability !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ability))) throw new Error("Runtime archive component abilities are invalid.")
  if (!isRecord(value.limits) || !Number.isSafeInteger(value.limits.files) || Number(value.limits.files) < 1 || Number(value.limits.files) > 100_000 || !Number.isSafeInteger(value.limits.bytes) || Number(value.limits.bytes) < 1 || Number(value.limits.bytes) > 256 * 1024 * 1024) throw new Error("Runtime archive component limits are invalid.")
  return value as unknown as RuntimeArchiveComponent
}

export function runtimeArchiveComponentSource(value: unknown): RuntimeArchiveComponentSource {
  if (!isRecord(value) || value.schema !== RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA || !isRecord(value.source) || typeof value.source.url !== "string" || !value.source.url.startsWith("https://") || !isSha256(value.source.sha256)) throw new Error("Runtime archive component source is invalid.")
  const component = runtimeArchiveComponent(value.component)
  if (value.migration !== undefined) {
    if (!isRecord(value.migration) || !isSha256(value.migration.source_sha256) || value.migration.source_sha256 !== value.source.sha256 || !Array.isArray(value.migration.selectors) || !value.migration.selectors.length || !Array.isArray(value.migration.required_files) || !value.migration.required_files.length) throw new Error("Runtime archive component migration is invalid.")
  }
  return { ...(value as unknown as RuntimeArchiveComponentSource), component }
}

export function runtimeArchiveComponentOwnedWpContentPaths(component: RuntimeArchiveComponent): string[] {
  return [component.wordpress.install_path.endsWith("/") ? component.wordpress.install_path : `${component.wordpress.install_path}/`, component.wordpress.loader_path].filter((path): path is string => Boolean(path))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
}

function isWpContentPath(value: unknown): value is string {
  return isSafeRelativePath(value) && /^(?:plugins|mu-plugins)\//.test(value)
}
