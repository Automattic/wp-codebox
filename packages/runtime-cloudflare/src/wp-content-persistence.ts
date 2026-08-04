import { DEFAULT_SITE_CONTEXT, siteStorageKeys, type SiteContext } from "./site-context.js"

export const R2_WP_CONTENT_OBJECT_PREFIX = siteStorageKeys(DEFAULT_SITE_CONTEXT).wpContentObjectPrefix
export const MAX_WP_CONTENT_FILES = 5000
export const MAX_WP_CONTENT_FILE_BYTES = 8 * 1024 * 1024
export const MAX_WP_CONTENT_TOTAL_BYTES = 64 * 1024 * 1024

export interface WpContentFileMetadata {
  path: string
  size: number
}

export interface WpContentManifestFile extends WpContentFileMetadata {
  objectKey: string
  sha256: string
}

const DEFAULT_RUNTIME_OWNED_PATHS = [
  "plugins/markdown-database-integration/",
  "plugins/sqlite-database-integration/",
  "mu-plugins/wp-codebox-cloudflare-canonical-changes.php",
]

export function validateWpContentMetadata(value: unknown, runtimeOwnedPaths: string[] = []): asserts value is WpContentFileMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_WP_CONTENT_FILES) throw new Error("Canonical wp-content file count is invalid.")
  let total = 0
  const paths = new Set<string>()
  for (const file of value) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !isCanonicalWpContentPath(file.path, runtimeOwnedPaths) || paths.has(file.path)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_WP_CONTENT_FILE_BYTES) {
      throw new Error("Canonical wp-content metadata contains an invalid file.")
    }
    paths.add(file.path)
    total += file.size
  }
  if (total > MAX_WP_CONTENT_TOTAL_BYTES) throw new Error("Canonical wp-content files exceed their byte budget.")
}

export function validateWpContentManifestFiles(value: unknown, site: SiteContext = DEFAULT_SITE_CONTEXT, runtimeOwnedPaths: string[] = []): asserts value is WpContentManifestFile[] {
  validateWpContentMetadata(value, runtimeOwnedPaths)
  for (const file of value as WpContentManifestFile[]) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.objectKey !== `${siteStorageKeys(site).wpContentObjectPrefix}/${file.sha256}`) {
      throw new Error("Canonical wp-content manifest contains an invalid file.")
    }
  }
}

export function validateWpContentDeletedPaths(value: unknown, runtimeOwnedPaths: string[] = []): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_WP_CONTENT_FILES || value.some((path) => typeof path !== "string" || !isCanonicalWpContentPath(path, runtimeOwnedPaths))) {
    throw new Error("Canonical wp-content tombstones are invalid.")
  }
  if (value.some((path, index) => index > 0 && value[index - 1] >= path)) throw new Error("Canonical wp-content tombstones are non-deterministic.")
}

export function isCanonicalWpContentPath(path: string, runtimeOwnedPaths: string[] = []): boolean {
  if (!/^(?:plugins|themes|languages|mu-plugins)\//.test(path) || path.includes("\\") || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) return false
  return !runtimeOwnedWpContentPaths(runtimeOwnedPaths).some((owned) => owned.endsWith("/") ? path.startsWith(owned) : path === owned || path.startsWith(`${owned}/`))
}

export function runtimeOwnedWpContentPaths(additional: string[] = []): string[] {
  const paths = [...new Set([...DEFAULT_RUNTIME_OWNED_PATHS, ...additional])]
  if (paths.some((path) => !/^(?:plugins|mu-plugins)\//.test(path) || path === "plugins/" || path === "mu-plugins/" || path.includes("\\") || path.split("/").some((segment, index, parts) => !segment && index !== parts.length - 1 || segment === "." || segment === ".."))) throw new Error("Runtime-owned wp-content path is invalid.")
  return paths
}
