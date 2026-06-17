export interface ExternalSourcePolicyInput {
  type: string
  host: string
}

export interface SourcePolicyIssue {
  code: string
  message: string
}

export interface SourcePolicySnapshot {
  host: string
  maxDownloadBytes: number
  maxExtractedBytes: number
  maxExtractedFiles: number
  sha256Required: boolean
}

export const ALLOW_NETWORK_DOWNLOADS_ENV = "WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS"
export const ALLOWED_DOWNLOAD_HOSTS_ENV = "WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS"
export const REQUIRE_SOURCE_SHA256_ENV = "WP_CODEBOX_REQUIRE_SOURCE_SHA256"
export const MAX_DOWNLOAD_BYTES_ENV = "WP_CODEBOX_MAX_DOWNLOAD_BYTES"
export const MAX_EXTRACTED_BYTES_ENV = "WP_CODEBOX_MAX_EXTRACTED_BYTES"
export const MAX_EXTRACTED_FILES_ENV = "WP_CODEBOX_MAX_EXTRACTED_FILES"

const DEFAULT_ALLOWED_DOWNLOAD_HOSTS = ["downloads.wordpress.org"]
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_FILES = 5000

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

export function evaluateSourcePolicy(source: ExternalSourcePolicyInput, expectedSha256?: string): SourcePolicyIssue[] {
  if (source.type === "local") {
    return []
  }

  const issues: SourcePolicyIssue[] = []
  if (process.env[ALLOW_NETWORK_DOWNLOADS_ENV] !== "1") {
    issues.push({
      code: "network-downloads-disabled",
      message: `External recipe sources require ${ALLOW_NETWORK_DOWNLOADS_ENV}=1 before WP Codebox downloads anything.`,
    })
  }

  if (!allowedDownloadHosts().includes(source.host)) {
    issues.push({
      code: "download-host-not-allowed",
      message: `External recipe source host is not allowed: ${source.host}`,
    })
  }

  if (expectedSha256 !== undefined && !isSha256(expectedSha256)) {
    issues.push({
      code: "invalid-source-sha256",
      message: "External recipe source sha256 must be a 64-character hex digest.",
    })
  }

  if (sourceSha256Required() && !expectedSha256) {
    issues.push({
      code: "missing-source-sha256",
      message: `External recipe sources require sha256 when ${REQUIRE_SOURCE_SHA256_ENV}=1.`,
    })
  }

  return issues
}

export function sourceSha256Required(): boolean {
  return process.env[REQUIRE_SOURCE_SHA256_ENV] === "1"
}

export function allowedDownloadHosts(): string[] {
  const configured = process.env[ALLOWED_DOWNLOAD_HOSTS_ENV]
  return (configured ? configured.split(",") : DEFAULT_ALLOWED_DOWNLOAD_HOSTS)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? "")
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

export function maxDownloadBytes(): number {
  return envPositiveInteger(MAX_DOWNLOAD_BYTES_ENV, DEFAULT_MAX_DOWNLOAD_BYTES)
}

export function maxExtractedBytes(): number {
  return envPositiveInteger(MAX_EXTRACTED_BYTES_ENV, DEFAULT_MAX_EXTRACTED_BYTES)
}

export function maxExtractedFiles(): number {
  return envPositiveInteger(MAX_EXTRACTED_FILES_ENV, DEFAULT_MAX_EXTRACTED_FILES)
}

export function sourcePolicySnapshot(host: string): SourcePolicySnapshot {
  return {
    host,
    maxDownloadBytes: maxDownloadBytes(),
    maxExtractedBytes: maxExtractedBytes(),
    maxExtractedFiles: maxExtractedFiles(),
    sha256Required: sourceSha256Required(),
  }
}
