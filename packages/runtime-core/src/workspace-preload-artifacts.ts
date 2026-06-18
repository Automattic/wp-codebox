import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { isPlainObject } from "./object-utils.js"
import type { StructuredArtifactPayload } from "./structured-artifacts.js"
import type { TaskInputAgentBundle } from "./task-input.js"

export const WORKSPACE_PRELOAD_ARTIFACT_TYPE = "agent-runtime/workspace-preload" as const
export const WORKSPACE_PRELOAD_ARTIFACT_SCHEMA = "agent-runtime/workspace-preload/v1" as const

export interface WorkspacePreloadRepository {
  name: string
  url: string
  ref?: string
}

export interface WorkspacePreloadPayload {
  schema: typeof WORKSPACE_PRELOAD_ARTIFACT_SCHEMA
  repositories: WorkspacePreloadRepository[]
  meta?: Record<string, unknown>
}

export interface WorkspacePreloadArtifactContract {
  type: typeof WORKSPACE_PRELOAD_ARTIFACT_TYPE
  slug?: string
  source?: string
  payload: WorkspacePreloadPayload
}

export interface WorkspacePreloadInput extends WorkspacePreloadArtifactContract {
  provenance: {
    source: "agent-bundle" | "structured-artifact" | "direct"
    bundleIndex?: number
    artifactIndex?: number
    name?: string
  }
}

export function normalizeWorkspacePreloadArtifact(input: unknown): WorkspacePreloadArtifactContract | undefined {
  if (!isPlainObject(input)) return undefined

  const type = stringValue(input.type)
  const payload = normalizeWorkspacePreloadPayload(input.payload)
  if (type !== WORKSPACE_PRELOAD_ARTIFACT_TYPE || !payload) return undefined

  return stripUndefined({
    type: WORKSPACE_PRELOAD_ARTIFACT_TYPE,
    slug: stringValue(input.slug) || undefined,
    source: stringValue(input.source) || undefined,
    payload,
  })
}

export function normalizeWorkspacePreloadPayload(input: unknown): WorkspacePreloadPayload | undefined {
  if (!isPlainObject(input)) return undefined
  if (stringValue(input.schema) !== WORKSPACE_PRELOAD_ARTIFACT_SCHEMA) return undefined

  const repositories = Array.isArray(input.repositories)
    ? input.repositories.flatMap((repository): WorkspacePreloadRepository[] => {
      if (!isPlainObject(repository)) return []
      const name = stringValue(repository.name)
      const url = stringValue(repository.url)
      if (!name || !url) return []
      return [stripUndefined({ name, url, ref: stringValue(repository.ref) || undefined })]
    })
    : []
  if (repositories.length === 0) return undefined

  return stripUndefined({
    schema: WORKSPACE_PRELOAD_ARTIFACT_SCHEMA,
    repositories,
    meta: isPlainObject(input.meta) ? input.meta : undefined,
  })
}

export function workspacePreloadsFromTaskInputs(input: {
  agent_bundles?: TaskInputAgentBundle[] | Array<Record<string, unknown>>
  structured_artifacts?: StructuredArtifactPayload[]
  workspace_preloads?: unknown
}): WorkspacePreloadInput[] {
  const preloads: WorkspacePreloadInput[] = []

  for (const [bundleIndex, bundle] of (Array.isArray(input.agent_bundles) ? input.agent_bundles : []).entries()) {
    const bundleRecord = isPlainObject(bundle.bundle) ? bundle.bundle : undefined
    const sourceBundleRecord = bundleRecord ? undefined : bundleSourceRecord(stringValue(bundle.source))
    const artifacts = Array.isArray(bundleRecord?.artifacts)
      ? bundleRecord.artifacts
      : Array.isArray(sourceBundleRecord?.artifacts)
        ? sourceBundleRecord.artifacts
        : []
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      const normalized = normalizeWorkspacePreloadArtifact(artifact)
      if (!normalized) continue
      preloads.push({
        ...normalized,
        provenance: { source: "agent-bundle", bundleIndex, artifactIndex, name: normalized.slug },
      })
    }
  }

  for (const [artifactIndex, artifact] of (Array.isArray(input.structured_artifacts) ? input.structured_artifacts : []).entries()) {
    if (artifact.type !== WORKSPACE_PRELOAD_ARTIFACT_TYPE) continue
    const payload = normalizeWorkspacePreloadPayload(artifact.payload)
    if (!payload) continue
    preloads.push({
      type: WORKSPACE_PRELOAD_ARTIFACT_TYPE,
      slug: artifact.name,
      payload,
      provenance: { source: "structured-artifact", artifactIndex, name: artifact.name },
    })
  }

  for (const [artifactIndex, artifact] of (Array.isArray(input.workspace_preloads) ? input.workspace_preloads : []).entries()) {
    const normalized = normalizeWorkspacePreloadArtifact(artifact)
    if (!normalized) continue
    preloads.push({
      ...normalized,
      provenance: { source: "direct", artifactIndex, name: normalized.slug },
    })
  }

  return dedupeWorkspacePreloads(preloads)
}

function dedupeWorkspacePreloads(preloads: WorkspacePreloadInput[]): WorkspacePreloadInput[] {
  const seen = new Set<string>()
  const results: WorkspacePreloadInput[] = []
  for (const preload of preloads) {
    const key = JSON.stringify(preload.payload.repositories.map((repository) => [repository.name, repository.url, repository.ref ?? ""]))
    if (seen.has(key)) continue
    seen.add(key)
    results.push(preload)
  }
  return results
}

function bundleSourceRecord(source: string): Record<string, unknown> | undefined {
  const localSource = localBundleSource(source)
  if (!localSource) return undefined

  try {
    const path = bundleSourceJsonPath(localSource)
    if (!path) return undefined
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function bundleSourceJsonPath(source: string): string | undefined {
  const sourceStat = statSync(source)
  if (sourceStat.isFile() && source.endsWith(".json")) return source
  if (!sourceStat.isDirectory()) return undefined

  for (const filename of ["bundle.json", "runtime-bundle.json", "agent-bundle.json"]) {
    const candidate = join(source, filename)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

function localBundleSource(source: string): string | undefined {
  if (!source) return undefined
  const direct = resolve(source)
  if (existsSync(direct)) return direct

  const workspacePrefix = "/workspace/"
  if (!source.startsWith(workspacePrefix)) return undefined

  const relativeToWorkspace = source.slice(workspacePrefix.length).split("/").filter(Boolean).slice(1).join("/")
  if (!relativeToWorkspace) return undefined

  const fromCwd = resolve(process.cwd(), relativeToWorkspace)
  return existsSync(fromCwd) ? fromCwd : undefined
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
