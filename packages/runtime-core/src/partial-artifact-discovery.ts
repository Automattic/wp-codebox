import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import type { ArtifactManifest, ArtifactManifestFile } from "./artifact-manifest.js"
import { ARTIFACT_MANIFEST_PATH, CHANGED_FILES_ARTIFACT_PATH, RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH } from "./artifact-references.js"

export interface PartialArtifactDiscoveryOptions {
  artifactsRoot: string
  sessionId?: string
  startedAt?: string
  finishedAt?: string
  timestampWindowMs?: number
  maxDepth?: number
}

export interface PartialArtifactFileRef {
  path: string
  relativePath: string
  available: boolean
  manifestFile?: ArtifactManifestFile
  payload?: unknown
  error?: string
}

export interface PartialArtifactBundleMetadata {
  id?: string
  createdAt?: string
  contentDigest?: ArtifactManifest["contentDigest"]
  runtime?: ArtifactManifest["runtime"]
  fileCount: number
  contractFiles: ArtifactManifestFile[]
}

export interface PartialRunArtifactEvidence {
  directory: string
  bytes: number | null
  mtime: string
  hasManifest: boolean
  hasChangedFiles: boolean
  hasRuntimeReferenceManifest: boolean
  manifest: PartialArtifactFileRef
  changedFiles: PartialArtifactFileRef
  runtimeReferenceManifest: PartialArtifactFileRef
  bundle?: PartialArtifactBundleMetadata
}

export interface PartialArtifactDiscoveryResult {
  schema: "wp-codebox/partial-artifact-discovery/v1"
  artifactsRoot: string
  sessionId?: string
  startedAt?: string
  finishedAt?: string
  selectedBy: "session-id" | "time-window" | "all-candidates"
  contractPaths: {
    manifest: typeof ARTIFACT_MANIFEST_PATH
    changedFiles: typeof CHANGED_FILES_ARTIFACT_PATH
    runtimeReferenceManifest: typeof RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH
  }
  candidateCount: number
  artifacts: PartialRunArtifactEvidence[]
}

export interface InterruptedRunEvidenceRef {
  kind: string
  directory: string
  path: string
  relativePath: string
  artifact_id?: string
  content_type?: string
  sha256?: ArtifactManifestFile["sha256"]
}

export interface InterruptedRunEvidenceResult {
  schema: "wp-codebox/interrupted-run-evidence/v1"
  artifactsRoot: string
  sessionId?: string
  startedAt?: string
  finishedAt?: string
  runtime_id?: string
  last_known_phase?: string
  last_heartbeat?: string
  artifact_ref_count: number
  artifacts: PartialRunArtifactEvidence[]
  evidence_refs: InterruptedRunEvidenceRef[]
}

interface InterruptedRunPayloadCandidate {
  payload: unknown
  fallbackTimestamp: string
  runtimeId?: string
}

const DEFAULT_TIMESTAMP_WINDOW_MS = 1000
const DEFAULT_MAX_DEPTH = 1

export async function discoverPartialRunArtifacts(options: PartialArtifactDiscoveryOptions): Promise<PartialArtifactDiscoveryResult> {
  const timestampWindowMs = options.timestampWindowMs ?? DEFAULT_TIMESTAMP_WINDOW_MS
  const startedMs = parseTimestampMs(options.startedAt)
  const finishedMs = parseTimestampMs(options.finishedAt)
  const earliestMs = startedMs === undefined ? undefined : startedMs - timestampWindowMs
  const latestMs = finishedMs === undefined ? undefined : finishedMs + timestampWindowMs
  const candidates = await artifactCandidateDirectories(options.artifactsRoot, options.maxDepth ?? DEFAULT_MAX_DEPTH)
  const artifacts = (await Promise.all(candidates.map((directory) => artifactEvidence(directory, earliestMs, latestMs))))
    .filter((artifact): artifact is PartialRunArtifactEvidence => artifact !== undefined)
    .sort((left, right) => left.directory.localeCompare(right.directory))
  const sessionArtifacts = options.sessionId
    ? artifacts.filter((artifact) => artifact.directory.includes(options.sessionId ?? ""))
    : []
  const selected = sessionArtifacts.length > 0 ? sessionArtifacts : artifacts

  return {
    schema: "wp-codebox/partial-artifact-discovery/v1",
    artifactsRoot: options.artifactsRoot,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.finishedAt ? { finishedAt: options.finishedAt } : {}),
    selectedBy: sessionArtifacts.length > 0 ? "session-id" : (earliestMs !== undefined || latestMs !== undefined ? "time-window" : "all-candidates"),
    contractPaths: {
      manifest: ARTIFACT_MANIFEST_PATH,
      changedFiles: CHANGED_FILES_ARTIFACT_PATH,
      runtimeReferenceManifest: RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH,
    },
    candidateCount: artifacts.length,
    artifacts: selected,
  }
}

