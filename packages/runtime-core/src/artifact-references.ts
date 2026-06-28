import type { ArtifactBundle, RuntimeEpisodeContentDigest, RuntimeEpisodeTraceRef } from "./runtime-contracts.js"
import type { ArtifactFileDigest, ArtifactManifestFile, ArtifactViewerMetadata } from "./artifact-manifest.js"
import type { RuntimeReferenceManifestArtifactBundleRef, RuntimeReferenceManifestFileRef } from "./runtime-reference.js"
import { redactJsonValue } from "./redaction.js"
import { BROWSER_SESSION_PRODUCT_DTO_SCHEMA, normalizeRuntimeAccess, type RuntimeAccess } from "./runtime-boundary-contracts.js"

export const METADATA_ARTIFACT_PATH = "metadata.json" as const
export const REVIEW_ARTIFACT_PATH = "files/review.json" as const
export const RUNTIME_EPISODE_TRACE_ARTIFACT_PATH = "files/runtime-episode-trace.json" as const
export const RUNTIME_EPISODE_EVENTS_ARTIFACT_PATH = "files/runtime-episode.jsonl" as const
export const RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH = "files/runtime-reference-manifest.json" as const
export const RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH = "files/runtime-replay-index.json" as const
export const RUNTIME_SNAPSHOT_ARTIFACT_PATH = "files/runtime-snapshot.json" as const
export const CHANGED_FILES_ARTIFACT_PATH = "files/changed-files.json" as const
export const PATCH_ARTIFACT_PATH = "files/patch.diff" as const
export const ARTIFACT_MANIFEST_PATH = "manifest.json" as const
export const PUBLIC_ARTIFACT_REF_DTO_SCHEMA = "wp-codebox/artifact-ref/v1" as const

const RUNTIME_REFERENCE_MANIFEST_EXCLUDED_PATHS = new Set<string>([
  ARTIFACT_MANIFEST_PATH,
  METADATA_ARTIFACT_PATH,
  REVIEW_ARTIFACT_PATH,
  RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH,
  RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH,
])

const RUNTIME_REPLAY_REFERENCE_INDEX_EXCLUDED_PATHS = new Set<string>([
  ARTIFACT_MANIFEST_PATH,
  RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH,
])

export interface ArtifactReferenceDigestInput {
  algorithm?: string
  value?: string
  sha256?: string | ArtifactReferenceDigestInput
  digest?: string | ArtifactReferenceDigestInput
  contentDigest?: string | ArtifactReferenceDigestInput
  content_digest?: string | ArtifactReferenceDigestInput
}

export interface ArtifactReferenceFileInput {
  path?: string
  kind?: string
  contentType?: string
  mime?: string
  mimeType?: string
  sha256?: string | ArtifactReferenceDigestInput
  digest?: string | ArtifactReferenceDigestInput
  viewer?: ArtifactViewerMetadata
}

export interface ArtifactReferenceTraceInput extends ArtifactReferenceFileInput {
  id?: string
  artifactId?: string
}

export interface NormalizeRuntimeEpisodeTraceRefDefaults {
  kind?: RuntimeEpisodeTraceRef["kind"]
  id?: string
  artifactId?: string
  path?: string
  digest?: string | ArtifactReferenceDigestInput
}

export interface BrowserArtifactSummaryRef {
  probeIndex: number
  field: string
  kind: string
  path: string
  contentType?: string
}

export interface PublicArtifactRefDTO {
  schema: typeof PUBLIC_ARTIFACT_REF_DTO_SCHEMA
  kind: string
  id?: string
  path?: string
  url?: string
  contentType?: string
  sha256?: string
  digest?: RuntimeEpisodeContentDigest
  size_bytes?: number
  label?: string
  metadata?: Record<string, unknown>
}

export interface PublicArtifactRefGroups {
  all: PublicArtifactRefDTO[]
  artifact_bundles: PublicArtifactRefDTO[]
  changed_files: PublicArtifactRefDTO[]
  patches: PublicArtifactRefDTO[]
  browser: PublicArtifactRefDTO[]
  logs: PublicArtifactRefDTO[]
  transcripts: PublicArtifactRefDTO[]
}

