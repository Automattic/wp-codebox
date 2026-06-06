import { readFile, stat } from "node:fs/promises"
import { join, normalize } from "node:path"
import { artifactFileDigest } from "./artifact-manifest.js"
import type { ArtifactManifest } from "./artifact-manifest.js"
import { preflightArtifactBundleApply } from "./artifact-bundle-verifier.js"
import type { ArtifactBundleApplyChangedFile, ArtifactBundleApplyPreflightResult, ArtifactBundleVerificationViolation } from "./artifact-bundle-verifier.js"
import { isPlainObject as isRecord } from "./object-utils.js"

export const ARTIFACT_APPLY_PREFLIGHT_SCHEMA = "wp-codebox/artifact-apply-preflight/v1" as const
export const ARTIFACT_APPLY_PAYLOAD_SCHEMA = "wp-codebox/artifact-apply-payload/v1" as const

export type ArtifactApplyPreflightViolationCode =
  | "unsupported-input"
  | "preflight-not-ready"
  | "missing-payload"
  | "missing-patch"
  | "missing-changed-files"
  | "approved-file-mismatch"
  | "digest-mismatch"
  | "bundle-id-mismatch"

export interface ArtifactApplyPreflightViolation {
  code: ArtifactApplyPreflightViolationCode
  path: string
  message: string
  file?: string
  details?: Record<string, unknown>
}

export interface ArtifactApplyCompatibilityArtifact {
  id: string
  directory?: string
  manifest?: ArtifactManifest
  metadata?: Record<string, unknown>
  changed_files: {
    schema?: string
    files: ArtifactBundleApplyChangedFile[]
  }
  review?: Record<string, unknown>
  content_digest: string
  paths?: {
    manifest?: string
    metadata?: string
    changed_files?: string
    patch?: string
    review?: string
  }
}

export interface ArtifactApplyPayload {
  schema: typeof ARTIFACT_APPLY_PAYLOAD_SCHEMA
  artifact_id: string
  artifact: ArtifactApplyCompatibilityArtifact
  approved_files: string[]
  patch: string
  patch_sha256: string
  artifact_content_digest: string
  artifact_verification?: ArtifactBundleApplyPreflightResult["verification"]
}

export interface ArtifactApplyPreflightResult {
  schema: typeof ARTIFACT_APPLY_PREFLIGHT_SCHEMA
  ready: boolean
  violations: ArtifactApplyPreflightViolation[]
  payload?: ArtifactApplyPayload
  bundlePreflight?: ArtifactBundleApplyPreflightResult
}

export interface ArtifactApplyAdapterInput {
  bundlePath?: string
  bundleDirectory?: string
  artifactsPath?: string
  artifactId?: string
  artifact_id?: string
  preflightPath?: string
  preflight?: unknown
  applyPreflight?: unknown
  payload?: unknown
  approvedFiles?: string[]
  approved_files?: string[]
  id?: string
  title?: string
  summary?: string
  worktreePath?: string
  branch?: string
  commitMessage?: string
  patchStrip?: number
  push?: boolean
  openPullRequest?: boolean
  prBase?: string
  remote?: string
}

export interface ArtifactApplyRequest {
  id: string
  artifact: {
    id: string
    type: "wp_codebox_patch"
    provenance: Record<string, unknown>
    title: string
    summary: string
    path: string
    files: string[]
    approval_scope: {
      scope: "artifact"
      artifact_id: string
    }
    metadata: {
      wp_codebox: {
        bundle_path: string
        content_digest: string
        patch_sha256: string
        review: Record<string, unknown>
        changed_files: ArtifactApplyPayload["artifact"]["changed_files"]
      }
    }
  }
  approval_scope: {
    scope: "artifact"
    artifact_id: string
  }
  inputs: Record<string, unknown>
  policy: {
    approved_files: string[]
    content_digest: string
    patch_sha256: string
    publish: {
      push: boolean
      open_pull_request: boolean
      base?: string
      remote?: string
    }
  }
}

export async function loadArtifactBundleForApply(bundlePath: string, options: Pick<ArtifactApplyAdapterInput, "approvedFiles" | "approved_files"> = {}): Promise<ArtifactApplyPreflightResult> {
  return normalizeArtifactApplyPreflight({ bundlePath, ...options })
}

