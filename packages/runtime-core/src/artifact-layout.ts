import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

import { artifactManifestFile, refreshArtifactManifestFileSha256s, type ArtifactManifest, type ArtifactManifestFile, type ArtifactManifestFileOptions, type ArtifactViewerMetadata } from "./artifact-manifest.js"
import { resolveArtifactPath, safeArtifactRelativePath } from "./artifact-paths.js"

export interface ManifestedArtifactFileInput {
  path: string
  kind: ArtifactManifestFile["kind"]
  contentType: string
  viewer?: ArtifactViewerMetadata
  redaction?: ArtifactManifestFileOptions["redaction"]
  provenance?: ArtifactManifestFileOptions["provenance"]
}

export class ManifestedArtifactSet {
  private readonly entries = new Map<string, ArtifactManifestFile>()

  add(input: ManifestedArtifactFileInput): ArtifactManifestFile {
    const entry = artifactManifestFile(input.path, input.kind, input.contentType, undefined, {
      viewer: input.viewer,
      redaction: input.redaction,
      provenance: input.provenance,
    })
    this.entries.set(input.path, entry)
    return entry
  }

  files(): ArtifactManifestFile[] {
    return [...this.entries.values()]
  }
}

export class ArtifactBundleWriter {
  readonly artifacts = new ManifestedArtifactSet()

  constructor(
    private readonly directory: string,
    private readonly manifestPath = "manifest.json",
  ) {}

  path(path: string): string {
    return resolveArtifactPath(this.directory, path).absolutePath
  }

  relativePath(path: string): string {
    return artifactManifestRelativePath(this.directory, path)
  }

  async write(path: string, contents: string | Buffer, manifest: Omit<ManifestedArtifactFileInput, "path">): Promise<void> {
    this.artifacts.add({ path, ...manifest })
    await mkdir(dirname(this.path(path)), { recursive: true })
    await writeFile(this.path(path), contents)
  }

  async writeJson(path: string, value: unknown, manifest: Omit<ManifestedArtifactFileInput, "path" | "contentType"> & { contentType?: string }): Promise<void> {
    await this.write(path, artifactJson(value), {
      ...manifest,
      contentType: manifest.contentType ?? "application/json",
    })
  }

  async writeJsonLines(path: string, records: unknown[], manifest: Omit<ManifestedArtifactFileInput, "path" | "contentType"> & { contentType?: string }): Promise<void> {
    await this.write(path, artifactJsonLines(records), {
      ...manifest,
      contentType: manifest.contentType ?? "application/x-ndjson",
    })
  }

  async writeGenerated(path: string, manifest: Omit<ManifestedArtifactFileInput, "path">, write: (absolutePath: string) => Promise<void>): Promise<void> {
    this.artifacts.add({ path, ...manifest })
    await mkdir(dirname(this.path(path)), { recursive: true })
    await write(this.path(path))
  }

  async importFile(path: string, sourcePath: string, manifest: Omit<ManifestedArtifactFileInput, "path">): Promise<void> {
    await this.writeGenerated(path, manifest, async (destinationPath) => {
      await copyFile(sourcePath, destinationPath)
    })
  }

  async writeManifest<T extends ArtifactManifest>(manifest: T): Promise<T> {
    this.artifacts.add({ path: this.manifestPath, kind: "manifest", contentType: "application/json" })
    manifest.files = this.artifacts.files()
    await writeArtifactManifestJson(this.directory, this.manifestPath, manifest)
    return manifest
  }
}

export function artifactJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function artifactJsonLines(records: unknown[]): string {
  return records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : ""
}

export function artifactManifestRelativePath(artifactRoot: string, path: string): string {
  const root = resolve(artifactRoot)
  const absolutePath = isAbsolute(path) ? resolve(path) : resolveArtifactPath(root, path).absolutePath
  const relativePath = relative(root, absolutePath).replace(/\\/g, "/")
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new Error(`Artifact path must stay inside the artifact root: ${path}`)
  }
  return safeArtifactRelativePath(relativePath)
}

export async function writeArtifactJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, artifactJson(value))
}

export async function writeArtifactManifestJson(directory: string, manifestPath: string, manifest: ArtifactManifest): Promise<void> {
  await refreshArtifactManifestFileSha256s(directory, manifest, manifestPath)
  await writeArtifactJson(resolveArtifactPath(directory, manifestPath).absolutePath, manifest)
  await refreshArtifactManifestFileSha256s(directory, manifest, manifestPath)
  await writeArtifactJson(resolveArtifactPath(directory, manifestPath).absolutePath, manifest)
}
