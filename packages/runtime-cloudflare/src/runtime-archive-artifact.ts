export const RUNTIME_ARCHIVE_ARTIFACT_SCHEMA = "wp-codebox/runtime-archive-artifact/v1"
export const RUNTIME_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024

export interface RuntimeArchiveArtifactManifest {
  schema: typeof RUNTIME_ARCHIVE_ARTIFACT_SCHEMA
  name: string
  key: string
  archive: { sha256: string; size: number }
  source: { url: string; version?: string; identity?: string }
}

export function runtimeArchiveArtifactKey(name: string, sha256: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Runtime archive artifact name is invalid.")
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Runtime archive artifact hash must be a SHA-256 digest.")
  return `runtime/archives/${name}/${sha256}.zip`
}

export function validateRuntimeArchiveArtifactManifest(manifest: RuntimeArchiveArtifactManifest): void {
  if (manifest.schema !== RUNTIME_ARCHIVE_ARTIFACT_SCHEMA) throw new Error("Runtime archive artifact schema is invalid.")
  if (manifest.key !== runtimeArchiveArtifactKey(manifest.name, manifest.archive.sha256)) throw new Error("Runtime archive artifact key is not content addressed.")
  if (!Number.isSafeInteger(manifest.archive.size) || manifest.archive.size < 1 || manifest.archive.size > RUNTIME_ARCHIVE_MAX_BYTES) throw new Error("Runtime archive artifact size is outside the allowed budget.")
  if (!manifest.source.url.startsWith("https://")) throw new Error("Runtime archive artifact source URL is invalid.")
}

export async function readRuntimeArchiveArtifact(bucket: R2Bucket, manifest: RuntimeArchiveArtifactManifest): Promise<Uint8Array> {
  validateRuntimeArchiveArtifactManifest(manifest)
  const object = await bucket.get(manifest.key)
  if (!object) throw new Error(`Runtime archive artifact is unavailable: ${manifest.key}`)
  if (object.size !== manifest.archive.size) throw new Error("Runtime archive artifact size does not match its manifest.")
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (await sha256Hex(bytes) !== manifest.archive.sha256) throw new Error("Runtime archive artifact hash does not match its manifest.")
  return bytes
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
