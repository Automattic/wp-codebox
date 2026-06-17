import { readFile } from "node:fs/promises"
import { join, normalize } from "node:path"
import { artifactFileDigest } from "./artifact-manifest.js"
import { verifyArtifactBundle, type ArtifactBundleVerificationResult, type ArtifactBundleVerificationViolation } from "./artifact-bundle-verifier.js"
import type { ArtifactManifest, ArtifactManifestFile } from "./artifact-manifest.js"
import { isPlainObject as isRecord } from "./object-utils.js"
import { containsSecretLikeValue, isRedactedValue, isSensitiveKey } from "./redaction.js"

export type TransferProofViolationCode =
  | "artifact-bundle-invalid"
  | "missing-transfer-artifact"
  | "malformed-transfer-artifact"
  | "transfer-digest-mismatch"
  | "unsafe-reviewer-evidence"

export type TransferProofRuntimeRole = "source" | "target" | "sandbox" | (string & {})

export interface TransferProofArtifactRef {
  path: string
  kind: string
  contentType?: string
  sha256?: {
    algorithm: "sha256"
    value: string
  }
  digest?: {
    algorithm: "sha256"
    value: string
  }
}

export interface TransferProofRuntimeRoleBundle {
  role: TransferProofRuntimeRole
  runtimeId?: string
  sessionId?: string
  label?: string
  evidence: {
    sourceInventory?: TransferProofArtifactRef
    runtime?: TransferProofArtifactRef
    targetBefore?: TransferProofArtifactRef
    targetAfter?: TransferProofArtifactRef
    sandboxRehearsal?: TransferProofArtifactRef
    previewEvidence?: TransferProofArtifactRef
    previewSessionEvidence?: TransferProofArtifactRef
    probes?: TransferProofArtifactRef[]
    diagnostics?: TransferProofArtifactRef[]
    digestRefs?: TransferProofArtifactRef[]
    [name: string]: TransferProofArtifactRef | TransferProofArtifactRef[] | undefined
  }
}

export interface TransferProofBundle {
  schema: "wp-codebox/transfer-proof-bundle/v1"
  createdAt?: string
  summary?: string
  roles: TransferProofRuntimeRoleBundle[]
  previewSessionEvidence?: TransferProofArtifactRef
  digestRefs?: TransferProofArtifactRef[]
}

export interface TransferProofViolation {
  code: TransferProofViolationCode
  path: string
  message: string
  file?: string
  details?: Record<string, unknown>
}

export interface TransferProofBundleVerificationResult {
  schema: "wp-codebox/transfer-proof-bundle-verification/v1"
  bundleDirectory: string
  valid: boolean
  artifactVerification: ArtifactBundleVerificationResult
  violations: TransferProofViolation[]
  diagnostics: TransferProbeDiagnosticsResult
}

export interface TransferProofVerificationOptions {
  privateHostPatterns?: string[]
}

export type TransferProbeDiagnosticCode =
  | "page-unavailable"
  | "broken-link"
  | "missing-media"
  | "block-validation-error"
  | "plugin-runtime-diagnostic"
  | "browser-runtime-error"
  | "visual-content-parity"

export interface TransferProbeDiagnostic {
  code: TransferProbeDiagnosticCode
  severity: "error" | "warning" | "info"
  message: string
  probe?: string
  artifact?: string
  url?: string
  details?: Record<string, unknown>
}

export interface TransferProbeDiagnosticsResult {
  schema: "wp-codebox/transfer-probe-diagnostics/v1"
  bundleDirectory: string
  status: "passed" | "failed"
  summary: {
    total: number
    errors: number
    warnings: number
    browserProbes: number
  }
  probes: {
    pageAvailability: TransferProbeDiagnostic[]
    brokenLinksAndMissingMedia: TransferProbeDiagnostic[]
    blockValidation: TransferProbeDiagnostic[]
    pluginRuntime: TransferProbeDiagnostic[]
    visualContentParity: TransferProbeDiagnostic[]
    runtimeErrors: TransferProbeDiagnostic[]
  }
  diagnostics: TransferProbeDiagnostic[]
}

type JsonPath = Array<string | number>