export interface BrowserSessionProductDTO {
  schema: typeof BROWSER_SESSION_PRODUCT_DTO_SCHEMA
  source_schema?: string
  success: boolean
  status?: string
  execution?: string
  execution_scope?: string
  permission_model?: string
  session_id?: string
  contained_site?: Record<string, unknown>
  task?: string
  target?: Record<string, unknown>
  agent?: string
  provider?: string
  model?: string
  preview_boot?: Record<string, unknown>
  runtime_access?: RuntimeAccess
  signals?: Record<string, unknown>
  artifacts?: Record<string, unknown>
  artifact_refs: PublicArtifactRefGroups
  error?: Record<string, unknown>
}

type BrowserArtifactProbeSummary = Record<string, unknown>

const BROWSER_ARTIFACT_SUMMARY_FIELDS: Record<string, { kind: string; contentType?: string }> = {
  actions: { kind: "browser-actions", contentType: "application/x-ndjson" },
  checkpoints: { kind: "browser-checkpoints", contentType: "application/x-ndjson" },
  console: { kind: "browser-console", contentType: "application/x-ndjson" },
  errorsFile: { kind: "browser-errors", contentType: "application/x-ndjson" },
  html: { kind: "browser-html-snapshot", contentType: "text/html; charset=utf-8" },
  memory: { kind: "browser-memory", contentType: "application/json" },
  network: { kind: "browser-network", contentType: "application/x-ndjson" },
  performance: { kind: "browser-performance", contentType: "application/json" },
  screenshot: { kind: "browser-screenshot", contentType: "image/png" },
  steps: { kind: "browser-steps", contentType: "application/x-ndjson" },
  summaryFile: { kind: "browser-summary", contentType: "application/json" },
}

export function normalizeArtifactDigest(input: string | ArtifactReferenceDigestInput | undefined): RuntimeEpisodeContentDigest | undefined {
  if (typeof input === "string" && input.length > 0) {
    return { algorithm: "sha256", value: input }
  }

  if (!input || typeof input !== "object") {
    return undefined
  }

  if (input.algorithm === "sha256" && typeof input.value === "string" && input.value.length > 0) {
    return { algorithm: "sha256", value: input.value }
  }

  return normalizeArtifactDigest(input.sha256)
    ?? normalizeArtifactDigest(input.digest)
    ?? normalizeArtifactDigest(input.contentDigest)
    ?? normalizeArtifactDigest(input.content_digest)
}

export function normalizeArtifactFileDigest(input: string | ArtifactReferenceDigestInput | undefined): ArtifactFileDigest | undefined {
  return normalizeArtifactDigest(input)
}

export function normalizePublicArtifactRefDTO(input: unknown, defaults: Partial<PublicArtifactRefDTO> = {}): PublicArtifactRefDTO | undefined {
  const record = asRecord(input)
  if (!record) {
    return undefined
  }

  const digest = normalizeArtifactDigest(record.digest as ArtifactReferenceDigestInput | string | undefined)
    ?? normalizeArtifactDigest(record.contentDigest as ArtifactReferenceDigestInput | string | undefined)
    ?? normalizeArtifactDigest(record.content_digest as ArtifactReferenceDigestInput | string | undefined)
    ?? normalizeArtifactDigest(record.sha256 as ArtifactReferenceDigestInput | string | undefined)
    ?? defaults.digest
  const path = stringValue(record.path)
    || stringValue(record.relativePath)
    || stringValue(record.artifact)
    || stringValue(record.uri)
    || stringValue(record.directory)
    || stringValue(record.artifacts_path)
    || stringValue(record.artifactsPath)
    || defaults.path
  const kind = stringValue(record.kind) || stringValue(record.artifact_type) || stringValue(record.role) || defaults.kind || kindForArtifactPath(path) || "artifact"
  const sha256 = stringValue(record.sha256) || digest?.value || defaults.sha256
  const metadata = asRecord(record.metadata)

  return stripUndefined({
    schema: PUBLIC_ARTIFACT_REF_DTO_SCHEMA,
    kind,
    id: stringValue(record.id) || stringValue(record.artifact_id) || stringValue(record.artifactId) || defaults.id,
    path,
    url: stringValue(record.url) || (stringValue(record.uri) && stringValue(record.uri) !== path ? stringValue(record.uri) : undefined) || defaults.url,
    contentType: normalizeArtifactContentType(record as ArtifactReferenceFileInput, defaults.contentType),
    sha256,
    digest,
    size_bytes: numberValue(record.size_bytes) ?? numberValue(record.sizeBytes) ?? defaults.size_bytes,
    label: stringValue(record.label) || defaults.label,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : defaults.metadata,
  })
}

