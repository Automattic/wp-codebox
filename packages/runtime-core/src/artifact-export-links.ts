import { readFile } from "node:fs/promises"

import type { ArtifactFileDigest, ArtifactManifest } from "./artifact-manifest.js"
import { resolveArtifactPath, safeArtifactRelativePath } from "./artifact-paths.js"

export interface ReviewerArtifactExportLink {
  path: string
  kind: string
  contentType: string
  sha256: ArtifactFileDigest
  url: string
}

export interface ReviewerArtifactExportLinks {
  schema: "wp-codebox/reviewer-artifact-export-links/v1"
  artifactId: string
  createdAt: string
  baseUrl: string
  files: ReviewerArtifactExportLink[]
}

export interface ReviewerArtifactExportLinkOptions {
  baseUrl: string
  includeKinds?: string[]
  includePaths?: string[]
}

export async function buildReviewerArtifactExportLinks(bundleDirectory: string, options: ReviewerArtifactExportLinkOptions): Promise<ReviewerArtifactExportLinks> {
  const baseUrl = normalizeReviewerArtifactBaseUrl(options.baseUrl)
  const manifest = JSON.parse(await readFile(resolveArtifactPath(bundleDirectory, "manifest.json").absolutePath, "utf8")) as ArtifactManifest
  const includeKinds = new Set(options.includeKinds ?? [])
  const includePaths = new Set(options.includePaths ?? [])
  const files = manifest.files
    .filter((file) => includeKinds.size === 0 || includeKinds.has(file.kind))
    .filter((file) => includePaths.size === 0 || includePaths.has(file.path))
    .map((file) => ({
      path: safeArtifactRelativePath(file.path),
      kind: file.kind,
      contentType: file.contentType,
      sha256: file.sha256,
      url: reviewerArtifactExportUrl(baseUrl, file.path),
    }))

  return {
    schema: "wp-codebox/reviewer-artifact-export-links/v1",
    artifactId: manifest.id,
    createdAt: new Date().toISOString(),
    baseUrl,
    files,
  }
}

export function normalizeReviewerArtifactBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Reviewer artifact export base URL must use http or https.")
  }
  if (!reviewerSafeArtifactHost(url.hostname)) {
    throw new Error("Reviewer artifact export base URL must not use a localhost, private, or internal host.")
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`
  }
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function reviewerArtifactExportUrl(baseUrl: string, artifactPath: string): string {
  const safePath = safeArtifactRelativePath(artifactPath)
  const encodedPath = safePath.split("/").map((part) => encodeURIComponent(part)).join("/")
  return new URL(encodedPath, normalizeReviewerArtifactBaseUrl(baseUrl)).toString()
}

function reviewerSafeArtifactHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "0.0.0.0" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.")) {
    return false
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) {
    return false
  }
  return !host.endsWith(".local") && !host.endsWith(".internal") && !host.endsWith(".corp") && !host.endsWith(".lan")
}