const REQUIRED_TRANSFER_KINDS = new Set(["preview-evidence", "preview-session-evidence", "runtime-reference-manifest", "runtime-replay-index", "diagnostics", "log", "review"])
const TRANSFER_PROOF_SECRET_KEY_PATTERN = /(?:secret|token|password|credential|private[_-]?key|api[_-]?key|authorization)/i
const REVIEWER_EVIDENCE_KINDS = new Set([
  "transfer-proof-bundle",
  "review",
  "preview-evidence",
  "preview-session-evidence",
  "diagnostics",
  "log",
  "browser-summary",
  "browser-console",
  "browser-errors",
  "browser-network",
  "runtime-reference-manifest",
  "runtime-replay-index",
  "source-inventory",
  "target-before-evidence",
  "target-after-evidence",
  "sandbox-rehearsal-evidence",
  "transfer-digest-ref",
  "probe-results",
])

export async function verifyTransferProofBundle(directory: string, options: TransferProofVerificationOptions = {}): Promise<TransferProofBundleVerificationResult> {
  const bundleDirectory = normalize(directory)
  const resolvedOptions = resolveTransferProofVerificationOptions(options)
  const artifactVerification = await verifyArtifactBundle(bundleDirectory)
  const diagnostics = await buildTransferProbeDiagnostics(bundleDirectory, artifactVerification.manifest)
  const violations: TransferProofViolation[] = artifactVerification.valid ? [] : artifactVerification.violations.map(artifactViolationToTransferViolation)

  if (artifactVerification.manifest) {
    verifyRequiredTransferArtifacts(artifactVerification.manifest, violations)
    await verifyPreviewSessionEvidenceRef(bundleDirectory, artifactVerification.manifest, violations)
    await verifyTransferProofMetadata(bundleDirectory, artifactVerification.manifest, violations, resolvedOptions)
    await verifyReviewerEvidenceSafety(bundleDirectory, artifactVerification.manifest, violations, resolvedOptions)
  }

  return {
    schema: "wp-codebox/transfer-proof-bundle-verification/v1",
    bundleDirectory,
    valid: violations.length === 0 && diagnostics.status === "passed",
    artifactVerification,
    violations,
    diagnostics,
  }
}

export async function buildTransferProbeDiagnostics(directory: string, manifest?: ArtifactManifest): Promise<TransferProbeDiagnosticsResult> {
  const bundleDirectory = normalize(directory)
  const resolvedManifest = manifest ?? await readManifest(bundleDirectory)
  const browserProbes = await readBrowserProbeSummaries(bundleDirectory, resolvedManifest)
  const pageAvailability: TransferProbeDiagnostic[] = []
  const brokenLinksAndMissingMedia: TransferProbeDiagnostic[] = []
  const blockValidation: TransferProbeDiagnostic[] = []
  const pluginRuntime: TransferProbeDiagnostic[] = []
  const visualContentParity: TransferProbeDiagnostic[] = []
  const runtimeErrors: TransferProbeDiagnostic[] = []

  for (const probe of browserProbes) {
    const label = typeof probe.finalUrl === "string" ? probe.finalUrl : typeof probe.url === "string" ? probe.url : "browser probe"
    const errors = numeric(probe.errors)
    if (!probe.finalUrl || errors > 0) {
      pageAvailability.push({ code: "page-unavailable", severity: "error", message: `Browser probe reported unavailable or errored page: ${label}`, probe: label, details: { errors } })
    }
    if (isRecord(probe.assertions) && numeric(probe.assertions.failed) > 0) {
      visualContentParity.push({ code: "visual-content-parity", severity: "warning", message: `Browser probe reported ${numeric(probe.assertions.failed)} failed assertion(s): ${label}`, probe: label, details: { assertions: probe.assertions } })
    }
  }

  for (const file of resolvedManifest?.files ?? []) {
    if (file.kind === "browser-network") {
      brokenLinksAndMissingMedia.push(...await readNetworkDiagnostics(bundleDirectory, file.path))
    }
    if (file.kind === "browser-console" || file.kind === "browser-errors") {
      const diagnostics = await readTextRuntimeDiagnostics(bundleDirectory, file.path)
      blockValidation.push(...diagnostics.filter((diagnostic) => diagnostic.code === "block-validation-error"))
      runtimeErrors.push(...diagnostics.filter((diagnostic) => diagnostic.code === "browser-runtime-error"))
    }
    if (file.kind === "diagnostics") {
      pluginRuntime.push(...await readPluginRuntimeDiagnostics(bundleDirectory, file.path))
    }
  }

  const diagnostics = [pageAvailability, brokenLinksAndMissingMedia, blockValidation, pluginRuntime, visualContentParity, runtimeErrors].flat()
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length

  return {
    schema: "wp-codebox/transfer-probe-diagnostics/v1",
    bundleDirectory,
    status: errors === 0 ? "passed" : "failed",
    summary: {
      total: diagnostics.length,
      errors,
      warnings,
      browserProbes: browserProbes.length,
    },
    probes: {
      pageAvailability,
      brokenLinksAndMissingMedia,
      blockValidation,
      pluginRuntime,
      visualContentParity,
      runtimeErrors,
    },
    diagnostics,
  }
}

