import type { BrowserArtifact } from "./browser-artifacts.js"
import { sanitizeBrowserArtifact, sanitizeBrowserResultValue } from "./browser-result-sanitization.js"

export class BrowserCommandArtifactError extends Error {
  readonly artifact: BrowserArtifact

  constructor(message: string, artifact: BrowserArtifact, readonly artifactRoot?: string) {
    super(sanitizeBrowserResultValue(message, "message"))
    this.name = "BrowserCommandArtifactError"
    Object.assign(artifact, sanitizeBrowserArtifact(artifact))
    this.artifact = artifact
  }
}

export function isBrowserCommandArtifactError(error: unknown): error is BrowserCommandArtifactError {
  return error instanceof BrowserCommandArtifactError
}
