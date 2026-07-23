export const STATIC_ARTIFACT_IMPORT_REQUEST_SCHEMA = "wp-codebox/cloudflare-static-artifact-import-request/v1"
export const STATIC_ARTIFACT_IMPORT_RESULT_SCHEMA = "wp-codebox/cloudflare-static-artifact-import-result/v1"
export const STATIC_ARTIFACT_SCHEMA = "blocks-engine/php-transformer/site-artifact/v1"
import { DEFAULT_SITE_CONTEXT, siteStorageKeys, type SiteContext } from "./site-context.js"

export const R2_STATIC_ARTIFACT_PREFIX = siteStorageKeys(DEFAULT_SITE_CONTEXT).staticArtifactPrefix
export const MAX_STATIC_ARTIFACT_REQUEST_BYTES = 16 * 1024
export const MAX_STATIC_ARTIFACT_BYTES = 4 * 1024 * 1024
export const MAX_STATIC_ARTIFACT_FILES = 500
export const MAX_STATIC_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024
export const MAX_STATIC_ARTIFACT_DECODED_BYTES = 32 * 1024 * 1024

export interface StaticArtifactImport {
  idempotencyKey: string
  fingerprint: string
  artifactReference: { r2Key: string; sha256: string; size: number }
  artifact: Record<string, unknown>
  options: { slug: string; name: string; siteTitle: string }
}

export async function readStaticArtifactImport(request: Request, bucket: R2Bucket, site: SiteContext = DEFAULT_SITE_CONTEXT): Promise<StaticArtifactImport> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_STATIC_ARTIFACT_REQUEST_BYTES)) throw new StaticArtifactImportError("Static artifact import request exceeds its byte budget.", 413)
  const requestBytes = await readBoundedRequestBytes(request)
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes))
  } catch {
    throw new StaticArtifactImportError("Static artifact import request must be valid UTF-8 JSON.", 400)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new StaticArtifactImportError("Static artifact import request must be an object.", 400)
  const candidate = body as Record<string, unknown>
  if (candidate.schema !== STATIC_ARTIFACT_IMPORT_REQUEST_SCHEMA || typeof candidate.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate.idempotencyKey)) {
    throw new StaticArtifactImportError("Static artifact import request identity is invalid.", 400)
  }
  const reference = candidate.artifact
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new StaticArtifactImportError("Static artifact reference is required.", 400)
  const artifactReference = reference as Record<string, unknown>
  if (typeof artifactReference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifactReference.sha256)
    || artifactReference.r2Key !== `${siteStorageKeys(site).staticArtifactPrefix}/${artifactReference.sha256}.json`
    || !Number.isSafeInteger(artifactReference.size) || (artifactReference.size as number) < 1 || (artifactReference.size as number) > MAX_STATIC_ARTIFACT_BYTES) {
    throw new StaticArtifactImportError("Static artifact reference is invalid or outside its byte budget.", 400)
  }
  const options = candidate.import
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new StaticArtifactImportError("Static artifact import options are required.", 400)
  const importOptions = options as Record<string, unknown>
  const slug = typeof importOptions.slug === "string" ? importOptions.slug : ""
  const name = typeof importOptions.name === "string" ? importOptions.name.trim() : ""
  const siteTitle = typeof importOptions.siteTitle === "string" ? importOptions.siteTitle.trim() : ""
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64 || !name || name.length > 120 || siteTitle.length > 120) throw new StaticArtifactImportError("Static artifact import options are invalid.", 400)

  const object = await bucket.get(artifactReference.r2Key as string)
  if (!object) throw new StaticArtifactImportError("Static artifact is unavailable.", 404)
  if (object.size !== artifactReference.size) throw new StaticArtifactImportError("Static artifact size does not match its reference.", 409)
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (await sha256Hex(bytes) !== artifactReference.sha256) throw new StaticArtifactImportError("Static artifact digest does not match its reference.", 409)
  let artifact: unknown
  try {
    artifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new StaticArtifactImportError("Static artifact must be valid UTF-8 JSON.", 422)
  }
  await validateStaticArtifact(artifact)
  const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify({ sha256: artifactReference.sha256, slug, name, siteTitle })))
  return {
    idempotencyKey: candidate.idempotencyKey,
    fingerprint,
    artifactReference: { r2Key: artifactReference.r2Key as string, sha256: artifactReference.sha256, size: artifactReference.size as number },
    artifact: artifact as Record<string, unknown>,
    options: { slug, name, siteTitle },
  }
}

export class StaticArtifactImportError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export async function readBoundedRequestBytes(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_STATIC_ARTIFACT_REQUEST_BYTES) {
      await reader.cancel()
      throw new StaticArtifactImportError("Static artifact import request exceeds its byte budget.", 413)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function validateStaticArtifact(value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StaticArtifactImportError("Static artifact must be an object.", 422)
  const artifact = value as Record<string, unknown>
  if (artifact.schema !== STATIC_ARTIFACT_SCHEMA || typeof artifact.root !== "string" || !isSafePath(artifact.root)
    || typeof artifact.entrypoint !== "string" || !isSafePath(artifact.entrypoint) || !Array.isArray(artifact.files)
    || artifact.files.length < 1 || artifact.files.length > MAX_STATIC_ARTIFACT_FILES) {
    throw new StaticArtifactImportError("Static artifact contract is invalid.", 422)
  }
  const paths = new Set<string>()
  let decodedBytes = 0
  for (const file of artifact.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new StaticArtifactImportError("Static artifact contains an invalid file.", 422)
    const candidate = file as Record<string, unknown>
    if (typeof candidate.path !== "string" || !isSafePath(candidate.path) || paths.has(candidate.path) || !(candidate.path === artifact.root || candidate.path.startsWith(`${artifact.root}/`))) {
      throw new StaticArtifactImportError("Static artifact contains an invalid file path.", 422)
    }
    paths.add(candidate.path)
    let bytes: Uint8Array
    if (typeof candidate.content === "string" && candidate.content_base64 === undefined) bytes = new TextEncoder().encode(candidate.content)
    else if (typeof candidate.content_base64 === "string" && candidate.content === undefined) bytes = decodeBase64(candidate.content_base64)
    else throw new StaticArtifactImportError("Static artifact file content is invalid.", 422)
    if (bytes.byteLength > MAX_STATIC_ARTIFACT_FILE_BYTES) throw new StaticArtifactImportError("Static artifact file exceeds its byte budget.", 413)
    decodedBytes += bytes.byteLength
    if (decodedBytes > MAX_STATIC_ARTIFACT_DECODED_BYTES) throw new StaticArtifactImportError("Static artifact exceeds its decoded byte budget.", 413)
    if (candidate.bytes !== undefined && candidate.bytes !== bytes.byteLength) throw new StaticArtifactImportError("Static artifact file size does not match its metadata.", 422)
    if (candidate.sha256 !== undefined && (typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256) || await sha256Hex(bytes) !== candidate.sha256)) throw new StaticArtifactImportError("Static artifact file digest does not match its content.", 422)
  }
  if (!paths.has(artifact.entrypoint)) throw new StaticArtifactImportError("Static artifact entrypoint is unavailable.", 422)
}

function isSafePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((segment) => !!segment && segment !== "." && segment !== "..")
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new StaticArtifactImportError("Static artifact contains invalid base64 content.", 422)
  const decoded = atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
