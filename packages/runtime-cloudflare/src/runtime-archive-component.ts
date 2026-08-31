export const RUNTIME_ARCHIVE_COMPONENT_SCHEMA = "wp-codebox/runtime-archive-component/v1" as const

export interface RuntimeArchiveComponent {
  schema: typeof RUNTIME_ARCHIVE_COMPONENT_SCHEMA
  id: string
  package: { profile: string; root: string }
  wordpress: {
    install_path: string
    bootstrap_file: string
    load: { mode: "mu-plugin-loader"; loader_path: string }
    version_constant?: string
  }
  abilities: Record<string, string>
  limits: { files: number; bytes: number }
}

export function runtimeArchiveComponent(value: unknown): RuntimeArchiveComponent {
  if (!isRecord(value) || value.schema !== RUNTIME_ARCHIVE_COMPONENT_SCHEMA || !isSlug(value.id)) throw new Error("Runtime archive component identity is invalid.")
  if (!isRecord(value.package) || !isSlug(value.package.profile) || !isSlug(value.package.root)) throw new Error("Runtime archive component package is invalid.")
  if (!isRecord(value.wordpress) || !isPluginInstallPath(value.wordpress.install_path) || !isSafeFilePath(value.wordpress.bootstrap_file)) throw new Error("Runtime archive component WordPress contract is invalid.")
  if (!isRecord(value.wordpress.load) || value.wordpress.load.mode !== "mu-plugin-loader" || !isMuPluginFilePath(value.wordpress.load.loader_path)) throw new Error("Runtime archive component load contract is invalid.")
  if (value.wordpress.version_constant !== undefined && (typeof value.wordpress.version_constant !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value.wordpress.version_constant))) throw new Error("Runtime archive component version constant is invalid.")
  if (!isRecord(value.abilities) || !Object.keys(value.abilities).length || Object.entries(value.abilities).some(([alias, ability]) => !isSlug(alias) || !isAbility(ability))) throw new Error("Runtime archive component abilities are invalid.")
  if (!isRecord(value.limits) || !Number.isSafeInteger(value.limits.files) || Number(value.limits.files) < 1 || Number(value.limits.files) > 100_000 || !Number.isSafeInteger(value.limits.bytes) || Number(value.limits.bytes) < 1 || Number(value.limits.bytes) > 256 * 1024 * 1024) throw new Error("Runtime archive component limits are invalid.")
  return {
    schema: RUNTIME_ARCHIVE_COMPONENT_SCHEMA,
    id: value.id,
    package: { profile: value.package.profile, root: value.package.root },
    wordpress: {
      install_path: value.wordpress.install_path,
      bootstrap_file: value.wordpress.bootstrap_file,
      load: { mode: "mu-plugin-loader", loader_path: value.wordpress.load.loader_path },
      ...(value.wordpress.version_constant ? { version_constant: value.wordpress.version_constant } : {}),
    },
    abilities: Object.fromEntries(Object.entries(value.abilities).sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>,
    limits: { files: Number(value.limits.files), bytes: Number(value.limits.bytes) },
  }
}

export function runtimeArchiveComponentOwnedWpContentPaths(component: RuntimeArchiveComponent): string[] {
  const validated = runtimeArchiveComponent(component)
  return [`${validated.wordpress.install_path}/`, validated.wordpress.load.loader_path]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isAbility(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isSafeFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 && !value.startsWith("/") && !value.endsWith("/") && !value.includes("\\") && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function isPluginInstallPath(value: unknown): value is string {
  return typeof value === "string" && /^plugins\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isMuPluginFilePath(value: unknown): value is string {
  return isSafeFilePath(value) && /^mu-plugins\/[A-Za-z0-9._-]+\.php$/.test(value)
}