export async function normalizeArtifactApplyPreflight(input: string | ArtifactApplyAdapterInput | unknown): Promise<ArtifactApplyPreflightResult> {
  if (typeof input === "string") {
    return normalizeArtifactApplyPreflight({ bundlePath: input })
  }

  if (!isRecord(input)) {
    return artifactApplyPreflightResult([{ code: "unsupported-input", path: "input", message: "Artifact apply preflight input must be an object, bundle path, or preflight path." }])
  }

  if (typeof input.preflightPath === "string" && input.preflightPath.trim().length > 0) {
    return normalizeArtifactApplyPreflight(JSON.parse(await readFile(input.preflightPath, "utf8")))
  }

  const bundlePath = stringValue(input.bundlePath) ?? stringValue(input.bundleDirectory)
  if (bundlePath) {
    return normalizeBundleApplyPreflight(bundlePath, approvedFilesFromInput(input))
  }

  const nestedPreflight = input.preflight ?? input.applyPreflight
  if (nestedPreflight !== undefined) {
    return normalizeArtifactApplyPreflight(nestedPreflight)
  }

  if (isArtifactApplyPreflightResult(input)) {
    return normalizePayload(input.payload, input.violations)
  }

  if (isArtifactBundleApplyPreflightResult(input)) {
    return normalizeBundleApplyPreflightResult(input)
  }

  return normalizePayload(input.payload ?? input)
}

export async function createArtifactApplyRequest(input: string | ArtifactApplyAdapterInput | unknown): Promise<ArtifactApplyRequest> {
  const options = isRecord(input) ? input : {}
  const preflight = await normalizeArtifactApplyPreflight(input)
  if (!preflight.ready || !preflight.payload) {
    const messages = preflight.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")
    throw new Error(`WP Codebox artifact apply preflight is not ready${messages ? `: ${messages}` : ""}`)
  }

  const payload = preflight.payload
  const artifact = changeArtifactFromApplyPayload(payload, options)
  const approvedFiles = approvedFilesFromInput(options).length > 0 ? approvedFilesFromInput(options) : payload.approved_files

  return {
    id: stringValue(options.id) ?? `apply-request-${artifact.id}`,
    artifact,
    approval_scope: artifact.approval_scope,
    inputs: {
      ...(stringValue(options.bundlePath) ? { bundlePath: stringValue(options.bundlePath) } : {}),
      ...(stringValue(options.bundleDirectory) ? { bundlePath: stringValue(options.bundleDirectory) } : {}),
      ...(stringValue(options.artifactsPath) ? { artifactsPath: stringValue(options.artifactsPath) } : {}),
      artifactId: payload.artifact_id,
      preflight,
      ...(stringValue(options.worktreePath) ? { worktreePath: stringValue(options.worktreePath) } : {}),
      ...(stringValue(options.branch) ? { branch: stringValue(options.branch) } : {}),
      ...(stringValue(options.commitMessage) ? { commitMessage: stringValue(options.commitMessage) } : {}),
      ...(Number.isInteger(options.patchStrip) ? { patchStrip: options.patchStrip } : {}),
    },
    policy: {
      approved_files: approvedFiles,
      content_digest: payload.artifact_content_digest,
      patch_sha256: payload.patch_sha256,
      publish: {
        push: Boolean(options.push),
        open_pull_request: Boolean(options.openPullRequest),
        ...(stringValue(options.prBase) ? { base: stringValue(options.prBase) } : {}),
        ...(stringValue(options.remote) ? { remote: stringValue(options.remote) } : {}),
      },
    },
  }
}

async function normalizeBundleApplyPreflight(bundlePath: string, approvedFiles: string[]): Promise<ArtifactApplyPreflightResult> {
  const bundleDirectory = normalize(bundlePath)
  const bundlePreflight = await preflightArtifactBundleApply(bundleDirectory, { approvedFiles })
  return normalizeBundleApplyPreflightResult(bundlePreflight)
}