export function normalizePublicArtifactRefDTOs(input: unknown): PublicArtifactRefDTO[] {
  return uniquePublicArtifactRefs(collectArtifactRefCandidates(input)
    .map(({ value, defaults }) => normalizePublicArtifactRefDTO(value, defaults))
    .filter((ref): ref is PublicArtifactRefDTO => ref !== undefined))
}

export function publicArtifactRefGroups(input: unknown): PublicArtifactRefGroups {
  const all = normalizePublicArtifactRefDTOs(input)
  return {
    all,
    artifact_bundles: all.filter(isArtifactBundleRef),
    changed_files: all.filter(isChangedFilesArtifactRef),
    patches: all.filter(isPatchArtifactRef),
    browser: all.filter((ref) => ref.kind.startsWith("browser-") || pathIncludes(ref.path, "/browser/")),
    logs: all.filter((ref) => ref.kind.includes("log") || pathEndsWith(ref.path, ".log") || pathEndsWith(ref.path, ".jsonl")),
    transcripts: all.filter((ref) => ref.kind.includes("transcript")),
  }
}

export function changedFilesArtifactRefs(input: unknown): PublicArtifactRefDTO[] {
  return publicArtifactRefGroups(input).changed_files
}

export function patchArtifactRefs(input: unknown): PublicArtifactRefDTO[] {
  return publicArtifactRefGroups(input).patches
}

export function findChangedFilesArtifactRef(input: unknown): PublicArtifactRefDTO | undefined {
  return changedFilesArtifactRefs(input)[0]
}

export function findPatchArtifactRef(input: unknown): PublicArtifactRefDTO | undefined {
  return patchArtifactRefs(input)[0]
}

export function normalizeBrowserSessionProductDTO(input: unknown): BrowserSessionProductDTO {
  const session = asRecord(input) ?? {}
  const sessionEnvelope = asRecord(session.session) ?? {}
  const taskInput = asRecord(session.task_input) ?? {}
  return stripUndefined({
    schema: BROWSER_SESSION_PRODUCT_DTO_SCHEMA,
    source_schema: stringValue(session.schema),
    success: session.success === true,
    status: stringValue(session.status) || (session.success === true ? "ready" : undefined),
    execution: stringValue(session.execution),
    execution_scope: stringValue(session.execution_scope),
    permission_model: stringValue(session.permission_model),
    session_id: stringValue(sessionEnvelope.id) || stringValue(session.session_id),
    contained_site: publicSessionRecord(session.contained_site),
    task: stringValue(session.task) || stringValue(taskInput.goal),
    target: publicSessionRecord(taskInput.target),
    agent: stringValue(session.agent),
    provider: stringValue(session.provider),
    model: stringValue(session.model),
    preview_boot: publicSessionRecord(session.preview_boot),
    runtime_access: browserSessionRuntimeAccess(session),
    signals: publicSessionRecord(session.signals),
    artifacts: publicSessionRecord(session.artifacts),
    artifact_refs: publicArtifactRefGroups(session),
    error: publicSessionRecord(session.error),
  }) as BrowserSessionProductDTO
}

