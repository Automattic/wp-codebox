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

const DEFAULT_TIMESTAMP_WINDOW_MS = 1000

export async function discoverPartialRunArtifacts(options: PartialArtifactDiscoveryOptions): Promise<PartialArtifactDiscoveryResult> {
  const timestampWindowMs = options.timestampWindowMs ?? DEFAULT_TIMESTAMP_WINDOW_MS
  const startedMs = parseTimestampMs(options.startedAt)
  const finishedMs = parseTimestampMs(options.finishedAt)
  const earliestMs = startedMs === undefined ? undefined : startedMs - timestampWindowMs
  const latestMs = finishedMs === undefined ? undefined : finishedMs + timestampWindowMs
  const candidates = await artifactCandidateDirectories(options.artifactsRoot)
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

async function artifactCandidateDirectories(artifactsRoot: string): Promise<string[]> {
  const rootStat = await stat(artifactsRoot).catch(() => undefined)
  if (!rootStat?.isDirectory()) {
    return []
  }

  const entries = await readdir(artifactsRoot, { withFileTypes: true }).catch(() => [])
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(artifactsRoot, entry.name))
  const rootManifest = await stat(join(artifactsRoot, ARTIFACT_MANIFEST_PATH)).catch(() => undefined)
  if (rootManifest?.isFile()) {
    directories.push(artifactsRoot)
  }

  return directories
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
