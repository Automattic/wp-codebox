import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { artifactManifestRelativePath } from "@automattic/wp-codebox-core"
import type { ArtifactRedactor } from "./artifacts.js"

export { ArtifactBundleWriter, ManifestedArtifactSet, artifactJson, artifactJsonLines, artifactManifestRelativePath, type ManifestedArtifactFileInput } from "@automattic/wp-codebox-core"

export interface RedactArtifactFilesOptions {
  tolerateMissing?: boolean
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