async function normalizeBundleApplyPreflightResult(bundlePreflight: ArtifactBundleApplyPreflightResult): Promise<ArtifactApplyPreflightResult> {
  const violations = bundlePreflight.violations.map(mapBundleViolation)
  if (!bundlePreflight.ready || !bundlePreflight.payload) {
    if (violations.length === 0) {
      violations.push({ code: "preflight-not-ready", path: "preflight", message: "Artifact bundle apply preflight is not ready." })
    }
    return artifactApplyPreflightResult(violations, undefined, bundlePreflight)
  }

  const payload = bundlePreflight.payload
  const bundleDirectory = bundlePreflight.bundleDirectory
  const [metadata, review] = await Promise.all([
    readOptionalJson(join(bundleDirectory, "metadata.json")),
    payload.review?.path ? readOptionalJson(join(bundleDirectory, payload.review.path)) : undefined,
  ])

  return normalizePayload({
    schema: ARTIFACT_APPLY_PAYLOAD_SCHEMA,
    artifact_id: payload.artifactId,
    artifact: {
      id: payload.artifactId,
      directory: bundleDirectory,
      manifest: bundlePreflight.manifest,
      metadata,
      changed_files: {
        schema: "wp-codebox/changed-files/v1",
        files: payload.changedFiles.files,
      },
      review,
      content_digest: payload.contentDigest.value,
      paths: {
        manifest: join(bundleDirectory, "manifest.json"),
        metadata: join(bundleDirectory, "metadata.json"),
        changed_files: join(bundleDirectory, payload.changedFiles.path),
        patch: join(bundleDirectory, payload.patch.path),
        ...(payload.review?.path ? { review: join(bundleDirectory, payload.review.path) } : {}),
      },
    },
    approved_files: payload.approvedFiles,
    patch: payload.patch.body,
    patch_sha256: payload.patch.sha256.value,
    artifact_content_digest: payload.contentDigest.value,
    artifact_verification: bundlePreflight.verification,
  }, [], bundlePreflight)
}