function artifactViolationToTransferViolation(violation: ArtifactBundleVerificationViolation): TransferProofViolation {
  return {
    code: "artifact-bundle-invalid",
    path: violation.path,
    message: violation.message,
    ...(violation.file ? { file: violation.file } : {}),
    details: { artifactViolationCode: violation.code, ...(violation.details ?? {}) },
  }
}

function verifyRequiredTransferArtifacts(manifest: ArtifactManifest, violations: TransferProofViolation[]): void {
  const kinds = new Set(manifest.files.map((file) => file.kind))
  for (const kind of REQUIRED_TRANSFER_KINDS) {
    if (!kinds.has(kind)) {
      violations.push({ code: "missing-transfer-artifact", path: "manifest.files", message: `Transfer proof bundle requires a ${kind} artifact.` })
    }
  }
}

function resolveTransferProofVerificationOptions(options: TransferProofVerificationOptions): Required<TransferProofVerificationOptions> {
  return {
    privateHostPatterns: options.privateHostPatterns ?? parsePrivateHostPatterns(process.env.WP_CODEBOX_TRANSFER_PROOF_PRIVATE_HOSTS),
  }
}

function parsePrivateHostPatterns(value: string | undefined): string[] {
  return value?.split(",").map((pattern) => pattern.trim()).filter(Boolean) ?? []
}

async function verifyTransferProofMetadata(directory: string, manifest: ArtifactManifest, violations: TransferProofViolation[], options: Required<TransferProofVerificationOptions>): Promise<void> {
  const metadata = await readJson(join(directory, "metadata.json"))
  const transferProofBundle = isRecord(metadata) && isRecord(metadata.transferProofBundle) ? metadata.transferProofBundle : undefined
  if (!transferProofBundle) {
    return
  }

  for (const finding of unsafeReviewerEvidenceFindings(`${JSON.stringify(transferProofBundle, null, 2)}\n`, "metadata.json", options)) {
    violations.push(finding)
  }

  if (transferProofBundle.schema !== "wp-codebox/transfer-proof-bundle/v1") {
    violations.push({ code: "malformed-transfer-artifact", path: "metadata.transferProofBundle.schema", message: "Transfer proof bundle metadata must use schema wp-codebox/transfer-proof-bundle/v1." })
  }
  if (!Array.isArray(transferProofBundle.roles) || transferProofBundle.roles.length === 0) {
    violations.push({ code: "missing-transfer-artifact", path: "metadata.transferProofBundle.roles", message: "Transfer proof bundle metadata requires at least one runtime role." })
    return
  }

  const seenRoles = new Set<string>()
  for (const [index, roleBundle] of transferProofBundle.roles.entries()) {
    const basePath = `metadata.transferProofBundle.roles[${index}]`
    if (!isRecord(roleBundle)) {
      violations.push({ code: "malformed-transfer-artifact", path: basePath, message: "Transfer proof runtime role must be an object." })
      continue
    }
    const role = typeof roleBundle.role === "string" ? roleBundle.role : ""
    if (!role) {
      violations.push({ code: "malformed-transfer-artifact", path: `${basePath}.role`, message: "Transfer proof runtime role requires a role name." })
    } else if (seenRoles.has(role)) {
      violations.push({ code: "malformed-transfer-artifact", path: `${basePath}.role`, message: `Transfer proof runtime role '${role}' is duplicated.` })
    } else {
      seenRoles.add(role)
    }
    if (!isRecord(roleBundle.evidence)) {
      violations.push({ code: "missing-transfer-artifact", path: `${basePath}.evidence`, message: "Transfer proof runtime role requires evidence refs." })
      continue
    }
    await verifyTransferProofEvidenceRefs(directory, manifest, roleBundle.evidence, `${basePath}.evidence`, violations)
  }

  await verifyTransferProofEvidenceRefs(directory, manifest, transferProofBundle, "metadata.transferProofBundle", violations)
}

