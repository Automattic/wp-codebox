import { createHash } from "node:crypto"
import { posix } from "node:path"

import type { WorkspaceRecipe } from "@automattic/wp-codebox-core"

export interface InputMountPathMapping {
  originalTarget: string
  canonicalTarget: string
}

export function recipeInputMountPathMap(recipe: WorkspaceRecipe): InputMountPathMapping[] {
  return (recipe.inputs?.mounts ?? []).reduce<InputMountPathMapping[]>((mappings, mount, index) => {
    const originalTarget = normalizeSandboxPath(mount.target)
    // Later declarations overlay the most-specific earlier target. Declaration
    // order therefore determines ownership for equal or otherwise ambiguous
    // overlaps, matching the order mounts are materialized into Playground.
    const parent = [...mappings]
      .filter((mapping) => pathHasMappedPrefix(originalTarget, mapping.originalTarget))
      .sort((a, b) => b.originalTarget.length - a.originalTarget.length)[0]
    mappings.push({
      originalTarget,
      canonicalTarget: parent
        ? `${parent.canonicalTarget}${originalTarget.slice(parent.originalTarget.length)}`
        : canonicalInputMountTarget(originalTarget, index),
    })
    return mappings
  }, [])
}

export function rewriteInputMountPathArgs(args: readonly string[] = [], mappings: readonly InputMountPathMapping[] = []): string[] {
  if (mappings.length === 0) {
    return [...args]
  }
  return args.map((arg) => rewriteInputMountPathReferences(arg, mappings))
}

export function rewriteInputMountPathJsonArgs(args: readonly string[] = [], names: readonly string[] = [], mappings: readonly InputMountPathMapping[] = []): string[] {
  if (mappings.length === 0 || names.length === 0) {
    return [...args]
  }
  const nameSet = new Set(names)
  return args.map((arg) => {
    const separator = arg.indexOf("=")
    if (separator <= 0 || !nameSet.has(arg.slice(0, separator))) {
      return arg
    }
    const value = arg.slice(separator + 1)
    try {
      return `${arg.slice(0, separator + 1)}${JSON.stringify(rewriteInputMountPathsInJsonValue(JSON.parse(value), mappings))}`
    } catch {
      return arg
    }
  })
}

export function rewriteInputMountPath(path: string, mappings: readonly InputMountPathMapping[] = []): string {
  const normalized = normalizeSandboxPath(path)
  const match = [...mappings]
    .sort((a, b) => b.originalTarget.length - a.originalTarget.length)
    .find((mapping) => pathHasMappedPrefix(normalized, mapping.originalTarget))
  if (!match) {
    return path
  }
  const suffix = normalized.slice(match.originalTarget.length)
  return `${match.canonicalTarget}${suffix}`
}

export function assertResolvedInputMountPathArgs(args: readonly string[] = [], mappings: readonly InputMountPathMapping[] = [], context = "execution spec"): void {
  const stale = args.flatMap((arg, index) => staleInputMountPathReferences(arg, mappings).map((mapping) => ({ index, arg, mapping })))
  if (stale.length === 0) {
    return
  }
  const details = stale.map((entry) => `arg[${entry.index}] references ${entry.mapping.originalTarget} after canonicalization to ${entry.mapping.canonicalTarget}: ${entry.arg}`).join("\n")
  throw new Error(`${context} still references original input mount target after path canonicalization.\n${details}\nresolvedArgs=${JSON.stringify(args)}`)
}

function staleInputMountPathReferences(arg: string, mappings: readonly InputMountPathMapping[]): InputMountPathMapping[] {
  return mappings
    .filter((mapping) => mapping.originalTarget !== mapping.canonicalTarget)
    .filter((mapping) => originalPathReferencePattern(mapping.originalTarget).test(arg))
}

function rewriteInputMountPathsInJsonValue(value: unknown, mappings: readonly InputMountPathMapping[]): unknown {
  if (typeof value === "string") {
    if (value.startsWith("/")) {
      return rewriteInputMountPath(value, mappings)
    }
    return rewriteInputMountPathArgs([value], mappings)[0]
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteInputMountPathsInJsonValue(entry, mappings))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteInputMountPathsInJsonValue(entry, mappings)]))
  }
  return value
}

function rewriteInputMountPathReferences(value: string, mappings: readonly InputMountPathMapping[]): string {
  return [...mappings]
    .sort((a, b) => b.originalTarget.length - a.originalTarget.length)
    .reduce((rewritten, mapping) => rewritten.replace(originalPathReferencePattern(mapping.originalTarget, "g"), mapping.canonicalTarget), value)
}

function originalPathReferencePattern(path: string, flags = ""): RegExp {
  return new RegExp(`${escapeRegExp(path)}(?=$|[\\/\\s'"\\]\\}\\),:;])`, flags)
}

// Mounts targeting the WordPress install tree (ABSPATH is `/wordpress/` in the
// Playground runtime) must keep their declared paths. WordPress core, plugin
// activation, and the phpunit handler (which computes
// `/wordpress/wp-content/plugins/<slug>`) all depend on those exact locations,
// and the Playground VFS mounts them cleanly in place. Canonicalizing them into
// `/tmp/wp-codebox-inputs/...` relocates the plugin-under-test outside the
// plugins directory, so WordPress never loads it and its composer autoloader
// never registers — crashing phpunit at class-collection time. Relocation is
// only needed for mounts targeting arbitrary paths that collide with sandbox
// internals (e.g. `/home/wpcom/public_html`, `/wp-codebox-vendor`).
const RESERVED_INPUT_MOUNT_TARGET_ROOT = "/wordpress"

function canonicalInputMountTarget(target: string, index: number): string {
  const normalized = normalizeSandboxPath(target)
  if (isReservedInputMountTarget(normalized)) {
    return normalized
  }
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12)
  const name = safeInputMountTargetName(posix.basename(normalized)) || "mount"
  return `/tmp/wp-codebox-inputs/${index}-${name}-${hash}`
}

function isReservedInputMountTarget(normalized: string): boolean {
  return normalized === RESERVED_INPUT_MOUNT_TARGET_ROOT || normalized.startsWith(`${RESERVED_INPUT_MOUNT_TARGET_ROOT}/`)
}

function safeInputMountTargetName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
}

function normalizeSandboxPath(path: string): string {
  const normalized = posix.normalize(path.trim().replace(/\\+/g, "/"))
  return normalized === "/" ? normalized : normalized.replace(/\/+$/g, "")
}

function pathHasMappedPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
