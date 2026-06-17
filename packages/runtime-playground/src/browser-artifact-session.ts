import { basename, join } from "node:path"

import type { ArtifactProvenanceMetadata } from "@automattic/wp-codebox-core"
import { ArtifactBundleWriter } from "./artifact-bundle-writer.js"
import { browserArtifactFileManifest, type BrowserArtifactFiles } from "./browser-artifacts.js"

export class BrowserArtifactSession {
  readonly writer: ArtifactBundleWriter

  constructor(
    artifactRoot: string,
    private readonly browserFilesDirectory: string,
    private readonly provenance: ArtifactProvenanceMetadata = { source: "browser", operation: "capture-browser-artifact" },
  ) {
    this.writer = new ArtifactBundleWriter(artifactRoot)
  }

  path(fileName: string): string {
    return join(this.browserFilesDirectory, basename(fileName))
  }

  absolutePath(fileName: string): string {
    return this.writer.path(this.path(fileName))
  }

  async writeText(key: keyof BrowserArtifactFiles, fileName: string, contents: string): Promise<void> {
    await this.writer.write(this.path(fileName), contents, this.manifest(key))
  }

  async writeBuffer(key: keyof BrowserArtifactFiles, fileName: string, contents: Buffer): Promise<void> {
    await this.writer.write(this.path(fileName), contents, this.manifest(key))
  }

  async writeJson(key: keyof BrowserArtifactFiles, fileName: string, value: unknown): Promise<void> {
    await this.writer.writeJson(this.path(fileName), value, this.manifestWithoutContentType(key))
  }

  async writeJsonLines(key: keyof BrowserArtifactFiles, fileName: string, records: unknown[]): Promise<void> {
    await this.writer.writeJsonLines(this.path(fileName), records, this.manifestWithoutContentType(key))
  }

  async writeGenerated(key: keyof BrowserArtifactFiles, fileName: string, write: (absolutePath: string) => Promise<void>): Promise<void> {
    await this.writer.writeGenerated(this.path(fileName), this.manifest(key), write)
  }

  private manifest(key: keyof BrowserArtifactFiles) {
    return {
      ...browserArtifactFileManifest(key),
      provenance: this.provenance,
    }
  }

  private manifestWithoutContentType(key: keyof BrowserArtifactFiles) {
    const { contentType: _contentType, ...manifest } = this.manifest(key)
    return manifest
  }
}
