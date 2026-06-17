import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import { artifactFileDigest, artifactManifestFile, type ArtifactManifestFile, type ArtifactManifestFileOptions } from "./artifact-manifest.js"
import { resolveArtifactPath, safeArtifactRelativePath } from "./artifact-paths.js"
import { containsSecretLikeValue, redactString } from "./redaction.js"

export interface ArtifactPartInput {
  root: string
  path: string
  kind: ArtifactManifestFile["kind"]
  contentType: string
  contents: string | Buffer
  redaction?: ArtifactManifestFileOptions["redaction"]
  provenance?: ArtifactManifestFileOptions["provenance"]
}

export interface ArtifactPart {
  path: string
  absolutePath: string
  bytes: number
  manifestFile: ArtifactManifestFile
}

export interface CapturedArtifactFileInput {
  sourcePath?: string
  root: string
  path: string
  kind: ArtifactManifestFile["kind"]
  contentType?: string
  contents?: string | Buffer
  allowedRoots?: string[]
  maxBytes?: number
  redact?: (path: string, contents: string) => string
  skipSensitiveText?: boolean
  redaction?: ArtifactManifestFileOptions["redaction"]
  provenance?: ArtifactManifestFileOptions["provenance"]
}

export type CapturedArtifactFileStatus = "captured" | "skipped" | "oversized" | "sensitive" | "failed"

export interface CapturedArtifactFile {
  schema: "wp-codebox/captured-artifact-file/v1"
  status: CapturedArtifactFileStatus
  path: string
  absolutePath?: string
  sourcePath?: string
  bytes?: number
  originalBytes?: number
  sha256?: string
  contentType?: string
  binary?: boolean
  reason?: string
  error?: string
  limit?: {
    maxBytes?: number
    allowedRoots?: string[]
  }
  manifestFile?: ArtifactManifestFile
}

export const DEFAULT_CAPTURED_ARTIFACT_MAX_BYTES = 1024 * 1024

export async function writeArtifactPart(input: ArtifactPartInput): Promise<ArtifactPart> {
  const { relativePath, absolutePath } = resolveArtifactPath(input.root, input.path)
  const contents = typeof input.contents === "string" ? input.contents : Buffer.from(input.contents)

  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)

  const manifestFile = artifactManifestFile(relativePath, input.kind, input.contentType, artifactFileDigest(contents), {
    redaction: input.redaction,
    provenance: input.provenance,
  })

  return {
    path: relativePath,
    absolutePath,
    bytes: Buffer.byteLength(contents),
    manifestFile,
  }
}

export async function captureArtifactFile(input: CapturedArtifactFileInput): Promise<CapturedArtifactFile> {
  const { relativePath, absolutePath } = resolveArtifactPath(input.root, input.path)
  const maxBytes = input.maxBytes ?? DEFAULT_CAPTURED_ARTIFACT_MAX_BYTES
  const allowedRoots = await Promise.all((input.allowedRoots ?? [input.root]).map((root) => realpath(root).catch(() => resolve(root))))

  try {
    const contents = input.contents === undefined ? await readAllowedSource(input.sourcePath, allowedRoots, maxBytes) : Buffer.isBuffer(input.contents) ? input.contents : Buffer.from(input.contents, "utf8")
    if (contents.byteLength > maxBytes) {
      return captureSkipped(input, relativePath, "oversized", "max-bytes-exceeded", { originalBytes: contents.byteLength, maxBytes, allowedRoots })
    }

    const text = contents.toString("utf8")
    const binary = !isReplayableUtf8(contents, text)
    if (!binary && input.skipSensitiveText === true && containsSecretLikeValue(text)) {
      return captureSkipped(input, relativePath, "sensitive", "secret-like-value", { originalBytes: contents.byteLength, maxBytes, allowedRoots })
    }

    const capturedContents = binary ? contents : Buffer.from(input.redact ? input.redact(relativePath, text) : redactString(text), "utf8")
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, capturedContents)
    const manifestFile = artifactManifestFile(relativePath, input.kind, input.contentType ?? (binary ? "application/octet-stream" : "text/plain; charset=utf-8"), artifactFileDigest(capturedContents), {
      redaction: input.redaction,
      provenance: input.provenance,
    })

    return {
      schema: "wp-codebox/captured-artifact-file/v1",
      status: "captured",
      path: relativePath,
      absolutePath,
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
      bytes: capturedContents.byteLength,
      originalBytes: contents.byteLength,
      sha256: manifestFile.sha256.value,
      contentType: manifestFile.contentType,
      binary,
      manifestFile,
      limit: { maxBytes, allowedRoots },
    }
  } catch (error) {
    if (error instanceof OversizedArtifactError) {
      return captureSkipped(input, relativePath, "oversized", "max-bytes-exceeded", { originalBytes: error.bytes, maxBytes, allowedRoots })
    }
    return captureSkipped(input, relativePath, "failed", "capture-failed", { maxBytes, allowedRoots, error: error instanceof Error ? error.message : String(error) })
  }
}

export function normalizeArtifactPartPath(path: string): string {
  return safeArtifactRelativePath(path)
}

async function readAllowedSource(sourcePath: string | undefined, allowedRoots: string[], maxBytes: number): Promise<Buffer> {
  if (!sourcePath) {
    throw new Error("Captured artifact sourcePath is required when contents are not provided")
  }
  const resolvedSource = await realpath(sourcePath)
  if (!allowedRoots.some((root) => pathIsWithinRoot(root, resolvedSource))) {
    throw new Error(`Captured artifact source path is outside allowed roots: ${sourcePath}`)
  }
  const sourceStats = await stat(resolvedSource)
  if (!sourceStats.isFile()) {
    throw new Error(`Captured artifact source path is not a file: ${sourcePath}`)
  }
  if (sourceStats.size > maxBytes) {
    throw new OversizedArtifactError(sourceStats.size)
  }
  return readFile(resolvedSource)
}

function pathIsWithinRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

class OversizedArtifactError extends Error {
  constructor(readonly bytes: number) {
    super("Captured artifact source exceeds max bytes")
  }
}

function captureSkipped(input: CapturedArtifactFileInput, path: string, status: CapturedArtifactFileStatus, reason: string, extra: { originalBytes?: number; maxBytes?: number; allowedRoots?: string[]; error?: string }): CapturedArtifactFile {
  return {
    schema: "wp-codebox/captured-artifact-file/v1",
    status,
    path,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(extra.originalBytes !== undefined ? { originalBytes: extra.originalBytes } : {}),
    reason,
    ...(extra.error ? { error: extra.error } : {}),
    limit: { maxBytes: extra.maxBytes, allowedRoots: extra.allowedRoots },
  }
}

function isReplayableUtf8(buffer: Buffer, text: string): boolean {
  return !text.includes("\uFFFD") && Buffer.from(text, "utf8").equals(buffer)
}
