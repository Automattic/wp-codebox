import { DEFAULT_SITE_CONTEXT, siteStorageKeys, type SiteContext } from "./site-context.js"

export const R2_UPLOAD_OBJECT_PREFIX = siteStorageKeys(DEFAULT_SITE_CONTEXT).uploadObjectPrefix
export const MAX_UPLOAD_FILES = 5000
export const MAX_UPLOAD_FILE_BYTES = 16 * 1024 * 1024
export const MAX_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024

export interface UploadFileMetadata {
  path: string
  size: number
}

export interface UploadManifestFile extends UploadFileMetadata {
  objectKey: string
  sha256: string
}

export function validateUploadMetadata(value: unknown): asserts value is UploadFileMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_UPLOAD_FILES) throw new Error("Canonical upload file count is invalid.")
  let total = 0
  const paths = new Set<string>()
  for (const file of value) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !isCanonicalUploadPath(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error("Canonical upload metadata contains an invalid file.")
    }
    paths.add(file.path)
    total += file.size
  }
  if (total > MAX_UPLOAD_TOTAL_BYTES) throw new Error("Canonical upload files exceed their byte budget.")
}

export function validateUploadManifestFiles(value: unknown, site: SiteContext = DEFAULT_SITE_CONTEXT): asserts value is UploadManifestFile[] {
  validateUploadMetadata(value)
  for (const file of value as UploadManifestFile[]) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.objectKey !== `${siteStorageKeys(site).uploadObjectPrefix}/${file.sha256}`) {
      throw new Error("Canonical upload manifest contains an invalid file.")
    }
  }
}

function isCanonicalUploadPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..")
}