export async function discoverInterruptedRunEvidence(options: PartialArtifactDiscoveryOptions): Promise<InterruptedRunEvidenceResult> {
  const partial = await discoverPartialRunArtifacts(options)
  const evidenceRefs = partial.artifacts.flatMap(interruptedEvidenceRefs)
  const payloads = partial.artifacts.map((artifact) => ({
    payload: artifact.runtimeReferenceManifest.payload,
    fallbackTimestamp: artifact.mtime,
    runtimeId: artifact.bundle?.runtime?.id,
  }))
  const runtimeId = newestString(payloads, [["runtime", "id"], ["runtimeId"], ["runtime_id"]]) ?? firstString(payloads.map((payload) => payload.runtimeId))
  const lastKnownPhase = newestString(payloads, [["lastKnownPhase"], ["last_known_phase"], ["phase"], ["lifecycle", "phase"], ["status"]])
  const lastHeartbeat = latestTimestamp(payloads.map((payload) => payloadTimestamp(payload)))

  return {
    schema: "wp-codebox/interrupted-run-evidence/v1",
    artifactsRoot: partial.artifactsRoot,
    ...(partial.sessionId ? { sessionId: partial.sessionId } : {}),
    ...(partial.startedAt ? { startedAt: partial.startedAt } : {}),
    ...(partial.finishedAt ? { finishedAt: partial.finishedAt } : {}),
    ...(runtimeId ? { runtime_id: runtimeId } : {}),
    ...(lastKnownPhase ? { last_known_phase: lastKnownPhase } : {}),
    ...(lastHeartbeat ? { last_heartbeat: lastHeartbeat } : {}),
    artifact_ref_count: evidenceRefs.length,
    artifacts: partial.artifacts,
    evidence_refs: evidenceRefs,
  }
}

async function artifactCandidateDirectories(artifactsRoot: string, maxDepth: number): Promise<string[]> {
  const rootStat = await stat(artifactsRoot).catch(() => undefined)
  if (!rootStat?.isDirectory()) {
    return []
  }

  const boundedMaxDepth = Math.max(0, Math.floor(maxDepth))
  const directories = await childDirectories(artifactsRoot, boundedMaxDepth)
  const rootManifest = await stat(join(artifactsRoot, ARTIFACT_MANIFEST_PATH)).catch(() => undefined)
  if (rootManifest?.isFile()) {
    directories.push(artifactsRoot)
  }

  return directories
}

async function childDirectories(directory: string, maxDepth: number, depth = 0): Promise<string[]> {
  if (depth >= maxDepth) {
    return []
  }

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name))
  const nested = await Promise.all(directories.map((child) => childDirectories(child, maxDepth, depth + 1)))
  return [...directories, ...nested.flat()]
}

async function artifactEvidence(directory: string, earliestMs: number | undefined, latestMs: number | undefined): Promise<PartialRunArtifactEvidence | undefined> {
  const directoryStat = await stat(directory).catch(() => undefined)
  if (!directoryStat?.isDirectory()) {
    return undefined
  }
  if (earliestMs !== undefined && directoryStat.mtimeMs < earliestMs) {
    return undefined
  }
  if (latestMs !== undefined && directoryStat.mtimeMs > latestMs) {
    return undefined
  }

  const manifest = await fileRef(directory, ARTIFACT_MANIFEST_PATH)
  const changedFiles = await fileRef(directory, CHANGED_FILES_ARTIFACT_PATH)
  const runtimeReferenceManifest = await fileRef(directory, RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH, { parsePayload: true })
  const parsedManifest = manifest.available ? await readJsonFile<ArtifactManifest>(manifest.path).catch(() => undefined) : undefined

  return {
    directory,
    bytes: await directorySizeBytes(directory),
    mtime: directoryStat.mtime.toISOString(),
    hasManifest: manifest.available,
    hasChangedFiles: changedFiles.available,
    hasRuntimeReferenceManifest: runtimeReferenceManifest.available,
    manifest,
    changedFiles,
    runtimeReferenceManifest,
    ...(parsedManifest ? { bundle: bundleMetadata(parsedManifest) } : {}),
  }
}

