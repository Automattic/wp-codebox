import { decodeZip } from "@php-wasm/stream-compression"
import { isWordPressRuntimeFile } from "./wordpress-runtime-corpus.js"

export const WORDPRESS_RUNTIME_ARTIFACT_SCHEMA = "wp-codebox/wordpress-runtime-artifact/v1"
export const WORDPRESS_RUNTIME_MAX_FILES = 2_000
export const WORDPRESS_RUNTIME_MAX_UNCOMPRESSED_BYTES = 24 * 1024 * 1024
export const WORDPRESS_RUNTIME_MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
export const WORDPRESS_RUNTIME_MAX_FILE_BYTES = 8 * 1024 * 1024

export interface WordPressRuntimeArtifactManifest {
  schema: typeof WORDPRESS_RUNTIME_ARTIFACT_SCHEMA
  key: string
  archive: { sha256: string; size: number }
  source: { url: string; version?: string; identity?: string }
  files: Array<{ path: string; size: number; sha256: string }>
}

export interface RuntimeMemfs {
  mkdir(path: string): void
  writeFile(path: string, bytes: Uint8Array): void
}

export function wordpressRuntimeArtifactKey(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("WordPress runtime artifact hash must be a SHA-256 digest.")
  return `runtime/wordpress/${sha256}.zip`
}

export function validateWordPressRuntimeArtifactManifest(manifest: WordPressRuntimeArtifactManifest): void {
  if (manifest.schema !== WORDPRESS_RUNTIME_ARTIFACT_SCHEMA) throw new Error("WordPress runtime artifact schema is invalid.")
  if (manifest.key !== wordpressRuntimeArtifactKey(manifest.archive.sha256)) throw new Error("WordPress runtime artifact key is not content addressed.")
  if (!Number.isSafeInteger(manifest.archive.size) || manifest.archive.size < 1 || manifest.archive.size > WORDPRESS_RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("WordPress runtime artifact archive size is outside the allowed budget.")
  if (!manifest.source.url.startsWith("https://")) throw new Error("WordPress runtime artifact source URL is invalid.")
  if (!manifest.files.length || manifest.files.length > WORDPRESS_RUNTIME_MAX_FILES) throw new Error("WordPress runtime artifact file count is outside the allowed budget.")

  const paths = new Set(manifest.files.map((file) => file.path))
  let total = 0
  for (const file of manifest.files) {
    if (!isSafeRuntimePath(file.path) || !isWordPressRuntimeFile(file.path, paths)) throw new Error(`WordPress runtime artifact contains an invalid file path: ${file.path}`)
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > WORDPRESS_RUNTIME_MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`WordPress runtime artifact has invalid metadata for ${file.path}.`)
    total += file.size
  }
  if (total > WORDPRESS_RUNTIME_MAX_UNCOMPRESSED_BYTES || paths.size !== manifest.files.length) throw new Error("WordPress runtime artifact file budget is invalid.")
}

export async function materializeWordPressRuntimeArtifact(php: RuntimeMemfs, bucket: R2Bucket, manifest: WordPressRuntimeArtifactManifest): Promise<{ materializedFiles: number; materializedBytes: number }> {
  validateWordPressRuntimeArtifactManifest(manifest)
  const object = await bucket.get(manifest.key)
  if (!object) throw new Error(`WordPress runtime artifact is unavailable: ${manifest.key}`)
  if (object.size > WORDPRESS_RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("WordPress runtime artifact archive exceeds its size budget.")
  if (object.size !== manifest.archive.size) throw new Error("WordPress runtime artifact size does not match its manifest.")

  // The archive and expanded corpus caps leave most of the 128 MiB isolate for PHP-WASM and runtime overhead.
  const archiveBytes = new Uint8Array(await object.arrayBuffer())
  if (await sha256Hex(archiveBytes) !== manifest.archive.sha256) throw new Error("WordPress runtime artifact archive hash does not match its manifest.")
  const expected = new Map(manifest.files.map((file) => [file.path, file]))
  let materializedFiles = 0
  let materializedBytes = 0
  for await (const entry of decodeZip(new Blob([archiveBytes]).stream())) {
    const file = expected.get(entry.name)
    if (!file) throw new Error(`WordPress runtime artifact contains an unexpected file: ${entry.name}`)
    const bytes = new Uint8Array(await entry.arrayBuffer())
    if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.sha256) throw new Error(`WordPress runtime artifact file validation failed: ${entry.name}`)
    materializedBytes += bytes.byteLength
    materializedFiles++
    if (materializedFiles > WORDPRESS_RUNTIME_MAX_FILES || materializedBytes > WORDPRESS_RUNTIME_MAX_UNCOMPRESSED_BYTES) throw new Error("WordPress runtime artifact exceeds its materialization budget.")
    const destination = `/${entry.name}`
    php.mkdir(destination.slice(0, destination.lastIndexOf("/")))
    php.writeFile(destination, bytes)
    expected.delete(entry.name)
  }
  if (expected.size) throw new Error("WordPress runtime artifact is missing manifest files.")
  return { materializedFiles, materializedBytes }
}

function isSafeRuntimePath(path: string): boolean {
  return path.startsWith("wordpress/") && !path.includes("\\") && !path.split("/").some((segment) => !segment || segment === "." || segment === "..")
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
