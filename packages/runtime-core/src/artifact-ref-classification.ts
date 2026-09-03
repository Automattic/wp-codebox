/**
 * Canonical artifact reference classification.
 *
 * Artifact reference kinds are classified in one place so every projection
 * derives its groups from the same rules instead of restating them.
 *
 * Classification has two modes, and the difference is a trust boundary rather
 * than an inconsistency:
 *
 * - `"typed"` accepts only explicitly declared artifact kinds. Projections that
 *   feed the workspace delta use this mode, because a reference classified as
 *   changed files or a patch describes changes a caller may apply. A path that
 *   merely looks like `files/patch.diff` must never earn that trust.
 * - `"discovery"` also infers from artifact paths. Read-only projections that
 *   list, link, or display references use this mode so partially typed bundles
 *   stay discoverable.
 *
 * Callers compose their own group sets from these predicates; the group shape a
 * surface publishes is its own concern, but what makes a reference a patch, a
 * transcript, or a log is decided here.
 */

export const CHANGED_FILES_ARTIFACT_PATH = "files/changed-files.json" as const
export const PATCH_ARTIFACT_PATH = "files/patch.diff" as const
export const ARTIFACT_MANIFEST_PATH = "manifest.json" as const

export type ArtifactRefClassificationMode = "typed" | "discovery"

export interface ClassifiableArtifactRef {
  kind: string
  path?: string
}

export function isArtifactBundleRef(ref: ClassifiableArtifactRef): boolean {
  return ref.kind === "artifact-bundle" || ref.kind === "codebox-artifact-bundle"
}

export function isEvidenceBundleArtifactRef(ref: ClassifiableArtifactRef): boolean {
  return ref.kind === "evidence-bundle" || ref.kind === "codebox-evidence-bundle"
}

export function isRuntimeArtifactRef(ref: ClassifiableArtifactRef): boolean {
  return ref.kind === "codebox-runtime"
}

export function isChangedFilesArtifactRef(ref: ClassifiableArtifactRef, mode: ArtifactRefClassificationMode = "typed"): boolean {
  if (ref.kind === "codebox-changed-files") return true
  if (mode === "typed") return false
  return ref.kind === "changed-files" || pathEndsWith(ref.path, CHANGED_FILES_ARTIFACT_PATH)
}

export function isPatchArtifactRef(ref: ClassifiableArtifactRef, mode: ArtifactRefClassificationMode = "typed"): boolean {
  if (ref.kind === "codebox-patch") return true
  if (mode === "typed") return false
  return ref.kind === "patch" || pathEndsWith(ref.path, PATCH_ARTIFACT_PATH)
}

export function isTranscriptArtifactRef(ref: ClassifiableArtifactRef, mode: ArtifactRefClassificationMode = "typed"): boolean {
  return mode === "typed" ? ref.kind === "codebox-transcript" : ref.kind.includes("transcript")
}

export function isLogArtifactRef(ref: ClassifiableArtifactRef, mode: ArtifactRefClassificationMode = "typed"): boolean {
  if (ref.kind === "codebox-runtime-log" || ref.kind === "codebox-command-log") return true
  if (mode === "typed") return false
  return ref.kind.includes("log") || pathHasExtension(ref.path, ".log") || pathHasExtension(ref.path, ".jsonl")
}

export function isBrowserArtifactRef(ref: ClassifiableArtifactRef): boolean {
  return ref.kind.startsWith("browser-") || pathIncludes(ref.path, "/browser/")
}

/**
 * Discovery-mode kind inference for references that arrive without a kind.
 * Typed projections never call this; they require a declared kind.
 */
export function kindForArtifactPath(path: string | undefined): string | undefined {
  if (pathEndsWith(path, CHANGED_FILES_ARTIFACT_PATH)) return "codebox-changed-files"
  if (pathEndsWith(path, PATCH_ARTIFACT_PATH)) return "codebox-patch"
  if (pathEndsWith(path, ARTIFACT_MANIFEST_PATH)) return "artifact-manifest"
  return undefined
}

/** Matches a trailing path segment, so `files/patch.diff` matches but `my-patch.diff` does not. */
function pathEndsWith(path: string | undefined, suffix: string): boolean {
  return typeof path === "string" && (path === suffix || path.endsWith(`/${suffix}`))
}

/** Matches a file extension on the final path segment. */
function pathHasExtension(path: string | undefined, extension: string): boolean {
  if (typeof path !== "string") return false
  const name = path.slice(path.lastIndexOf("/") + 1)
  return name.length > extension.length && name.endsWith(extension)
}

function pathIncludes(path: string | undefined, fragment: string): boolean {
  return typeof path === "string" && path.includes(fragment)
}
