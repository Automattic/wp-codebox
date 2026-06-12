import type { ArtifactBundle, RuntimeEpisodeContentDigest, RuntimeEpisodeTraceRef } from "./runtime-contracts.js"
import type { ArtifactFileDigest, ArtifactManifestFile, ArtifactViewerMetadata } from "./artifact-manifest.js"
import type { RuntimeReferenceManifestArtifactBundleRef, RuntimeReferenceManifestFileRef } from "./runtime-reference.js"

export const RUNTIME_EPISODE_TRACE_ARTIFACT_PATH = "files/runtime-episode-trace.json" as const
export const RUNTIME_EPISODE_EVENTS_ARTIFACT_PATH = "files/runtime-episode.jsonl" as const
export const RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH = "files/runtime-reference-manifest.json" as const
export const RUNTIME_REPLAY_REFERENCE_INDEX_ARTIFACT_PATH = "files/runtime-replay-index.json" as const
export const CHANGED_FILES_ARTIFACT_PATH = "files/changed-files.json" as const
export const ARTIFACT_MANIFEST_PATH = "manifest.json" as const

export interface ArtifactReferenceDigestInput {
  algorithm?: string
  value?: string
  sha256?: string | ArtifactReferenceDigestInput
  digest?: string | ArtifactReferenceDigestInput
  contentDigest?: string | ArtifactReferenceDigestInput
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
}

export function normalizeArtifactFileDigest(input: string | ArtifactReferenceDigestInput | undefined): ArtifactFileDigest | undefined {
  return normalizeArtifactDigest(input)
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

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