function browserSessionRuntimeAccess(session: Record<string, unknown>): RuntimeAccess | undefined {
  const explicit = asRecord(session.runtime_access)
  if (explicit) {
    try {
      return normalizeRuntimeAccess(explicit)
    } catch {
      return undefined
    }
  }

  const previewBoot = asRecord(session.preview_boot)
  const preview = asRecord(previewBoot?.preview)
  if (!preview) return undefined
  const reviewerAccess = asRecord(preview.reviewer_access) ?? asRecord(preview.reviewerAccess)
  const reviewerUrl = stringValue(reviewerAccess?.openUrl) || stringValue(reviewerAccess?.targetUrl)
  const publicUrl = stringValue(preview.public_url ?? preview.publicUrl ?? preview.preview_public_url ?? preview.previewPublicUrl)
  const siteUrl = stringValue(preview.site_url ?? preview.siteUrl)
  const directPreviewUrl = stringValue(preview.preview_url ?? preview.previewUrl)
  const fallbackPreviewUrl = directPreviewUrl || (publicUrl || siteUrl || reviewerUrl ? "" : stringValue(preview.url))

  try {
    return normalizeRuntimeAccess({
      preview_url: fallbackPreviewUrl,
      public_url: publicUrl,
      site_url: siteUrl,
      local_url: preview.local_url ?? preview.localUrl,
      lease: preview.schema === "wp-codebox/preview-lease/v1" ? preview : undefined,
      reviewer_access: reviewerAccess,
    })
  } catch {
    return undefined
  }
}

export function normalizeArtifactContentType(input: ArtifactReferenceFileInput | undefined, fallback = "application/octet-stream"): string {
  const contentType = input?.contentType ?? input?.mimeType ?? input?.mime
  return typeof contentType === "string" && contentType.trim().length > 0 ? contentType : fallback
}

export function normalizeRuntimeReferenceManifestFileRef(input: ArtifactReferenceFileInput | ArtifactManifestFile): RuntimeReferenceManifestFileRef | undefined {
  if (!input.path || !input.kind) {
    return undefined
  }

  const sha256 = normalizeArtifactFileDigest(input.sha256 ?? ("digest" in input ? input.digest : undefined))
  if (!sha256) {
    return undefined
  }

  return {
    path: input.path,
    kind: input.kind,
    contentType: normalizeArtifactContentType(input),
    sha256,
    ...(input.viewer ? { viewer: input.viewer } : {}),
  }
}

export function normalizeRuntimeReferenceManifestFileRefs(inputs: Array<ArtifactReferenceFileInput | ArtifactManifestFile>): RuntimeReferenceManifestFileRef[] {
  return inputs
    .map((input) => normalizeRuntimeReferenceManifestFileRef(input))
    .filter((ref): ref is RuntimeReferenceManifestFileRef => ref !== undefined)
}

export function runtimeReferenceManifestArtifactFiles(files: ArtifactManifestFile[]): ArtifactManifestFile[] {
  return files.filter((file) => !RUNTIME_REFERENCE_MANIFEST_EXCLUDED_PATHS.has(file.path))
}

export function runtimeReplayReferenceIndexArtifactFiles(files: ArtifactManifestFile[]): ArtifactManifestFile[] {
  return files.filter((file) => !RUNTIME_REPLAY_REFERENCE_INDEX_EXCLUDED_PATHS.has(file.path))
}

export function normalizeRuntimeEpisodeTraceRef(input: ArtifactReferenceTraceInput, defaults: NormalizeRuntimeEpisodeTraceRefDefaults = {}): RuntimeEpisodeTraceRef | undefined {
  const kind = input.kind ?? defaults.kind
  const id = input.id ?? defaults.id ?? input.artifactId ?? defaults.artifactId ?? input.path ?? defaults.path
  if (!kind || !id) {
    return undefined
  }

  const digest = normalizeArtifactDigest(input.digest ?? input.sha256 ?? defaults.digest)
  return stripUndefined({
    kind,
    id,
    artifactId: input.artifactId ?? defaults.artifactId,
    path: input.path ?? defaults.path,
    digest,
  })
}

export function normalizeRuntimeEpisodeTraceRefs(inputs: ArtifactReferenceTraceInput[], defaults: NormalizeRuntimeEpisodeTraceRefDefaults = {}): RuntimeEpisodeTraceRef[] {
  return inputs
    .map((input) => normalizeRuntimeEpisodeTraceRef(input, defaults))
    .filter((ref): ref is RuntimeEpisodeTraceRef => ref !== undefined)
}

export function normalizeObservationArtifactRefs(input: { artifactRefs?: ArtifactReferenceTraceInput[] } | ArtifactReferenceTraceInput[] | undefined): RuntimeEpisodeTraceRef[] {
  const refs = Array.isArray(input) ? input : input?.artifactRefs
  return normalizeRuntimeEpisodeTraceRefs(refs ?? [])
}

