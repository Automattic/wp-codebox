import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import type { RuntimeInfo } from "./runtime-contracts.js"
import { resolveArtifactPath } from "./artifact-paths.js"
import { stableJson } from "./object-utils.js"

export interface ArtifactSpec {
  includeFiles?: boolean
  includeLogs?: boolean
  includePatch?: boolean
  includeScreenshots?: boolean
  includeObservations?: boolean
  includeRuntimeSnapshotBundles?: boolean
  previewHoldSeconds?: number
}

export interface ArtifactManifestFile {
  path: string
  kind:
    | "manifest"
    | "metadata"
    | "events"
    | "commands"
    | "observations"
    | "log"
    | "mounts"
    | "file"
    | "diagnostics"
    | "test-results"
    | "tool-call-transcript"
    | "tool-call-input"
    | "tool-call-output"
    | (string & {})
  contentType: string
  sha256: ArtifactFileDigest
  redaction?: ArtifactRedactionMetadata
  provenance?: ArtifactProvenanceMetadata
  viewer?: ArtifactViewerMetadata
}

export interface ArtifactRedactionMetadata {
  policy: "none" | "required" | "applied" | (string & {})
  reason?: string
  sensitive?: boolean
}

export interface ArtifactProvenanceMetadata {
  source: string
  operation?: string
  id?: string
  metadata?: Record<string, unknown>
}

export interface ArtifactViewerMetadata {
  kind: string
  base: string
  query: {
    parameter: string
    value: {
      source: "public-artifact-url" | (string & {})
      path: string
      kind?: string
      contentType?: string
      sha256?: ArtifactFileDigest
    }
    encoding: "url" | (string & {})
  }
  replay: {
    status: "full" | "partial" | "unavailable" | (string & {})
    limitations: string[]
  }
}

export interface ArtifactFileDigest {
  algorithm: "sha256"
  value: string
}

export interface ArtifactManifest {
  id: string
  contentDigest: ArtifactContentDigest
  createdAt: string
  runtime: RuntimeInfo
  files: ArtifactManifestFile[]
}

export interface ArtifactContentDigest {
  algorithm: "sha256"
  inputs: string[]
  value: string
}

const EMPTY_SHA256 = "0".repeat(64)

export function artifactFileDigest(contents: string | Buffer): ArtifactFileDigest {
  return { algorithm: "sha256", value: createHash("sha256").update(contents).digest("hex") }
}

export interface ArtifactManifestFileOptions {
  viewer?: ArtifactViewerMetadata
  redaction?: ArtifactRedactionMetadata
  provenance?: ArtifactProvenanceMetadata
}

export function artifactManifestFile(path: string, kind: ArtifactManifestFile["kind"], contentType: string, sha256: ArtifactFileDigest = placeholderArtifactFileDigest(), viewerOrOptions?: ArtifactViewerMetadata | ArtifactManifestFileOptions): ArtifactManifestFile {
  const options = artifactManifestFileOptions(viewerOrOptions)
  return stripUndefined({ path, kind, contentType, sha256, ...options })
}

export function artifactManifestFileWithSha256(path: string, kind: ArtifactManifestFile["kind"], contentType: string, sha256: string): ArtifactManifestFile {
  return artifactManifestFile(path, kind, contentType, { algorithm: "sha256", value: sha256 })
}

export function placeholderArtifactFileDigest(): ArtifactFileDigest {
  return { algorithm: "sha256", value: EMPTY_SHA256 }
}

export async function calculateArtifactContentDigest(directory: string, inputs: string[]): Promise<string> {
  const hash = createHash("sha256").update("wp-codebox/artifact-content/v1\n")
  for (const [index, input] of inputs.entries()) {
    if (index > 0) {
      hash.update("\n")
    }
    hash.update(`${input}\n`)
    hash.update(await readFile(resolveArtifactPath(directory, input).absolutePath))
  }

  return hash.digest("hex")
}

export async function calculateArtifactManifestFileSha256(directory: string, manifest: ArtifactManifest, file: ArtifactManifestFile, manifestFileName = "manifest.json"): Promise<string> {
  if (file.path === manifestFileName) {
    return calculateArtifactManifestSelfSha256(manifest, manifestFileName)
  }

  return artifactFileDigest(await readFile(resolveArtifactPath(directory, file.path).absolutePath)).value
}

export function calculateArtifactManifestSelfSha256(manifest: ArtifactManifest, manifestFileName = "manifest.json"): string {
  return createHash("sha256")
    .update("wp-codebox/artifact-manifest-self/v1\n")
    .update(stableJson(manifestWithPlaceholderSelfHash(manifest, manifestFileName)))
    .digest("hex")
}

export function upsertArtifactManifestFiles(manifest: ArtifactManifest, files: ArtifactManifestFile[]): void {
  manifest.files = Array.isArray(manifest.files) ? manifest.files : []
  for (const file of files) {
    const existing = manifest.files.find((entry) => entry.path === file.path)
    if (existing) {
      Object.assign(existing, file)
    } else {
      manifest.files.push(file)
    }
  }
}

export async function refreshArtifactManifestFileSha256s(directory: string, manifest: ArtifactManifest, manifestFileName = "manifest.json"): Promise<void> {
  for (const file of manifest.files) {
    if (file.path !== manifestFileName) {
      file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, file, manifestFileName) }
    }
  }
  for (const file of manifest.files) {
    if (file.path === manifestFileName) {
      file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, file, manifestFileName) }
    }
  }
}

function manifestWithPlaceholderSelfHash(manifest: ArtifactManifest, manifestFileName: string): ArtifactManifest {
  return {
    ...manifest,
    files: manifest.files.map((file) => file.path === manifestFileName
      ? { ...file, sha256: placeholderArtifactFileDigest() }
      : file),
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function artifactManifestFileOptions(viewerOrOptions: ArtifactViewerMetadata | ArtifactManifestFileOptions | undefined): ArtifactManifestFileOptions {
  if (!viewerOrOptions) {
    return {}
  }
  if ("base" in viewerOrOptions && "query" in viewerOrOptions && "replay" in viewerOrOptions) {
    return { viewer: viewerOrOptions }
  }
  return viewerOrOptions
}
