export const R2_WP_CONTENT_OBJECT_PREFIX = "sites/default/wp-content/objects"
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

export function validateWpContentMetadata(value: unknown): asserts value is WpContentFileMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_WP_CONTENT_FILES) throw new Error("Canonical wp-content file count is invalid.")
  let total = 0
  const paths = new Set<string>()
  for (const file of value) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !isCanonicalWpContentPath(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_WP_CONTENT_FILE_BYTES) {
      throw new Error("Canonical wp-content metadata contains an invalid file.")
    }
    paths.add(file.path)
    total += file.size
  }
  if (total > MAX_WP_CONTENT_TOTAL_BYTES) throw new Error("Canonical wp-content files exceed their byte budget.")
}

export function validateWpContentManifestFiles(value: unknown): asserts value is WpContentManifestFile[] {
  validateWpContentMetadata(value)
  for (const file of value as WpContentManifestFile[]) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.objectKey !== `${R2_WP_CONTENT_OBJECT_PREFIX}/${file.sha256}`) {
      throw new Error("Canonical wp-content manifest contains an invalid file.")
    }
  }
}

export function validateWpContentDeletedPaths(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_WP_CONTENT_FILES || value.some((path) => typeof path !== "string" || !isCanonicalWpContentPath(path))) {
    throw new Error("Canonical wp-content tombstones are invalid.")
  }
  if (value.some((path, index) => index > 0 && value[index - 1] >= path)) throw new Error("Canonical wp-content tombstones are non-deterministic.")
}

export function isCanonicalWpContentPath(path: string): boolean {
  if (!/^(?:plugins|themes|languages|mu-plugins)\//.test(path) || path.includes("\\") || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) return false
  return !path.startsWith("plugins/markdown-database-integration/")
    && !path.startsWith("plugins/sqlite-database-integration/")
    && !path.startsWith("plugins/static-site-importer/")
    && path !== "mu-plugins/wp-codebox-cloudflare-canonical-changes.php"
    && !path.startsWith("mu-plugins/wp-codebox-cloudflare-canonical-changes.php/")
    && path !== "mu-plugins/wp-codebox-static-site-importer.php"
    && !path.startsWith("mu-plugins/wp-codebox-static-site-importer.php/")
}
