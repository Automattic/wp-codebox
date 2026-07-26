import { wordpressStaticArchivePath } from "./wordpress-runtime-corpus.js"

export const WORDPRESS_STATIC_ARTIFACT_SCHEMA = "wp-codebox/wordpress-static-artifact/v1"
export const WORDPRESS_STATIC_MAX_FILES = 5000
export const WORDPRESS_STATIC_MAX_BYTES = 128 * 1024 * 1024

export interface WordPressStaticArtifactManifest {
  schema: string
  key: string
  blob: { sha256: string; size: number }
  source: { url: string; version: string; identity?: string }
  files: Array<{ path: string; offset: number; size: number; sha256: string }>
}

export function wordpressStaticArtifactKey(sha256: string): string {
  return `runtime/wordpress-static/${sha256}.bin`
}

export function validateWordPressStaticArtifactManifest(manifest: WordPressStaticArtifactManifest): void {
  if (manifest.schema !== WORDPRESS_STATIC_ARTIFACT_SCHEMA) throw new Error("WordPress static artifact schema is invalid.")
  if (!/^[a-f0-9]{64}$/.test(manifest.blob.sha256) || manifest.key !== wordpressStaticArtifactKey(manifest.blob.sha256)) throw new Error("WordPress static artifact key is invalid.")
  if (!Number.isSafeInteger(manifest.blob.size) || manifest.blob.size < 1 || manifest.blob.size > WORDPRESS_STATIC_MAX_BYTES) throw new Error("WordPress static artifact size is invalid.")
  if (!manifest.source.url.startsWith("https://") || !manifest.source.version) throw new Error("WordPress static artifact source is invalid.")
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > WORDPRESS_STATIC_MAX_FILES) throw new Error("WordPress static artifact file count is invalid.")
  let expectedOffset = 0
  let previousPath = ""
  for (const file of manifest.files) {
    const pathname = file.path.startsWith("wordpress/") ? `/${file.path.slice("wordpress/".length)}` : ""
    if (!pathname || wordpressStaticArchivePath(pathname) !== file.path || file.path <= previousPath || !Number.isSafeInteger(file.offset)
      || file.offset !== expectedOffset || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("WordPress static artifact contains an invalid file.")
    }
    expectedOffset += file.size
    previousPath = file.path
  }
  if (expectedOffset !== manifest.blob.size) throw new Error("WordPress static artifact file ranges do not cover the blob.")
}