async function verifyTransferProofEvidenceRefs(directory: string, manifest: ArtifactManifest, refs: Record<string, unknown>, basePath: string, violations: TransferProofViolation[]): Promise<void> {
  for (const [name, value] of Object.entries(refs)) {
    if (name === "schema" || name === "createdAt" || name === "summary" || name === "roles") {
      continue
    }
    if (isArtifactRef(value)) {
      await verifyTransferProofArtifactRef(directory, manifest, value, `${basePath}.${name}`, violations)
      continue
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (isArtifactRef(item)) {
          await verifyTransferProofArtifactRef(directory, manifest, item, `${basePath}.${name}[${index}]`, violations)
        } else {
          violations.push({ code: "malformed-transfer-artifact", path: `${basePath}.${name}[${index}]`, message: "Transfer proof evidence arrays may only contain artifact refs." })
        }
      }
      continue
    }
    if (value !== undefined) {
      violations.push({ code: "malformed-transfer-artifact", path: `${basePath}.${name}`, message: "Transfer proof evidence values must be artifact refs or arrays of artifact refs." })
    }
  }
}

async function verifyTransferProofArtifactRef(directory: string, manifest: ArtifactManifest, ref: Record<string, unknown>, path: string, violations: TransferProofViolation[]): Promise<void> {
  const artifactPath = typeof ref.path === "string" ? ref.path : undefined
  const kind = typeof ref.kind === "string" ? ref.kind : undefined
  const manifestFile = artifactPath ? manifest.files.find((file) => file.path === artifactPath) : undefined
  if (!artifactPath || !kind || !manifestFile || manifestFile.kind !== kind) {
    violations.push({ code: "missing-transfer-artifact", path, ...(artifactPath ? { file: artifactPath } : {}), message: "Transfer proof evidence ref must point at a manifest file with the same kind." })
    return
  }

  const refDigest = digestValue(ref.sha256) ?? digestValue(ref.digest)
  if (!refDigest) {
    violations.push({ code: "transfer-digest-mismatch", path: `${path}.sha256`, file: artifactPath, message: "Transfer proof evidence ref must include a SHA-256 digest." })
    return
  }

  const actual = artifactFileDigest(await readFile(join(directory, artifactPath))).value
  if (actual !== refDigest || actual !== manifestFile.sha256.value) {
    violations.push({ code: "transfer-digest-mismatch", path: `${path}.sha256`, file: artifactPath, message: "Transfer proof evidence ref digest must match the referenced artifact and manifest file hash." })
  }
}

function isArtifactRef(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.path === "string" && typeof value.kind === "string"
}

function digestValue(value: unknown): string | undefined {
  return isRecord(value) && value.algorithm === "sha256" && typeof value.value === "string" ? value.value : undefined
}