export function normalizeArtifactBundleTraceRef(bundle: Pick<ArtifactBundle, "id" | "directory" | "contentDigest"> | undefined): RuntimeEpisodeTraceRef | undefined {
  if (!bundle) {
    return undefined
  }

  return normalizeRuntimeEpisodeTraceRef({
    kind: "artifact-bundle",
    id: bundle.id,
    artifactId: bundle.id,
    path: bundle.directory,
    digest: bundle.contentDigest,
  })
}

export function normalizeRuntimeReferenceArtifactBundleRef(input: { id?: string; digest?: string | ArtifactReferenceDigestInput; contentDigest?: string | ArtifactReferenceDigestInput } | Pick<ArtifactBundle, "id" | "contentDigest">): RuntimeReferenceManifestArtifactBundleRef | undefined {
  if (!input.id) {
    return undefined
  }

  const digest = normalizeArtifactFileDigest("contentDigest" in input ? input.contentDigest : input.digest)
  if (!digest) {
    return undefined
  }

  return { kind: "artifact-bundle", id: input.id, digest }
}

export function normalizeBrowserArtifactSummaryRefs(summary: { probes?: BrowserArtifactProbeSummary[] } | undefined): BrowserArtifactSummaryRef[] {
  const probes = Array.isArray(summary?.probes) ? summary.probes : []
  const refs: BrowserArtifactSummaryRef[] = []
  for (const [probeIndex, probe] of probes.entries()) {
    for (const [field, metadata] of Object.entries(BROWSER_ARTIFACT_SUMMARY_FIELDS)) {
      const path = probe[field]
      if (typeof path === "string" && path.length > 0) {
        refs.push(stripUndefined({ probeIndex, field, path, kind: metadata.kind, contentType: metadata.contentType }))
      }
    }
  }

  return refs
}

function collectArtifactRefCandidates(input: unknown): Array<{ value: unknown; defaults?: Partial<PublicArtifactRefDTO> }> {
  if (Array.isArray(input)) {
    return input.map((value) => ({ value }))
  }

  const record = asRecord(input)
  if (!record) {
    return []
  }

  const candidates: Array<{ value: unknown; defaults?: Partial<PublicArtifactRefDTO> }> = []
  appendArtifactRefArrayCandidates(candidates, record.artifactRefs)
  appendArtifactRefArrayCandidates(candidates, record.artifact_refs)
  appendArtifactRefArrayCandidates(candidates, record.artifacts)

  const refs = asRecord(record.refs)
  appendArtifactRefArrayCandidates(candidates, refs?.artifact_bundles)
  appendArtifactRefArrayCandidates(candidates, refs?.changed_files)
  appendArtifactRefArrayCandidates(candidates, refs?.patches)
  appendArtifactRefArrayCandidates(candidates, refs?.logs)
  appendArtifactRefArrayCandidates(candidates, refs?.transcripts)
  appendArtifactRefArrayCandidates(candidates, refs?.screenshots)
  appendArtifactRefArrayCandidates(candidates, refs?.probe_json)

  appendArtifactRefCandidate(candidates, record.artifactBundle ?? record.artifact_bundle ?? record.artifact_ref, { kind: "artifact-bundle" })
  appendPathCandidate(candidates, record.directory ?? record.artifacts_path, "codebox-artifact-bundle")
  appendPathCandidate(candidates, record.changedFilesPath ?? record.changed_files_path, "codebox-changed-files")
  appendPathCandidate(candidates, record.patchPath ?? record.patch_path, "codebox-patch")

  const artifacts = asRecord(record.artifacts)
  if (artifacts) {
    appendPathCandidate(candidates, artifacts.directory ?? artifacts.path, "codebox-artifact-bundle")
    appendPathCandidate(candidates, artifacts.changedFilesPath ?? artifacts.changed_files_path, "codebox-changed-files")
    appendPathCandidate(candidates, artifacts.patchPath ?? artifacts.patch_path, "codebox-patch")
  }

  const result = asRecord(record.result)
  if (result && result !== record) {
    candidates.push(...collectArtifactRefCandidates(result))
  }

  const agentTaskRunResult = asRecord(record.agent_task_run_result)
  if (agentTaskRunResult) {
    candidates.push(...collectArtifactRefCandidates(agentTaskRunResult))
  }

  return candidates
}

