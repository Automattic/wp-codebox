import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { RuntimeInfo } from "./index.js"
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
    | "test-results"
    | (string & {})
  contentType: string
  sha256: ArtifactFileDigest
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

export async function calculateArtifactContentDigest(directory: string, inputs: string[]): Promise<string> {
  const hash = createHash("sha256").update("wp-codebox/artifact-content/v1\n")
  for (const [index, input] of inputs.entries()) {
    if (index > 0) {
      hash.update("\n")
    }
    hash.update(`${input}\n`)
    hash.update(await readFile(join(directory, input)))
  }

  return hash.digest("hex")
}

export async function calculateArtifactManifestFileSha256(directory: string, manifest: ArtifactManifest, file: ArtifactManifestFile, manifestFileName = "manifest.json"): Promise<string> {
  if (file.path === manifestFileName) {
    return calculateArtifactManifestSelfSha256(manifest, manifestFileName)
  }

  return createHash("sha256").update(await readFile(join(directory, file.path))).digest("hex")
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
      ? { ...file, sha256: { algorithm: "sha256", value: "0".repeat(64) } }
      : file),
  }
}