async function verifyPreviewSessionEvidenceRef(directory: string, manifest: ArtifactManifest, violations: TransferProofViolation[]): Promise<void> {
  const metadata = await readJson(join(directory, "metadata.json"))
  const ref = isRecord(metadata) && isRecord(metadata.previewSessionEvidence) ? metadata.previewSessionEvidence : undefined
  if (!ref) {
    violations.push({ code: "missing-transfer-artifact", path: "metadata.previewSessionEvidence", message: "Transfer proof bundle requires preview session evidence ref metadata." })
    return
  }

  const path = typeof ref.path === "string" ? ref.path : undefined
  const sha256 = isRecord(ref.sha256) && ref.sha256.algorithm === "sha256" && typeof ref.sha256.value === "string" ? ref.sha256.value : undefined
  const manifestFile = path ? manifest.files.find((file) => file.path === path && file.kind === "preview-session-evidence") : undefined
  if (!path || !manifestFile) {
    violations.push({ code: "missing-transfer-artifact", path: "metadata.previewSessionEvidence.path", message: "Preview session evidence ref must point at a manifest preview-session-evidence file." })
    return
  }
  if (!sha256) {
    violations.push({ code: "transfer-digest-mismatch", path: "metadata.previewSessionEvidence.sha256", file: path, message: "Preview session evidence ref must include a SHA-256 digest." })
    return
  }

  const actual = artifactFileDigest(await readFile(join(directory, path))).value
  if (actual !== sha256 || actual !== manifestFile.sha256.value) {
    violations.push({ code: "transfer-digest-mismatch", path: "metadata.previewSessionEvidence.sha256", file: path, message: "Preview session evidence ref digest must match the referenced artifact and manifest file hash." })
  }
}

async function verifyReviewerEvidenceSafety(directory: string, manifest: ArtifactManifest, violations: TransferProofViolation[], options: Required<TransferProofVerificationOptions>): Promise<void> {
  for (const file of manifest.files) {
    if (!REVIEWER_EVIDENCE_KINDS.has(file.kind)) {
      continue
    }
    const text = await readFile(join(directory, file.path), "utf8")
    for (const finding of unsafeReviewerEvidenceFindings(text, file.path, options)) {
      violations.push(finding)
    }
  }
}

function unsafeReviewerEvidenceFindings(text: string, file: string, options: Required<TransferProofVerificationOptions>): TransferProofViolation[] {
  const findings: TransferProofViolation[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }

  if (parsed !== undefined) {
    walkReviewerEvidence(parsed, [], file, findings, options)
  } else {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      scanReviewerEvidenceString(line, [`line:${index + 1}`], file, findings, options)
    }
  }
  return findings
}

function walkReviewerEvidence(value: unknown, path: JsonPath, file: string, findings: TransferProofViolation[], options: Required<TransferProofVerificationOptions>): void {
  if (typeof value === "string") {
    scanReviewerEvidenceString(value, path, file, findings, options)
    if (isSecretKeyPath(path) && !isRedactedValue(value)) {
      findings.push(unsafeFinding(file, path, "secret-shaped value", "Reviewer-facing evidence includes a secret-shaped field value."))
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkReviewerEvidence(item, [...path, index], file, findings, options))
    return
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      walkReviewerEvidence(item, [...path, key], file, findings, options)
    }
  }
}

function scanReviewerEvidenceString(value: string, path: JsonPath, file: string, findings: TransferProofViolation[], options: Required<TransferProofVerificationOptions>): void {
  if (unsafeUrl(value, options)) {
    findings.push(unsafeFinding(file, path, "unsafe URL", "Reviewer-facing evidence includes a localhost, local, or private URL."))
  }
  if (unsafeLocalPath(value)) {
    findings.push(unsafeFinding(file, path, "local path", "Reviewer-facing evidence includes a host-local filesystem path."))
  }
  if (secretShapedValue(value)) {
    findings.push(unsafeFinding(file, path, "secret-shaped value", "Reviewer-facing evidence includes a secret-shaped value."))
  }
}

function unsafeFinding(file: string, path: JsonPath, kind: string, message: string): TransferProofViolation {
  return { code: "unsafe-reviewer-evidence", path: `${file}:${formatJsonPath(path)}`, file, message, details: { kind } }
}

function unsafeUrl(value: string, options: Required<TransferProofVerificationOptions>): boolean {
  const matches = value.matchAll(/\b(?:https?|file):\/\/[^\s"'<>]+/gi)
  for (const match of matches) {
    try {
      const url = new URL(match[0])
      const host = url.hostname.toLowerCase()
      if (url.protocol === "file:" || host === "localhost" || host === "0.0.0.0" || host === "127.0.0.1" || host === "::1") {
        return true
      }
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".corp") || host.endsWith(".lan") || privateHostPatternMatches(host, options.privateHostPatterns)) {
        return true
      }
    } catch {
      continue
    }
  }
  return false
}

