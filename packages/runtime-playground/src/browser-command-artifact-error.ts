import { browserArtifactFileManifest, type BrowserArtifact, type BrowserArtifactFiles } from "./browser-artifacts.js"
import { sanitizeBrowserArtifact, sanitizeBrowserResultValue } from "./browser-result-sanitization.js"

export class BrowserCommandArtifactError extends Error {
  readonly artifact: BrowserArtifact
  readonly artifactRefs

  constructor(message: string, artifact: BrowserArtifact, readonly artifactRoot?: string) {
    super(sanitizeBrowserResultValue(message, "message"))
    this.name = "BrowserCommandArtifactError"
    Object.assign(artifact, sanitizeBrowserArtifact(artifact))
    this.artifact = artifact
    this.artifactRefs = Object.entries(artifact.files).flatMap(([key, value]) => {
      const manifest = browserArtifactFileManifest(key as keyof BrowserArtifactFiles)
      return (Array.isArray(value) ? value : [value]).flatMap((path, index) => typeof path === "string" ? [{ kind: manifest.kind, id: `${artifact.artifactType}:${key}:${index}`, path, contentType: manifest.contentType }] : [])
    })
  }
}

export function isBrowserCommandArtifactError(error: unknown): error is BrowserCommandArtifactError {
  return error instanceof BrowserCommandArtifactError
}