async function fileRef(directory: string, relativePath: string, options: { parsePayload?: boolean } = {}): Promise<PartialArtifactFileRef> {
  const absolutePath = join(directory, relativePath)
  const fileStat = await stat(absolutePath).catch(() => undefined)
  const ref: PartialArtifactFileRef = {
    path: absolutePath,
    relativePath,
    available: Boolean(fileStat?.isFile()),
  }
  if (!ref.available || !options.parsePayload) {
    return ref
  }

  try {
    ref.payload = redact(await readJsonFile(absolutePath))
  } catch (error) {
    ref.error = error instanceof Error ? error.message : String(error)
  }
  return ref
}

function bundleMetadata(manifest: ArtifactManifest): PartialArtifactBundleMetadata {
  const files = Array.isArray(manifest.files) ? manifest.files : []
  const contractPathSet = new Set<string>([ARTIFACT_MANIFEST_PATH, CHANGED_FILES_ARTIFACT_PATH, RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH])
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    contentDigest: manifest.contentDigest,
    runtime: manifest.runtime,
    fileCount: files.length,
    contractFiles: files.filter((file) => contractPathSet.has(file.path)),
  }
}

function interruptedEvidenceRefs(artifact: PartialRunArtifactEvidence): InterruptedRunEvidenceRef[] {
  const manifestFiles = artifact.bundle?.contractFiles ?? []
  if (manifestFiles.length > 0) {
    return manifestFiles.map((file) => artifactManifestEvidenceRef(artifact, file))
  }

  return [artifact.manifest, artifact.changedFiles, artifact.runtimeReferenceManifest]
    .filter((ref) => ref.available)
    .map((ref) => ({
      kind: ref.manifestFile?.kind ?? fileArtifactKind(ref.relativePath),
      directory: artifact.directory,
      path: ref.path,
      relativePath: ref.relativePath,
      ...(ref.manifestFile?.contentType ? { content_type: ref.manifestFile.contentType } : {}),
      ...(ref.manifestFile?.sha256 ? { sha256: ref.manifestFile.sha256 } : {}),
    }))
}

function artifactManifestEvidenceRef(artifact: PartialRunArtifactEvidence, file: ArtifactManifestFile): InterruptedRunEvidenceRef {
  return {
    kind: file.kind,
    directory: artifact.directory,
    path: join(artifact.directory, file.path),
    relativePath: file.path,
    ...(artifact.bundle?.id ? { artifact_id: artifact.bundle.id } : {}),
    content_type: file.contentType,
    sha256: file.sha256,
  }
}

function fileArtifactKind(relativePath: string): string {
  if (relativePath === ARTIFACT_MANIFEST_PATH) {
    return "manifest"
  }
  if (relativePath === CHANGED_FILES_ARTIFACT_PATH) {
    return "changed-files"
  }
  if (relativePath === RUNTIME_REFERENCE_MANIFEST_ARTIFACT_PATH) {
    return "runtime-reference-manifest"
  }
  return "artifact"
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function newestString(candidates: InterruptedRunPayloadCandidate[], paths: string[][]): string | undefined {
  return [...candidates]
    .sort((left, right) => candidateTimestampMs(right) - candidateTimestampMs(left))
    .map((candidate) => firstString(paths.map((path) => readPath(candidate.payload, path))))
    .find((value): value is string => value !== undefined)
}

function candidateTimestampMs(candidate: InterruptedRunPayloadCandidate): number {
  return parseTimestampMs(payloadTimestamp(candidate)) ?? parseTimestampMs(candidate.fallbackTimestamp) ?? 0
}

function payloadTimestamp(candidate: InterruptedRunPayloadCandidate): string | undefined {
  return firstString([
    readPath(candidate.payload, ["lastHeartbeat"]),
    readPath(candidate.payload, ["last_heartbeat"]),
    readPath(candidate.payload, ["heartbeatAt"]),
    readPath(candidate.payload, ["heartbeat_at"]),
  ])
}

function latestTimestamp(values: unknown[]): string | undefined {
  return values
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

async function directorySizeBytes(path: string): Promise<number | null> {
  try {
    const pathStat = await stat(path)
    if (!pathStat.isDirectory()) {
      return pathStat.size
    }
    const entries = await readdir(path)
    const sizes = await Promise.all(entries.map((entry) => directorySizeBytes(join(path, entry))))
    return sizes.reduce<number>((total, size) => total + (size ?? 0), 0)
  } catch {
    return null
  }
}

async function readJsonFile<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function redact(value: unknown, key = ""): unknown {
  if (isRedactedKey(key)) {
    return "[redacted]"
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]))
  }
  if (typeof value === "string") {
    return value.replace(/(bearer|token|api[_-]?key|password|cookie|authorization|private[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
  }
  return value
}

function isRedactedKey(key: string): boolean {
  return /secret|token|credential|password|api[_-]?key|authorization|cookie|private[_-]?key/i.test(key)
}
