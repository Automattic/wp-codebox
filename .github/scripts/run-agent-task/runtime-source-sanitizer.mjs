import { resolve } from "node:path"

const PRIVATE_RUNTIME_SOURCE_FIELDS = new Set(["source_package_root"])
export const RUNTIME_SOURCE_PLACEHOLDER = "[runtime-source]"

function runtimeSourceRoots(root) {
  return (Array.isArray(root) ? root : [root]).filter((entry) => typeof entry === "string" && entry).map((entry) => resolve(entry)).sort((left, right) => right.length - left.length)
}

function runtimeSourceProvenance(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source
  const descriptor = source
  const provenance = { role: descriptor.role }
  if (descriptor.source?.type === "https_zip") {
    provenance.source = { type: "https_zip", url: descriptor.source.url, sha256: descriptor.source.sha256, ...(descriptor.source.archive_root ? { archive_root: descriptor.source.archive_root } : {}) }
  } else {
    Object.assign(provenance, ...["repository", "revision", "path", "digest"].flatMap((key) => descriptor[key] ? [{ [key]: descriptor[key] }] : []))
  }
  if (descriptor.role === "provider_plugin" && Array.isArray(descriptor.metadata?.providers)) provenance.providers = descriptor.metadata.providers
  return provenance
}

export function sanitizeRuntimeSourceText(value, root) {
  if (typeof value !== "string") return value
  return runtimeSourceRoots(root).reduce((sanitized, sourceRoot) => sanitized.split(sourceRoot).join(RUNTIME_SOURCE_PLACEHOLDER), value)
}

// Runtime results may place paths anywhere, including diagnostics, stack traces,
// command arguments, metadata, and object keys.
export function sanitizeRuntimeSourceValue(value, root) {
  if (typeof value === "string") return sanitizeRuntimeSourceText(value, root)
  if (Array.isArray(value)) return value.map((entry) => sanitizeRuntimeSourceValue(entry, root))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (PRIVATE_RUNTIME_SOURCE_FIELDS.has(key)) return []
    if (key === "runtime_sources" && Array.isArray(entry)) return [[key, entry.map(runtimeSourceProvenance).map((source) => sanitizeRuntimeSourceValue(source, root))]]
    return [[sanitizeRuntimeSourceText(key, root), sanitizeRuntimeSourceValue(entry, root)]]
  }))
}

export function sanitizeRuntimeSourceJson(text, root) {
  try {
    return `${JSON.stringify(sanitizeRuntimeSourceValue(JSON.parse(text), root), null, 2)}\n`
  } catch {
    return sanitizeRuntimeSourceText(text, root)
  }
}

export function assertNoRuntimeSourcePaths(value, root, message = "Runtime source paths must never be persisted in workflow results or artifacts.") {
  const serialized = JSON.stringify(value)
  if (runtimeSourceRoots(root).some((sourceRoot) => serialized.includes(sourceRoot))) throw new Error(message)
}
