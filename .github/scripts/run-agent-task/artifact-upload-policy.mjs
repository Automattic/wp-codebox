import { isAbsolute } from "node:path"

const SOURCE_TREE = /(^|\/)(prepared-plugins|prepared-source-packages|source-package[^/]*)(\/|$)/i
const SOURCE_FILE = /\.(?:php|phtml|js|mjs|cjs|jsx|ts|tsx)$/i
const PHP_OPENING_TAG = /<\?(?:php|=)(?:\s|$)/i
const PHP_DECLARATION = /\b(?:namespace\s+\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*|(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+[A-Za-z_]\w*|function\s+&?\s*[A-Za-z_]\w*\s*\()/i
const WORDPRESS_PLUGIN_HEADER = /\/\*[\s\S]{0,200}?\bPlugin Name\s*:/i

export function artifactSourcePathCategory(path) {
  if (SOURCE_TREE.test(path)) return "source-tree"
  if (SOURCE_FILE.test(path)) return "source-file"
  return ""
}

// Diagnostics commonly name runtime classes. Reject only PHP-shaped source, even
// when a source file has been disguised with a reviewer-safe extension.
export function containsRuntimeSourceContent(text) {
  const hasPhpTag = PHP_OPENING_TAG.test(text)
  const hasDeclaration = PHP_DECLARATION.test(text)
  return (hasPhpTag && hasDeclaration) || (WORDPRESS_PLUGIN_HEADER.test(text) && (hasPhpTag || hasDeclaration))
}

export function assertNoSeedSnapshotPaths(text) {
  if (/wp-codebox-runner-workspace-seed-/i.test(text)) throw new Error("Temporary runner workspace seed paths must never be persisted in artifact uploads.")
  try {
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit)
      const entry = value && typeof value === "object" && !Array.isArray(value) ? value : {}
      if (entry.seed && typeof entry.seed === "object" && !Array.isArray(entry.seed) && isAbsolute(entry.seed.source)) throw new Error("Absolute runner workspace seed paths must never be persisted in artifact uploads.")
      Object.values(entry).forEach(visit)
    }
    visit(JSON.parse(text))
  } catch (error) {
    if (error instanceof Error && /seed paths/.test(error.message)) throw error
  }
}

export function sanitizeSeedSnapshotJson(text) {
  try {
    const compact = (value, key = "") => {
      if (typeof value === "string") return value.replace(/\/?[^\s"']*wp-codebox-runner-workspace-seed-[^\s"']*/gi, "[runner-workspace-seed]")
      if (Array.isArray(value)) return value.map((entry) => compact(entry))
      if (!value || typeof value !== "object") return value
      const entry = value
      if (key === "seed" && typeof entry.source === "string") return { kind: "runner-workspace-seed" }
      return Object.fromEntries(Object.entries(entry).map(([childKey, item]) => [childKey, compact(item, childKey)]))
    }
    return `${JSON.stringify(compact(JSON.parse(text)), null, 2)}\n`
  } catch {
    return text
  }
}