function normalizePayload(rawPayload: unknown, preflightViolations: ArtifactApplyPreflightViolation[] = [], bundlePreflight?: ArtifactBundleApplyPreflightResult): ArtifactApplyPreflightResult {
  const violations = [...preflightViolations]
  if (!isRecord(rawPayload)) {
    violations.push({ code: "missing-payload", path: "payload", message: "Artifact apply preflight payload is required." })
    return artifactApplyPreflightResult(violations, undefined, bundlePreflight)
  }

  const bundlePayload = isArtifactBundleApplyPayload(rawPayload) ? rawPayload : undefined
  const artifact = isRecord(rawPayload.artifact) ? rawPayload.artifact : {}
  const changedFiles = normalizeChangedFiles(bundlePayload?.changedFiles.files ?? artifact.changed_files ?? rawPayload.changed_files)
  const patch = bundlePayload ? bundlePayload.patch.body : stringValue(rawPayload.patch) ?? stringValue(artifact.patch)
  const artifactId = bundlePayload ? bundlePayload.artifactId : stringValue(rawPayload.artifact_id) ?? stringValue(rawPayload.artifactId) ?? stringValue(artifact.id)
  const contentDigest = bundlePayload
    ? bundlePayload.contentDigest.value
    : stringValue(rawPayload.artifact_content_digest) ?? stringValue(rawPayload.content_digest) ?? stringValue(artifact.content_digest) ?? manifestContentDigest(artifact.manifest) ?? reviewArtifactContentDigest(artifact.review)
  const patchSha256 = bundlePayload
    ? bundlePayload.patch.sha256.value
    : stringValue(rawPayload.patch_sha256) ?? stringValue(rawPayload.patchSha256) ?? reviewPatchSha256(artifact.review)
  const approvedFiles = normalizePathList(bundlePayload?.approvedFiles ?? rawPayload.approved_files ?? rawPayload.approvedFiles)

  if (!artifactId) {
    violations.push({ code: "bundle-id-mismatch", path: "payload.artifact_id", message: "Artifact apply preflight payload must include artifact_id." })
  }
  if (!contentDigest) {
    violations.push({ code: "digest-mismatch", path: "payload.artifact_content_digest", message: "Artifact apply preflight payload must include artifact_content_digest." })
  }
  if (!patchSha256) {
    violations.push({ code: "digest-mismatch", path: "payload.patch_sha256", message: "Artifact apply preflight payload must include patch_sha256." })
  }
  if (!patch) {
    violations.push({ code: "missing-patch", path: "payload.patch", message: "Artifact apply preflight payload.patch must contain the canonical patch body." })
  }
  if (!changedFiles || changedFiles.files.length === 0) {
    violations.push({ code: "missing-changed-files", path: "payload.artifact.changed_files", message: "Artifact apply preflight payload must include changed files." })
  }
  if (approvedFiles.length === 0) {
    violations.push({ code: "approved-file-mismatch", path: "payload.approved_files", message: "Artifact apply preflight payload.approved_files must contain at least one file." })
  }

  if (artifactId && stringValue(artifact.id) && artifactId !== stringValue(artifact.id)) {
    violations.push({ code: "bundle-id-mismatch", path: "payload.artifact.id", message: "Artifact id does not match payload artifact_id.", details: { artifactId, nestedArtifactId: stringValue(artifact.id) } })
  }

  const manifestDigest = manifestContentDigest(artifact.manifest)
  if (contentDigest && manifestDigest && contentDigest !== manifestDigest) {
    violations.push({ code: "digest-mismatch", path: "payload.artifact.manifest.contentDigest.value", message: "Artifact content digest does not match manifest contentDigest.", details: { contentDigest, manifestDigest } })
  }

  const reviewDigest = reviewArtifactContentDigest(artifact.review)
  if (contentDigest && reviewDigest && contentDigest !== reviewDigest) {
    violations.push({ code: "digest-mismatch", path: "payload.artifact.review.evidence.artifactContentDigest", message: "Artifact content digest does not match review evidence.", details: { contentDigest, reviewDigest } })
  }

  if (patch && patchSha256) {
    const actualPatchSha256 = artifactFileDigest(patch).value
    if (patchSha256 !== actualPatchSha256) {
      violations.push({ code: "digest-mismatch", path: "payload.patch_sha256", message: "Patch sha256 does not match payload.patch.", details: { patchSha256, actualPatchSha256 } })
    }
  }

  if (changedFiles) {
    const changedFileSet = new Set(changedFiles.files.map((file) => file.path))
    for (const approvedFile of approvedFiles) {
      if (!changedFileSet.has(approvedFile)) {
        violations.push({ code: "approved-file-mismatch", path: "payload.approved_files", file: approvedFile, message: `Approved file is not present in changed files: ${approvedFile}` })
      }
    }
    for (const changedFile of changedFiles.files) {
      if (!approvedFiles.includes(changedFile.path)) {
        violations.push({ code: "approved-file-mismatch", path: "payload.approved_files", file: changedFile.path, message: `Changed file is not covered by approved_files: ${changedFile.path}` })
      }
    }
  }

  const payload = violations.length === 0 && artifactId && contentDigest && patchSha256 && patch && changedFiles ? {
    schema: ARTIFACT_APPLY_PAYLOAD_SCHEMA,
    artifact_id: artifactId,
    artifact: {
      id: artifactId,
      ...(stringValue(artifact.directory) ? { directory: stringValue(artifact.directory) } : {}),
      ...(isArtifactManifest(artifact.manifest) ? { manifest: artifact.manifest } : {}),
      ...(isRecord(artifact.metadata) ? { metadata: artifact.metadata } : {}),
      changed_files: changedFiles,
      ...(isRecord(artifact.review) ? { review: artifact.review } : {}),
      content_digest: contentDigest,
      ...(isRecord(artifact.paths) ? { paths: normalizePaths(artifact.paths) } : {}),
    },
    approved_files: approvedFiles,
    patch,
    patch_sha256: patchSha256,
    artifact_content_digest: contentDigest,
    ...(rawPayload.artifact_verification ? { artifact_verification: rawPayload.artifact_verification as ArtifactApplyPayload["artifact_verification"] } : {}),
  } satisfies ArtifactApplyPayload : undefined

  return artifactApplyPreflightResult(violations, payload, bundlePreflight)
}

function changeArtifactFromApplyPayload(payload: ArtifactApplyPayload, options: Record<string, unknown>): ArtifactApplyRequest["artifact"] {
  const review = payload.artifact.review ?? {}
  const bundlePath = payload.artifact.directory ?? ""
  return {
    id: payload.artifact_id,
    type: "wp_codebox_patch",
    provenance: {
      source: "wp-codebox",
      ...(payload.artifact.manifest?.createdAt ? { captured_at: payload.artifact.manifest.createdAt } : {}),
    },
    title: stringValue(options.title) ?? `WP Codebox artifact ${payload.artifact_id}`,
    summary: stringValue(options.summary) ?? "Approved WP Codebox patch artifact.",
    path: bundlePath,
    files: payload.artifact.changed_files.files.map((file) => file.path),
    approval_scope: {
      scope: "artifact",
      artifact_id: payload.artifact_id,
    },
    metadata: {
      wp_codebox: {
        bundle_path: bundlePath,
        content_digest: payload.artifact_content_digest,
        patch_sha256: payload.patch_sha256,
        review,
        changed_files: payload.artifact.changed_files,
      },
    },
  }
}

