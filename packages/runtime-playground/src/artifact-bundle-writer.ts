import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  artifactManifestFile,
  refreshArtifactManifestFileSha256s,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactViewerMetadata,
} from "@automattic/wp-codebox-core"

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

  async write(path: string, contents: string | Buffer, manifest: Omit<ManifestedArtifactFileInput, "path">): Promise<void> {
    this.artifacts.add({ path, ...manifest })
    await mkdir(dirname(this.path(path)), { recursive: true })
    await writeFile(this.path(path), contents)
  }

  async writeJson(path: string, value: unknown, manifest: Omit<ManifestedArtifactFileInput, "path" | "contentType"> & { contentType?: string }): Promise<void> {
    await this.write(path, `${JSON.stringify(value, null, 2)}\n`, {
      ...manifest,
      contentType: manifest.contentType ?? "application/json",
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
    await refreshArtifactManifestFileSha256s(this.directory, manifest, this.manifestPath)
    await this.writeManifestJson(manifest)
    await refreshArtifactManifestFileSha256s(this.directory, manifest, this.manifestPath)
    await this.writeManifestJson(manifest)
    return manifest
  }

  private async writeManifestJson(manifest: ArtifactManifest): Promise<void> {
    await mkdir(dirname(this.path(this.manifestPath)), { recursive: true })
    await writeFile(this.path(this.manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
  }
}