function appendArtifactRefArrayCandidates(candidates: Array<{ value: unknown; defaults?: Partial<PublicArtifactRefDTO> }>, value: unknown): void {
  if (!Array.isArray(value)) {
    return
  }
  for (const item of value) {
    appendArtifactRefCandidate(candidates, item)
  }
}

function appendArtifactRefCandidate(candidates: Array<{ value: unknown; defaults?: Partial<PublicArtifactRefDTO> }>, value: unknown, defaults?: Partial<PublicArtifactRefDTO>): void {
  if (value !== undefined && value !== null) {
    candidates.push({ value, defaults })
  }
}

function appendPathCandidate(candidates: Array<{ value: unknown; defaults?: Partial<PublicArtifactRefDTO> }>, value: unknown, kind: string): void {
  const path = stringValue(value)
  if (path) {
    candidates.push({ value: { path, kind }, defaults: { kind } })
  }
}

function uniquePublicArtifactRefs(refs: PublicArtifactRefDTO[]): PublicArtifactRefDTO[] {
  const seen = new Map<string, number>()
  const normalized: PublicArtifactRefDTO[] = []
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id ?? ""}:${ref.path ?? ""}`
    const existingIndex = seen.get(key)
    if (existingIndex !== undefined) {
      normalized[existingIndex] = richerPublicArtifactRef(normalized[existingIndex], ref)
      continue
    }
    seen.set(key, normalized.length)
    normalized.push(ref)
  }
  return normalized
}

function richerPublicArtifactRef(existing: PublicArtifactRefDTO, incoming: PublicArtifactRefDTO): PublicArtifactRefDTO {
  return stripUndefined({
    ...existing,
    ...incoming,
    digest: incoming.digest ?? existing.digest,
    sha256: incoming.sha256 ?? existing.sha256,
    metadata: existing.metadata && incoming.metadata ? { ...existing.metadata, ...incoming.metadata } : incoming.metadata ?? existing.metadata,
  })
}

function isArtifactBundleRef(ref: PublicArtifactRefDTO): boolean {
  return ref.kind === "artifact-bundle" || ref.kind === "codebox-artifact-bundle"
}

function isChangedFilesArtifactRef(ref: PublicArtifactRefDTO): boolean {
  return ref.kind === "codebox-changed-files" || ref.kind === "changed-files" || pathEndsWith(ref.path, CHANGED_FILES_ARTIFACT_PATH)
}

function isPatchArtifactRef(ref: PublicArtifactRefDTO): boolean {
  return ref.kind === "codebox-patch" || ref.kind === "patch" || pathEndsWith(ref.path, PATCH_ARTIFACT_PATH)
}

function kindForArtifactPath(path: string | undefined): string | undefined {
  if (pathEndsWith(path, CHANGED_FILES_ARTIFACT_PATH)) return "codebox-changed-files"
  if (pathEndsWith(path, PATCH_ARTIFACT_PATH)) return "codebox-patch"
  if (pathEndsWith(path, ARTIFACT_MANIFEST_PATH)) return "artifact-manifest"
  return undefined
}

function pathEndsWith(path: string | undefined, suffix: string): boolean {
  return typeof path === "string" && (path === suffix || path.endsWith(`/${suffix}`))
}

function pathIncludes(path: string | undefined, fragment: string): boolean {
  return typeof path === "string" && path.includes(fragment)
}

function publicSessionRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value)
  if (!record) {
    return undefined
  }
  return asRecord(compactPublicSessionValue(record))
}

function compactPublicSessionValue(value: unknown, key = ""): unknown {
  if (PUBLIC_SESSION_OMITTED_KEYS.has(key)) {
    return undefined
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactPublicSessionValue(item)).filter((item) => item !== undefined)
  }
  if (value && typeof value === "object") {
    const compact: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      const childCompact = compactPublicSessionValue(childValue, childKey)
      if (childCompact !== undefined) {
        compact[childKey] = childCompact
      }
    }
    return redactJsonValue(compact, { profile: "public_session_dto" })
  }
  return value
}

const PUBLIC_SESSION_OMITTED_KEYS = new Set(["pluginData", "source", "content", "content_base64", "bundle", "plugins", "runtime"])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