function artifactApplyPreflightResult(violations: ArtifactApplyPreflightViolation[], payload?: ArtifactApplyPayload, bundlePreflight?: ArtifactBundleApplyPreflightResult): ArtifactApplyPreflightResult {
  return {
    schema: ARTIFACT_APPLY_PREFLIGHT_SCHEMA,
    ready: violations.length === 0 && payload !== undefined,
    violations,
    ...(payload ? { payload } : {}),
    ...(bundlePreflight ? { bundlePreflight } : {}),
  }
}

function mapBundleViolation(violation: ArtifactBundleVerificationViolation): ArtifactApplyPreflightViolation {
  const code = violation.code === "digest-mismatch" || violation.code === "file-hash-mismatch" || violation.code === "review-evidence-mismatch"
    ? "digest-mismatch"
    : violation.code === "bundle-id-mismatch"
      ? "bundle-id-mismatch"
      : violation.path.includes("approvedFiles")
        ? "approved-file-mismatch"
        : violation.message.includes("patch")
          ? "missing-patch"
          : violation.message.includes("changed-files")
            ? "missing-changed-files"
            : "preflight-not-ready"

  return {
    code,
    path: violation.path,
    message: violation.message,
    ...(violation.file ? { file: violation.file } : {}),
    ...(violation.details ? { details: violation.details } : {}),
  }
}

async function readOptionalJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    await stat(path)
    const value = JSON.parse(await readFile(path, "utf8"))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function approvedFilesFromInput(input: Record<string, unknown>): string[] {
  return normalizePathList(input.approvedFiles ?? input.approved_files)
}

function normalizeChangedFiles(value: unknown): ArtifactApplyPayload["artifact"]["changed_files"] | undefined {
  const files = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.files) ? value.files : undefined
  if (!files) {
    return undefined
  }

  const normalizedFiles = files.flatMap((file): ArtifactBundleApplyChangedFile[] => {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.trim().length === 0) {
      return []
    }
    return [{ ...file, path: file.path }]
  })

  return {
    ...(isRecord(value) && typeof value.schema === "string" ? { schema: value.schema } : {}),
    files: normalizedFiles,
  }
}

function normalizePathList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : []
}

function normalizePaths(value: Record<string, unknown>): ArtifactApplyCompatibilityArtifact["paths"] {
  return {
    ...(stringValue(value.manifest) ? { manifest: stringValue(value.manifest) } : {}),
    ...(stringValue(value.metadata) ? { metadata: stringValue(value.metadata) } : {}),
    ...(stringValue(value.changed_files) ? { changed_files: stringValue(value.changed_files) } : {}),
    ...(stringValue(value.patch) ? { patch: stringValue(value.patch) } : {}),
    ...(stringValue(value.review) ? { review: stringValue(value.review) } : {}),
  }
}

function isArtifactApplyPreflightResult(value: unknown): value is ArtifactApplyPreflightResult {
  return isRecord(value) && value.schema === ARTIFACT_APPLY_PREFLIGHT_SCHEMA
}

function isArtifactBundleApplyPreflightResult(value: unknown): value is ArtifactBundleApplyPreflightResult {
  return isRecord(value) && value.schema === "wp-codebox/artifact-bundle-apply-preflight/v1"
}

function isArtifactBundleApplyPayload(value: Record<string, unknown>): value is ArtifactBundleApplyPreflightResult["payload"] & Record<string, unknown> {
  return value.schema === "wp-codebox/artifact-bundle-apply-payload/v1" && isRecord(value.patch) && isRecord(value.contentDigest) && isRecord(value.changedFiles)
}

function isArtifactManifest(value: unknown): value is ArtifactManifest {
  return isRecord(value) && typeof value.id === "string" && isRecord(value.contentDigest) && Array.isArray(value.files)
}

function manifestContentDigest(value: unknown): string | undefined {
  return isRecord(value) && isRecord(value.contentDigest) ? stringValue(value.contentDigest.value) : undefined
}

function reviewArtifactContentDigest(value: unknown): string | undefined {
  return isRecord(value) && isRecord(value.evidence) ? stringValue(value.evidence.artifactContentDigest) : undefined
}

function reviewPatchSha256(value: unknown): string | undefined {
  return isRecord(value) && isRecord(value.evidence) ? stringValue(value.evidence.patchSha256) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}