function privateHostPatternMatches(host: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const normalized = pattern.trim().toLowerCase()
    if (!normalized) {
      continue
    }
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(1)
      if (host.endsWith(suffix) && host.length > suffix.length) {
        return true
      }
      continue
    }
    if (host === normalized) {
      return true
    }
  }
  return false
}

function unsafeLocalPath(value: string): boolean {
  return /(?:^|\s)(?:\/Users\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\)/.test(value)
}

function secretShapedValue(value: string): boolean {
  return containsSecretLikeValue(value)
}

function isSecretKeyPath(path: JsonPath): boolean {
  const last = String(path.at(-1) ?? "")
  return isSensitiveKey(last, { pattern: TRANSFER_PROOF_SECRET_KEY_PATTERN })
}

async function readBrowserProbeSummaries(directory: string, manifest?: ArtifactManifest): Promise<Array<Record<string, unknown>>> {
  const review = await readJson(join(directory, "files", "review.json"))
  const reviewProbes = isRecord(review) && isRecord(review.browser) && Array.isArray(review.browser.probes) ? review.browser.probes.filter(isRecord) : []
  if (reviewProbes.length > 0) {
    return reviewProbes
  }
  const probes: Array<Record<string, unknown>> = []
  for (const file of manifest?.files ?? []) {
    if (file.kind !== "browser-summary") {
      continue
    }
    const summary = await readJson(join(directory, file.path))
    if (isRecord(summary)) {
      probes.push(summary)
    }
  }
  return probes
}

async function readNetworkDiagnostics(directory: string, path: string): Promise<TransferProbeDiagnostic[]> {
  const lines = await readFile(join(directory, path), "utf8").catch(() => "")
  return lines.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const entry = parseJsonLine(line)
    if (!isRecord(entry)) {
      return []
    }
    const url = typeof entry.url === "string" ? entry.url : undefined
    const resourceType = typeof entry.resourceType === "string" ? entry.resourceType : undefined
    const status = numeric(entry.status)
    const failed = entry.type === "requestfailed" || status >= 400
    if (!failed) {
      return []
    }
    const code: TransferProbeDiagnosticCode = resourceType === "image" || resourceType === "media" ? "missing-media" : "broken-link"
    return [{ code, severity: "error", message: `${code === "missing-media" ? "Missing media" : "Broken link"} observed during browser probe: ${url ?? "unknown URL"}`, artifact: path, url, details: { status, resourceType } }]
  })
}

async function readTextRuntimeDiagnostics(directory: string, path: string): Promise<TransferProbeDiagnostic[]> {
  const text = await readFile(join(directory, path), "utf8").catch(() => "")
  const diagnostics: TransferProbeDiagnostic[] = []
  if (/block validation|Block validation failed|unexpected or invalid content/i.test(text)) {
    diagnostics.push({ code: "block-validation-error", severity: "error", message: "Browser evidence includes a block validation error.", artifact: path })
  }
  if (/fatal error|uncaught|pageerror|console\.error|TypeError|ReferenceError/i.test(text)) {
    diagnostics.push({ code: "browser-runtime-error", severity: "error", message: "Browser evidence includes a user-visible runtime error.", artifact: path })
  }
  return diagnostics
}

async function readPluginRuntimeDiagnostics(directory: string, path: string): Promise<TransferProbeDiagnostic[]> {
  const diagnostics = await readJson(join(directory, path))
  const list = isRecord(diagnostics) && Array.isArray(diagnostics.diagnostics) ? diagnostics.diagnostics.filter(isRecord) : []
  return list
    .filter((item) => item.severity === "error" || item.severity === "warning")
    .map((item) => ({
      code: "plugin-runtime-diagnostic" as const,
      severity: item.severity === "error" ? "error" as const : "warning" as const,
      message: typeof item.message === "string" ? item.message : "Runtime diagnostic reported during transfer probe.",
      artifact: path,
      details: { phase: item.phase, source: item.source },
    }))
}

async function readManifest(directory: string): Promise<ArtifactManifest | undefined> {
  const manifest = await readJson(join(directory, "manifest.json"))
  return isRecord(manifest) && Array.isArray(manifest.files) ? manifest as unknown as ArtifactManifest : undefined
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function formatJsonPath(path: JsonPath): string {
  return path.map((part) => typeof part === "number" ? `[${part}]` : part).join(".") || "$"
}
