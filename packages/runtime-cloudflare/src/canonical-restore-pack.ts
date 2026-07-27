import { decodeZip, encodeZip } from "@php-wasm/stream-compression"

export const CANONICAL_RESTORE_PACK_SCHEMA = "wp-codebox/cloudflare-canonical-restore-pack/v1"
export const CANONICAL_RESTORE_PACK_TOMBSTONES = "metadata/wp-content-deleted.json"
export const MAX_RESTORE_PACK_BYTES = 256 * 1024 * 1024
export const MAX_RESTORE_PACK_DECODED_BYTES = 192 * 1024 * 1024

export interface CanonicalRestorePackFile {
  path: string
  objectKey: string
  sha256: string
  size: number
}

export interface CanonicalRestorePackMetadata {
  schema: typeof CANONICAL_RESTORE_PACK_SCHEMA
  objectKey: string
  sha256: string
  size: number
  fileCount: number
  decodedBytes: number
}

export interface RestorePackContents {
  markdown: Array<{ path: string; bytes: Uint8Array }>
  uploads: Array<{ path: string; bytes: Uint8Array }>
  wpContent: Array<{ path: string; bytes: Uint8Array }>
  wpContentDeleted: string[]
}

export interface RestorePackBucket {
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>
}

type Domain = "markdown" | "uploads" | "wp-content"

interface RestorePackSource {
  domain: Domain
  file: { path: string; size: number }
  bytes: Uint8Array
}

export async function createCanonicalRestorePack(
  root: string,
  contents: RestorePackContents,
): Promise<{ metadata: CanonicalRestorePackMetadata; bytes: Uint8Array }> {
  const sources: RestorePackSource[] = [
    ...contents.markdown.map((file) => ({ domain: "markdown" as const, file: metadata(file), bytes: file.bytes })),
    ...contents.uploads.map((file) => ({ domain: "uploads" as const, file: metadata(file), bytes: file.bytes })),
    ...contents.wpContent.map((file) => ({ domain: "wp-content" as const, file: metadata(file), bytes: file.bytes })),
  ].sort((left, right) => entryName(left.domain, left.file.path).localeCompare(entryName(right.domain, right.file.path)))
  const tombstones = JSON.stringify({ wpContentDeleted: contents.wpContentDeleted })
  const files = [
    ...sources.map(({ domain, file, bytes }) => new File([bytes as Uint8Array<ArrayBuffer>], entryName(domain, file.path), { lastModified: 0 })),
    new File([tombstones], CANONICAL_RESTORE_PACK_TOMBSTONES, { lastModified: 0, type: "application/json" }),
  ]
  const bytes = new Uint8Array(await new Response(encodeZip(files)).arrayBuffer())
  if (bytes.byteLength > MAX_RESTORE_PACK_BYTES) throw new Error("Canonical restore pack exceeds its compressed byte budget.")
  const sha256 = await sha256Hex(bytes)
  return {
    metadata: {
      schema: CANONICAL_RESTORE_PACK_SCHEMA,
      objectKey: `${root}/restore-packs/${sha256}.zip`,
      sha256,
      size: bytes.byteLength,
      fileCount: sources.length,
      decodedBytes: sources.reduce((total, source) => total + source.bytes.byteLength, 0),
    },
    bytes,
  }
}

