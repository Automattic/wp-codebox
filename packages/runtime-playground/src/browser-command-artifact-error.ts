import type { BrowserArtifact } from "./browser-artifacts.js"

export class BrowserCommandArtifactError extends Error {
  constructor(message: string, readonly artifact: BrowserArtifact, readonly artifactRoot?: string) {
    super(message)
    this.name = "BrowserCommandArtifactError"
  }
}

export function isBrowserCommandArtifactError(error: unknown): error is BrowserCommandArtifactError {
  return error instanceof BrowserCommandArtifactError
}
