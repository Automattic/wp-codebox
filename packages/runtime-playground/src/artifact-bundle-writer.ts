import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import {
  artifactManifestFile,
  refreshArtifactManifestFileSha256s,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactViewerMetadata,
} from "@automattic/wp-codebox-core"
import type { ArtifactRedactor } from "./artifacts.js"

export interface ManifestedArtifactFileInput {
  path: string
  kind: ArtifactManifestFile["kind"]
  contentType: string
  viewer?: ArtifactViewerMetadata
}

export interface RedactArtifactFilesOptions {
  tolerateMissing?: boolean
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

  async writeRedacted(path: string, contents: string, redactor: ArtifactRedactor, manifest: Omit<ManifestedArtifactFileInput, "path">): Promise<void> {
    await this.write(path, redactor.redact(path, contents), manifest)
  }

  async writeRedactedJson(path: string, value: unknown, redactor: ArtifactRedactor, manifest: Omit<ManifestedArtifactFileInput, "path" | "contentType"> & { contentType?: string }): Promise<void> {
    await this.writeRedacted(path, artifactJson(value), redactor, {
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
    await writeFile(this.path(this.manifestPath), artifactJson(manifest))
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

export async function writeRedactedArtifactFile(artifactRoot: string, path: string, contents: string, redactor: ArtifactRedactor): Promise<void> {
  await writeFile(path, redactor.redact(artifactManifestRelativePath(artifactRoot, path), contents))
}

export async function redactArtifactFiles(artifactRoot: string, paths: string[], redactor: ArtifactRedactor, options: RedactArtifactFilesOptions = {}): Promise<void> {
  const tolerateMissing = options.tolerateMissing ?? true

  for (const path of paths) {
    const absolutePath = join(artifactRoot, path)
    try {
      await writeRedactedArtifactFile(artifactRoot, absolutePath, await readFile(absolutePath, "utf8"), redactor)
    } catch (error) {
      if (!tolerateMissing) {
        throw error
      }
    }
  }
}
