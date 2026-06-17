import { isAbsolute, relative, resolve } from "node:path"

export interface ResolvedArtifactPath {
  root: string
  relativePath: string
  absolutePath: string
}

export function safeArtifactRelativePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/")
  if (!normalized || /^[A-Za-z]:($|\/)/.test(normalized)) {
    throw new Error("Artifact path must be a relative path inside the artifact root")
  }

  const segments = normalized.split("/").filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Artifact path must be a relative path without current-directory or parent-directory segments")
  }

  return segments.join("/")
}

export function resolveArtifactPath(root: string, path: string): ResolvedArtifactPath {
  const absoluteRoot = resolve(root)
  const relativePath = safeArtifactRelativePath(path)
  const absolutePath = resolve(absoluteRoot, relativePath)

  if (!isPathInside(absoluteRoot, absolutePath)) {
    throw new Error(`Artifact path must stay inside the artifact root: ${path}`)
  }

  return { root: absoluteRoot, relativePath, absolutePath }
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}
