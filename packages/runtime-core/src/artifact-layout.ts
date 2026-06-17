import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { artifactManifestFile, refreshArtifactManifestFileSha256s, type ArtifactManifest, type ArtifactManifestFile, type ArtifactViewerMetadata } from "./artifact-manifest.js"

export interface ManifestedArtifactFileInput {
  path: string
  kind: ArtifactManifestFile["kind"]
  contentType: string
  viewer?: ArtifactViewerMetadata
}

export class ManifestedArtifactSet {
  private readonly entries = new Map<string, ArtifactManifestFile>()

  add(input: ManifestedArtifactFileInput): ArtifactManifestFile {
    const entry = artifactManifestFile(input.path, input.kind, input.contentType, undefined, input.viewer)
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
    return join(this.directory, path)
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
  return relative(artifactRoot, path).replace(/\\/g, "/")
}

export async function writeArtifactJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, artifactJson(value))
}

export async function writeArtifactManifestJson(directory: string, manifestPath: string, manifest: ArtifactManifest): Promise<void> {
  await refreshArtifactManifestFileSha256s(directory, manifest, manifestPath)
  await writeArtifactJson(join(directory, manifestPath), manifest)
  await refreshArtifactManifestFileSha256s(directory, manifest, manifestPath)
  await writeArtifactJson(join(directory, manifestPath), manifest)
}