export async function decodeCanonicalRestorePack(
  metadata: unknown,
  root: string,
  files: { markdown: CanonicalRestorePackFile[]; uploads: CanonicalRestorePackFile[]; wpContent: CanonicalRestorePackFile[]; wpContentDeleted: string[] },
  bytes: Uint8Array,
): Promise<RestorePackContents> {
  validateCanonicalRestorePackMetadata(metadata, root, files)
  const pack = metadata as CanonicalRestorePackMetadata
  if (bytes.byteLength !== pack.size || await sha256Hex(bytes) !== pack.sha256) throw new Error("Canonical restore pack failed compressed integrity validation.")
  const expected = new Map<string, { domain: Domain; file: CanonicalRestorePackFile }>()
  for (const [domain, domainFiles] of [["markdown", files.markdown], ["uploads", files.uploads], ["wp-content", files.wpContent]] as const) {
    for (const file of domainFiles) expected.set(entryName(domain, file.path), { domain, file })
  }
  const restored: RestorePackContents = { markdown: [], uploads: [], wpContent: [], wpContentDeleted: [] }
  const seen = new Set<string>()
  let decodedBytes = 0
  let tombstones = false
  try {
    for await (const entry of decodeZip(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream())) {
      if (entry.name.endsWith("/") || seen.has(entry.name)) throw new Error("Canonical restore pack contains an invalid ZIP entry.")
      seen.add(entry.name)
      if (entry.name === CANONICAL_RESTORE_PACK_TOMBSTONES) {
        const expectedTombstones = JSON.stringify({ wpContentDeleted: files.wpContentDeleted })
        if (entry.size !== new TextEncoder().encode(expectedTombstones).byteLength) throw new Error("Canonical restore pack tombstones do not match its manifest.")
        const raw = await entry.text()
        if (raw !== expectedTombstones) throw new Error("Canonical restore pack tombstones do not match its manifest.")
        tombstones = true
        continue
      }
      const source = expected.get(entry.name)
      if (!source) throw new Error("Canonical restore pack contains an unexpected ZIP entry.")
      if (entry.size !== source.file.size || decodedBytes + entry.size > pack.decodedBytes) throw new Error("Canonical restore pack file failed size validation.")
      const entryBytes = new Uint8Array(await entry.arrayBuffer())
      decodedBytes += entryBytes.byteLength
      if (entryBytes.byteLength !== source.file.size || await sha256Hex(entryBytes) !== source.file.sha256) {
        throw new Error("Canonical restore pack file failed integrity validation.")
      }
      if (source.domain === "markdown") restored.markdown.push({ path: source.file.path, bytes: entryBytes })
      else if (source.domain === "uploads") restored.uploads.push({ path: source.file.path, bytes: entryBytes })
      else restored.wpContent.push({ path: source.file.path, bytes: entryBytes })
    }
  } catch (error) {
    throw new Error(`Canonical restore pack could not be decoded: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!tombstones || seen.size !== expected.size + 1 || decodedBytes !== pack.decodedBytes) throw new Error("Canonical restore pack is incomplete.")
  restored.wpContentDeleted = [...files.wpContentDeleted]
  return restored
}

export async function readCanonicalRestorePack(
  bucket: RestorePackBucket,
  metadata: CanonicalRestorePackMetadata,
  root: string,
  files: { markdown: CanonicalRestorePackFile[]; uploads: CanonicalRestorePackFile[]; wpContent: CanonicalRestorePackFile[]; wpContentDeleted: string[] },
): Promise<RestorePackContents> {
  validateCanonicalRestorePackMetadata(metadata, root, files)
  const object = await bucket.get(metadata.objectKey)
  if (!object) throw new Error("Canonical restore pack is missing.")
  if (object.size !== metadata.size) throw new Error("Canonical restore pack compressed size does not match its manifest.")
  return decodeCanonicalRestorePack(metadata, root, files, new Uint8Array(await object.arrayBuffer()))
}

export function validateCanonicalRestorePackMetadata(
  value: unknown,
  root: string,
  files: { markdown: CanonicalRestorePackFile[]; uploads: CanonicalRestorePackFile[]; wpContent: CanonicalRestorePackFile[] },
): asserts value is CanonicalRestorePackMetadata {
  if (!value || typeof value !== "object") throw new Error("Canonical restore pack metadata is invalid.")
  const pack = value as Partial<CanonicalRestorePackMetadata>
  const fileCount = files.markdown.length + files.uploads.length + files.wpContent.length
  const decodedBytes = [...files.markdown, ...files.uploads, ...files.wpContent].reduce((total, file) => total + file.size, 0)
  if (pack.schema !== CANONICAL_RESTORE_PACK_SCHEMA || typeof pack.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pack.sha256)
    || pack.objectKey !== `${root}/restore-packs/${pack.sha256}.zip` || typeof pack.size !== "number" || !Number.isSafeInteger(pack.size) || pack.size < 1 || pack.size > MAX_RESTORE_PACK_BYTES
    || pack.fileCount !== fileCount || pack.decodedBytes !== decodedBytes || decodedBytes > MAX_RESTORE_PACK_DECODED_BYTES) throw new Error("Canonical restore pack metadata is invalid.")
}

function metadata(file: { path: string; bytes: Uint8Array }): { path: string; size: number } {
  return { path: file.path, size: file.bytes.byteLength }
}

function entryName(domain: Domain, path: string): string {
  return `${domain}/${path}`
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
