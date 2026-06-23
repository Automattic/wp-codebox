import { isAbsolute, normalize, relative, sep } from "node:path"

export type NamedFileTreeSkipPolicy = "prepared-source" | "captured-mount"

const FILE_TREE_SKIP_POLICIES = {
  "prepared-source": [".git", "node_modules"],
  "captured-mount": [".git", "node_modules", "target"],
} as const satisfies Record<NamedFileTreeSkipPolicy, readonly string[]>

export function normalizeRelativePath(path: string): string {
  return normalize(path.replaceAll("\\", "/")).replaceAll("\\", "/").replace(/^\.\//, "")
}

export function normalizeRootedPath(path: string, root = "/"): string {
  const absolutePath = path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`
  const normalized = normalize(absolutePath)
  return normalized.startsWith("/") ? normalized : `/${normalized}`
}

export function pathIsWithinRoot(path: string, root: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

export function relativePathIsWithinRoot(path: string, root: string): boolean {
  return pathIsWithinRoot(normalizeRootedPath(path), normalizeRootedPath(root))
}

export function namedFileTreeSkipPolicy(policy: NamedFileTreeSkipPolicy): Set<string> {
  return new Set(FILE_TREE_SKIP_POLICIES[policy])
}

export function namedFileTreeSkipPolicyNames(policy: NamedFileTreeSkipPolicy): string[] {
  return [...FILE_TREE_SKIP_POLICIES[policy]]
}

export function fileTreeEntryNameSkipped(name: string, skipNames: ReadonlySet<string> | readonly string[]): boolean {
  if (Array.isArray(skipNames)) {
    return skipNames.includes(name)
  }

  return (skipNames as ReadonlySet<string>).has(name)
}

export function relativePathExcluded(relativePath: string, excludePaths: readonly string[]): boolean {
  const normalized = normalizeRelativePath(relativePath).replace(/^\/+/, "")
  return excludePaths.some((pattern) => relativePathMatchesExcludePattern(normalized, pattern))
}

export function relativePathMatchesExcludePattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern).trim().replace(/^\/+/, "").replace(/\/+$/, "")
  if (!normalizedPattern) {
    return false
  }

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/+$/, "")
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  }

  return relativePath === normalizedPattern || relativePath.startsWith(`${normalizedPattern}/`)
}

export function phpStringArrayLiteral(values: readonly string[]): string {
  return `array(${values.map((value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(", ")})`
}
