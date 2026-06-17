import { resolve } from "node:path"

export interface RuntimeArtifactStorageInput {
  root?: string
  publicUrlRoot?: string
  pathPrefix?: string
  writable?: boolean
  metadata?: Record<string, unknown>
}

export interface RuntimeArtifactStorageDescriptor {
  schema: "wp-codebox/runtime-artifact-storage/v1"
  root: string
  publicUrlRoot?: string
  pathPrefix: string
  writable: boolean
  metadata?: Record<string, unknown>
}

export function runtimeArtifactStorageDescriptor(input: RuntimeArtifactStorageInput = {}): RuntimeArtifactStorageDescriptor {
  const root = normalizeStorageRoot(input.root ?? process.cwd())
  const publicUrlRoot = normalizePublicUrlRoot(input.publicUrlRoot)
  const pathPrefix = normalizeArtifactPathPrefix(input.pathPrefix)
  return stripUndefined({
    schema: "wp-codebox/runtime-artifact-storage/v1" as const,
    root,
    publicUrlRoot,
    pathPrefix,
    writable: input.writable ?? true,
    metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
  })
}

export function normalizeStorageRoot(root: string): string {
  const trimmed = root.trim()
  if (!trimmed) {
    throw new Error("Artifact storage root is required")
  }
  return resolve(trimmed)
}

export function normalizePublicUrlRoot(url: string | undefined): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) {
    return undefined
  }

  const parsed = new URL(trimmed)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Artifact public URL root must use http:// or https://")
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/"
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString().replace(/\/$/, "")
}

export function normalizeArtifactPathPrefix(prefix: string | undefined): string {
  const trimmed = prefix?.trim().replace(/\\/g, "/") ?? ""
  if (!trimmed || trimmed === "/") {
    return ""
  }

  const segments = trimmed.split("/").filter(Boolean)
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Artifact path prefix must not contain current-directory or parent-directory segments")
  }

  return segments.join("/")
}

export function artifactStoragePath(descriptor: RuntimeArtifactStorageDescriptor, relativePath: string): string {
  const path = normalizeArtifactPathPrefix(relativePath)
  return [descriptor.pathPrefix, path].filter(Boolean).join("/")
}

export function artifactStoragePublicUrl(descriptor: RuntimeArtifactStorageDescriptor, relativePath: string): string | undefined {
  if (!descriptor.publicUrlRoot) {
    return undefined
  }
  const path = artifactStoragePath(descriptor, relativePath)
  return path ? `${descriptor.publicUrlRoot}/${path}` : descriptor.publicUrlRoot
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}
