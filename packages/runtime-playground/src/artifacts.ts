import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { normalizeBlueprint, preferredVersionsForEnvironment } from "./blueprint.js"
import { artifactFileDigest } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import type {
  ArtifactDiagnostic,
  ArtifactPackageIdentity,
  ArtifactPackageProvenance,
  ArtifactPreview,
  ArtifactProvenance,
  ArtifactRedactionSummary,
  ArtifactReview,
  ArtifactReviewBrowserSummary,
  ArtifactTestResults,
  MountSpec,
  ObservationResult,
  RuntimeCreateSpec,
  RuntimeInfo,
  SandboxWorkspaceContract,
} from "@automattic/wp-codebox-core"

export { buildArtifactDiagnostics } from "@automattic/wp-codebox-core/artifacts"

export interface CapturedMountFile {
  mountIndex: number
  source: string
  target: string
  relativePath: string
  artifactPath: string
  size: number
  sha256: string
  contentType: string
  replayable: boolean
  replayContents?: string
}

export interface SkippedMountFile {
  mountIndex: number
  source: string
  target: string
  relativePath: string
  reason: string
}

export interface CapturedMountFiles {
  files: CapturedMountFile[]
  skipped: SkippedMountFile[]
  limits: {
    maxFiles: number
    maxFileBytes: number
    skippedDirectories: string[]
  }
}

export interface MountDiff {
  mountIndex: number
  source: string
  target: string
  baselineSource?: string
  artifactPath: string
  changed: boolean
  status: "changed" | "unchanged" | "skipped" | "failed"
  reason?: string
  error?: string
}

export interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted"
  mountIndex: number
  mountTarget: string
  relativePath: string
  patchPath: string
  beforeSha256?: string
  afterSha256?: string
  beforeMode?: string
  afterMode?: string
}

export interface CanonicalChangedFiles {
  schema: "wp-codebox/changed-files/v1"
  files: ChangedFile[]
}

export interface DirectoryDiffResult {
  patch: string
  files: Omit<ChangedFile, "mountIndex" | "mountTarget" | "patchPath">[]
}

export interface MountDiffsResult {
  mountDiffs: MountDiff[]
  changedFiles: CanonicalChangedFiles
  patch: string
  diagnostics: ArtifactDiagnostic[]
}

export interface WorkspacePatchArtifact {
  schema: "wp-codebox/workspace-patch/v1"
  createdAt: string
  contentDigest: {
    algorithm: "sha256"
    inputs: string[]
    value: string
  }
  summary: {
    changed: boolean
    files: number
    added: number
    modified: number
    deleted: number
  }
  workspace?: SandboxWorkspaceContract
  workspaces: Array<{
    mountIndex: number
    target: string
    source: string
    baselineSource?: string
    status: MountDiff["status"]
    changed: boolean
    sourceMode?: string
    workspaceRef?: string
    mountRole?: string
    component?: string
    repo?: string
    gitRef?: string
    defaultBranch?: string
    patch: string
  }>
  promotion: {
    changedFiles: string
    patch: string
    files: Array<ChangedFile & { intent: "promotion" }>
  }
  evidence: {
    mountDiffs: string
    diagnostics: string
    testResults: string
  }
}

interface RedactionResult {
  contents: string
  count: number
  byKind: Map<string, number>
}

export const MAX_CAPTURED_MOUNT_FILES = 200
export const MAX_CAPTURED_MOUNT_FILE_BYTES = 1024 * 1024
export const SKIPPED_CAPTURE_DIRECTORIES = new Set([".git", "node_modules", "target"])

const packageRequire = createRequire(import.meta.url)

const COMMON_SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "openai-api-key", pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/g },
  { kind: "github-token", pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "slack-token", pattern: /xox(?:a|b|p|o|s|r)-[A-Za-z0-9-]{20,}/g },
  { kind: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "aws-access-key", pattern: /A(?:KIA|SIA)[A-Z0-9]{16}/g },
]

export class ArtifactRedactor {
  private readonly replacements: Array<{ kind: string; pattern: RegExp }> = []
  private readonly artifactCounts = new Map<string, { count: number; kinds: Set<string> }>()
  private readonly byKind = new Map<string, number>()
  private total = 0

  constructor(secretEnv: Record<string, string> = {}) {
    this.replacements.push(...COMMON_SECRET_PATTERNS)

    for (const [name, value] of Object.entries(secretEnv)) {
      if (name.length > 0) {
        this.replacements.push({ kind: "configured-secret-name", pattern: new RegExp(escapeRegExp(name), "g") })
      }

      if (shouldRedactConfiguredSecretValue(value)) {
        this.replacements.push({ kind: "configured-secret-value", pattern: new RegExp(escapeRegExp(value), "g") })
      }
    }
  }

  redact(path: string, contents: string): string {
    const result = this.scan(contents)
    if (result.count > 0) {
      this.record(path, result)
    }

    return result.contents
  }

  summary(): ArtifactRedactionSummary {
    return {
      schema: "wp-codebox/artifact-redaction/v1",
      status: this.total > 0 ? "redacted" : "clean",
      total: this.total,
      byKind: Object.fromEntries([...this.byKind.entries()].sort(([left], [right]) => left.localeCompare(right))),
      artifacts: [...this.artifactCounts.entries()]
        .map(([path, artifact]) => ({ path, count: artifact.count, kinds: [...artifact.kinds].sort() }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }
  }

  private scan(contents: string): RedactionResult {
    let redacted = contents
    let count = 0
    const byKind = new Map<string, number>()

    for (const replacement of this.replacements) {
      redacted = redacted.replace(replacement.pattern, () => {
        count++
        byKind.set(replacement.kind, (byKind.get(replacement.kind) ?? 0) + 1)
        return `[REDACTED:${replacement.kind}]`
      })
    }

    return { contents: redacted, count, byKind }
  }

  private record(path: string, result: RedactionResult): void {
    this.total += result.count
    const artifact = this.artifactCounts.get(path) ?? { count: 0, kinds: new Set<string>() }
    artifact.count += result.count
    for (const [kind, count] of result.byKind) {
      artifact.kinds.add(kind)
      this.byKind.set(kind, (this.byKind.get(kind) ?? 0) + count)
    }
    this.artifactCounts.set(path, artifact)
  }
}

function shouldRedactConfiguredSecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 8) {
    return false
  }

  if (["true", "false", "null", "undefined"].includes(trimmed.toLowerCase())) {
    return false
  }

  if (/^[0-9]+$/.test(trimmed)) {
    return false
  }

  return true
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function artifactContentDigest(changedFilesJson: string, patch: string): string {
  return createHash("sha256")
    .update("wp-codebox/artifact-content/v1\n")
    .update("files/changed-files.json\n")
    .update(changedFilesJson)
    .update("\nfiles/patch.diff\n")
    .update(patch)
    .digest("hex")
}

export function buildArtifactReview({
  artifactId,
  createdAt,
  provenance,
  changedFiles,
  patch,
  contentDigest,
  runtimeCreatedAt,
  mounts,
  preview,
  previewEvidencePath,
  previewSessionEvidencePath,
  browser,
  diagnosticsPath,
}: {
  artifactId: string
  createdAt: string
  provenance: ArtifactProvenance
  changedFiles: CanonicalChangedFiles
  patch: string
  contentDigest: string
  runtimeCreatedAt: string
  mounts: MountSpec[]
  preview?: ArtifactPreview
  previewEvidencePath?: string
  previewSessionEvidencePath?: string
  browser?: ArtifactReviewBrowserSummary
  diagnosticsPath?: string
}): ArtifactReview {
  const stats = {
    added: changedFiles.files.filter((file) => file.status === "added").length,
    modified: changedFiles.files.filter((file) => file.status === "modified").length,
    deleted: changedFiles.files.filter((file) => file.status === "deleted").length,
    total: changedFiles.files.length,
  }
  const changedFileLabel = stats.total === 1 ? "1 file" : `${stats.total} files`
  const summary = stats.total > 0 ? `Sandbox produced changes in ${changedFileLabel}.` : "Sandbox produced no file changes."

  return {
    schema: "wp-codebox/artifact-review/v1",
    artifactId,
    createdAt,
    provenance,
    summary,
    stats,
    changedFiles: changedFiles.files.map((file) => ({
      path: file.path,
      status: file.status,
      label: `${file.status} ${file.relativePath}`,
      mountTarget: file.mountTarget,
      relativePath: file.relativePath,
    })),
    ...(preview ? { preview } : {}),
    progress: [
      {
        type: "boot",
        label: "Spinning up a test copy of your site...",
        action: "boot",
        timestamp: runtimeCreatedAt,
      },
      ...mounts.map((mount) => ({
        type: "mount" as const,
        label: `Loading ${basename(mount.target)}...`,
        component: mount.target,
        action: "mount",
      })),
      {
        type: "artifact",
        label: "Saving the result for review...",
        action: "capture",
        timestamp: createdAt,
      },
      {
        type: "complete",
        label: "Ready for your review.",
        action: "complete",
        timestamp: createdAt,
      },
    ],
    actions: [
      {
        kind: "approve",
        label: "Approve all changes",
        requiresApprovedFiles: true,
      },
      {
        kind: "approve-files",
        label: "Approve selected files",
        requiresApprovedFiles: true,
      },
      {
        kind: "discard",
        label: "Discard changes",
      },
      {
        kind: "iterate",
        label: "Request changes",
      },
    ],
    evidence: {
      workspacePatch: "files/workspace-patch.json",
      patch: "files/patch.diff",
      patchSha256: artifactFileDigest(patch).value,
      artifactContentDigest: contentDigest,
      changedFiles: "files/changed-files.json",
      ...(diagnosticsPath ? { diagnostics: diagnosticsPath } : {}),
      testResults: "files/test-results.json",
      runtimeReferenceManifest: "files/runtime-reference-manifest.json",
      runtimeReplayReferenceIndex: "files/runtime-replay-index.json",
      ...(previewEvidencePath ? { previewEvidence: previewEvidencePath } : {}),
      ...(previewSessionEvidencePath ? { previewSessionEvidence: previewSessionEvidencePath } : {}),
      ...(previewEvidencePath ? { previewEvidence: previewEvidencePath } : {}),
    },
    ...(browser ? { browser } : {}),
    riskFlags: suspiciousFullFileRewriteRiskFlags(patch),
  }
}

export function buildWorkspacePatchArtifact({
  createdAt,
  provenance,
  mounts,
  mountDiffs,
  changedFiles,
  contentDigest,
}: {
  createdAt: string
  provenance: ArtifactProvenance
  mounts: MountSpec[]
  mountDiffs: MountDiff[]
  changedFiles: CanonicalChangedFiles
  contentDigest: string
}): WorkspacePatchArtifact {
  const stats = {
    changed: changedFiles.files.length > 0,
    files: changedFiles.files.length,
    added: changedFiles.files.filter((file) => file.status === "added").length,
    modified: changedFiles.files.filter((file) => file.status === "modified").length,
    deleted: changedFiles.files.filter((file) => file.status === "deleted").length,
  }

  return {
    schema: "wp-codebox/workspace-patch/v1",
    createdAt,
    contentDigest: {
      algorithm: "sha256",
      inputs: ["files/changed-files.json", "files/patch.diff"],
      value: contentDigest,
    },
    summary: stats,
    workspace: provenance.workspace,
    workspaces: mountDiffs.map((diff) => {
      const mount = mounts[diff.mountIndex]
      const metadata = mount?.metadata ?? {}

      return stripUndefined({
        mountIndex: diff.mountIndex,
        target: diff.target,
        source: diff.source,
        baselineSource: diff.baselineSource,
        status: diff.status,
        changed: diff.changed,
        sourceMode: stringMetadata(metadata, "sourceMode"),
        workspaceRef: stringMetadata(metadata, "workspaceRef"),
        mountRole: stringMetadata(metadata, "mountRole") ?? stringMetadata(metadata, "kind"),
        component: stringMetadata(metadata, "component") ?? stringMetadata(metadata, "slug"),
        repo: stringMetadata(metadata, "repo"),
        gitRef: stringMetadata(metadata, "gitRef") ?? stringMetadata(metadata, "default_branch"),
        defaultBranch: stringMetadata(metadata, "default_branch"),
        patch: diff.artifactPath,
      })
    }),
    promotion: {
      changedFiles: "files/changed-files.json",
      patch: "files/patch.diff",
      files: changedFiles.files.map((file) => ({ ...file, intent: "promotion" as const })),
    },
    evidence: {
      mountDiffs: "files/diffs.json",
      diagnostics: "files/diagnostics.json",
      testResults: "files/test-results.json",
    },
  }
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function buildTestResults(): ArtifactTestResults {
  return {
    schema: "wp-codebox/test-results/v1",
    status: "unknown",
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      unknown: 0,
    },
    suites: [],
    rawLogReferences: [
      {
        path: "commands.jsonl",
        kind: "commands-jsonl",
      },
      {
        path: "logs/commands.log",
        kind: "commands-log",
      },
    ],
  }
}

export function buildArtifactProvenance({
  runtime,
  context,
  mounts,
}: {
  runtime: RuntimeInfo
  context: Record<string, unknown>
  mounts: MountSpec[]
}): ArtifactProvenance {
  return stripUndefined({
    task: provenanceContext(context, "task"),
    workspace: provenanceWorkspace(context),
    packages: buildArtifactPackageProvenance(runtime),
    runtime: stripUndefined({
      backend: runtime.backend,
      version: provenanceString(provenanceContext(context, "runtime"), "version"),
      wordpressVersion: runtime.environment.version,
      backendPackage: provenanceContext(context, "preparedRuntimeBackend"),
    }),
    agent: provenanceContext(context, "agent"),
    mounts: mounts.map((mount) => stripUndefined({
      type: mount.type,
      source: mount.source,
      target: mount.target,
      mode: mount.mode,
      metadata: mount.metadata,
    })),
  })
}

function buildArtifactPackageProvenance(runtime: RuntimeInfo): ArtifactPackageProvenance {
  const rootPackage = readPackageIdentity("../../../package.json", "wp-codebox")
  const corePackage = readPackageIdentity("../../runtime-core/package.json", "@automattic/wp-codebox-core")
  const playgroundPackage = readPackageIdentity("../package.json", "@automattic/wp-codebox-playground")
  const playgroundCliVersion = packageDependencyVersion(playgroundPackage.manifest, "@wp-playground/cli")
  const wordpressBuildsVersion = packageDependencyVersion(playgroundPackage.manifest, "@wp-playground/wordpress-builds")

  const provenance: ArtifactPackageProvenance = stripUndefined({
    schema: "wp-codebox/package-provenance/v1",
    wpCodebox: rootPackage.identity,
    runtimeCore: corePackage.identity,
    runtimePlayground: playgroundPackage.identity,
    playground: stripUndefined({
      cli: playgroundCliVersion ? { name: "@wp-playground/cli", version: playgroundCliVersion } : undefined,
      wordpressBuilds: wordpressBuildsVersion ? { name: "@wp-playground/wordpress-builds", version: wordpressBuildsVersion } : undefined,
    }),
    environment: stripUndefined({
      wordpressVersion: runtime.environment.version,
      phpVersion: provenanceString(runtime.environment as unknown as Record<string, unknown>, "phpVersion"),
      nodeVersion: process.versions.node,
    }),
  }) as ArtifactPackageProvenance

  return provenance
}

function readPackageIdentity(packagePath: string, fallbackName: string): { identity: ArtifactPackageIdentity, manifest: Record<string, unknown> } {
  try {
    const resolvedPath = packageRequire.resolve(packagePath)
    const contents = readFileSync(resolvedPath, "utf8")
    const manifest = JSON.parse(contents) as Record<string, unknown>
    const source = stripUndefined({
      ref: provenanceString(manifest, "gitHeadRef") ?? process.env.WP_CODEBOX_SOURCE_REF ?? process.env.GITHUB_REF_NAME ?? process.env.GITHUB_REF,
      sha: provenanceString(manifest, "gitHead") ?? process.env.WP_CODEBOX_SOURCE_SHA ?? process.env.GITHUB_SHA,
      digest: artifactFileDigest(contents),
    })

    return {
      identity: stripUndefined({
        name: provenanceString(manifest, "name") ?? fallbackName,
        version: provenanceString(manifest, "version"),
        source,
      }),
      manifest,
    }
  } catch {
    return { identity: { name: fallbackName }, manifest: {} }
  }
}

function packageDependencyVersion(manifest: Record<string, unknown>, name: string): string | undefined {
  return provenanceString(asRecord(manifest.dependencies), name)
    ?? provenanceString(asRecord(manifest.devDependencies), name)
    ?? provenanceString(asRecord(manifest.peerDependencies), name)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function buildBlueprintAfter({
  environment,
  capturedMounts,
}: {
  environment: RuntimeCreateSpec["environment"]
  capturedMounts: CapturedMountFiles
}): Record<string, unknown> {
  const baseBlueprint = normalizeBlueprint(environment.blueprint)
  const preferredVersions = preferredVersionsForEnvironment(environment.version, baseBlueprint)
  const replaySteps = capturedMounts.files
    .filter((file) => file.replayable && typeof file.replayContents === "string")
    .map((file) => ({
      step: "writeFile",
      path: file.target,
      data: {
        resource: "literal",
        name: basename(file.target),
        contents: file.replayContents,
      },
    }))

  return {
    $schema: "https://playground.wordpress.net/blueprint-schema.json",
    ...(baseBlueprint.extraLibraries ? { extraLibraries: baseBlueprint.extraLibraries } : {}),
    ...(preferredVersions ? { preferredVersions } : {}),
    landingPage: baseBlueprint.landingPage ?? "/",
    steps: [...baseBlueprint.steps, ...replaySteps],
  }
}

export function buildBlueprintAfterNotes({
  createdAt,
  runtimeId,
  environment,
  mounts,
  capturedMounts,
}: {
  createdAt: string
  runtimeId: string
  environment: RuntimeCreateSpec["environment"]
  mounts: MountSpec[]
  capturedMounts: CapturedMountFiles
}): Record<string, unknown> {
  const replayableFileCount = capturedMounts.files.filter((file) => file.replayable).length

  return {
    createdAt,
    runtime: {
      id: runtimeId,
      backend: "wordpress-playground",
      environment,
    },
    replayStatus: "partial",
    blueprintPath: "blueprint.after.json",
    mounts,
    capturedFilesPath: "files/mounted-files.json",
    capturedFileCount: capturedMounts.files.length,
    replayableFileCount,
    skippedFileCount: capturedMounts.skipped.length,
    limitations: [
      "Text files from readwrite mounts are embedded in blueprint.after.json as writeFile steps; binary files are copied into artifacts but not replayed yet.",
      "Database exports, option diffs, uploaded media, active theme/plugin state, and screenshots are not captured yet.",
    ],
    nextCaptureTargets: ["database-export", "active-theme", "active-plugins", "uploads", "binary-file-replay"],
  }
}

export function mountTargetPath(mount: MountSpec, relativePath: string): string {
  return `${mount.target.replace(/\/+$/, "")}/${relativePath}`
}

export function isReplayableText(buffer: Buffer, text: string): boolean {
  if (buffer.includes(0)) {
    return false
  }

  return !text.includes("\uFFFD")
}

export function serializeCapturedMountFiles(captured: CapturedMountFiles): CapturedMountFiles {
  return {
    ...captured,
    files: captured.files.map(({ replayContents, ...file }) => file),
  }
}

export async function directoryDiff(baselineDirectory: string, currentDirectory: string, targetPrefix: string, excludePaths: string[] = []): Promise<DirectoryDiffResult> {
  const [baselineFiles, currentFiles] = await Promise.all([
    listTextFiles(baselineDirectory, "", excludePaths),
    listTextFiles(currentDirectory, "", excludePaths),
  ])
  const paths = [...new Set([...baselineFiles.keys(), ...currentFiles.keys()])].sort()
  const patches: string[] = []
  const files: DirectoryDiffResult["files"] = []

  for (const relativePath of paths) {
    const before = normalizePatchText(baselineFiles.get(relativePath))
    const after = normalizePatchText(currentFiles.get(relativePath))
    if (before === after) {
      continue
    }

    const path = `${targetPrefix}/${relativePath}`
    patches.push(fileDiff(path, before ?? "", after ?? "", before === undefined, after === undefined))
    files.push({
      path,
      relativePath,
      status: before === undefined ? "added" : after === undefined ? "deleted" : "modified",
      ...(before !== undefined ? { beforeSha256: artifactFileDigest(before).value, beforeMode: "100644" } : {}),
      ...(after !== undefined ? { afterSha256: artifactFileDigest(after).value, afterMode: "100644" } : {}),
    })
  }

  return {
    patch: patches.join("\n"),
    files,
  }
}

const execFileAsync = promisify(execFile)

/**
 * Detect whether a directory is the top level of a git work tree.
 *
 * Only returns true when the directory itself is the work-tree root, so a
 * mount that happens to live inside an unrelated parent repository is not
 * mistaken for a tracked workspace.
 */
export async function isGitWorkTree(directory: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      maxBuffer: 1024 * 1024,
    })
    const toplevel = stdout.trim()
    if (!toplevel) {
      return false
    }
    const [resolvedToplevel, resolvedDirectory] = await Promise.all([realpath(toplevel), realpath(directory)])
    return resolvedToplevel === resolvedDirectory
  } catch {
    return false
  }
}

/**
 * Diff a git work tree's current state (tracked changes + untracked files)
 * against its committed HEAD, returning the same shape as `directoryDiff`.
 *
 * HEAD is materialized into a temporary directory via `git archive`, then the
 * existing directory comparison machinery is reused so patch formatting,
 * redaction, and digests stay identical across both diff strategies. Untracked
 * files appear as additions because they are absent from the HEAD archive.
 */
export async function gitWorkingTreeDiff(repoDirectory: string, targetPrefix: string, excludePaths: string[] = []): Promise<DirectoryDiffResult> {
  const headDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-git-head-"))
  try {
    let hasHead = true
    try {
      await execFileAsync("git", ["-C", repoDirectory, "rev-parse", "--verify", "HEAD"], { maxBuffer: 1024 * 1024 })
    } catch {
      hasHead = false
    }

    if (hasHead) {
      // Materialize the committed tree without checking it out (the live work
      // tree stays untouched): write HEAD to a tar file, then extract it into a
      // temp directory the existing directory-diff machinery can read.
      const archivePath = join(headDirectory, ".wp-codebox-head.tar")
      await execFileAsync("git", ["-C", repoDirectory, "archive", "--format=tar", "-o", archivePath, "HEAD"], {
        maxBuffer: 1024 * 1024,
      })
      await execFileAsync("tar", ["-x", "-f", archivePath, "-C", headDirectory], { maxBuffer: 1024 * 1024 })
      await rm(archivePath, { force: true })
    }

    return await directoryDiff(headDirectory, repoDirectory, targetPrefix, excludePaths)
  } finally {
    await rm(headDirectory, { recursive: true, force: true })
  }
}

async function listTextFiles(directory: string, prefix = "", excludePaths: string[] = []): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_CAPTURE_DIRECTORIES.has(entry.name)) {
      continue
    }

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (relativePathExcluded(relativePath, excludePaths)) {
      continue
    }
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const [path, contents] of await listTextFiles(fullPath, relativePath, excludePaths)) {
        files.set(path, contents)
      }
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const buffer = await readFile(fullPath)
    const text = buffer.toString("utf8")
    if (isReplayableText(buffer, text)) {
      files.set(relativePath, text)
    }
  }

  return files
}

function relativePathExcluded(relativePath: string, excludePaths: string[]): boolean {
  const normalized = relativePath.replace(/^\/+/, "")
  return excludePaths.some((pattern) => excludePathMatches(normalized, pattern))
}

function excludePathMatches(relativePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim().replace(/^\/+/, "").replace(/\/+$/, "")
  if (!normalizedPattern) {
    return false
  }

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/+$/, "")
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  }

  return relativePath === normalizedPattern || relativePath.startsWith(`${normalizedPattern}/`)
}

function provenanceContext(context: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = context[key]
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return undefined
  }

  return value
}

function provenanceWorkspace(context: Record<string, unknown>): SandboxWorkspaceContract | undefined {
  const value = provenanceContext(context, "workspace")
  if (value?.schema !== "wp-codebox/sandbox-workspace/v1" || typeof value.root !== "string" || !Array.isArray(value.mounts)) {
    return undefined
  }

  return value as unknown as SandboxWorkspaceContract
}

function provenanceString(context: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = context?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fileDiff(path: string, before: string, after: string, isAdded: boolean, isDeleted: boolean): string {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  const gitOldPath = `a${path}`
  const gitNewPath = `b${path}`
  const oldPath = isAdded ? "/dev/null" : gitOldPath
  const newPath = isDeleted ? "/dev/null" : gitNewPath
  const lines = [
    `diff --git ${gitOldPath} ${gitNewPath}`,
    ...(isAdded ? ["new file mode 100644"] : []),
    ...(isDeleted ? ["deleted file mode 100644"] : []),
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    ...(isAdded || isDeleted ? fullFileHunk(beforeLines, afterLines, isAdded, isDeleted) : localizedFileHunk(beforeLines, afterLines)),
  ]

  return `${lines.join("\n")}\n`
}

function normalizePatchText(text: string | undefined): string | undefined {
  return text?.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function fullFileHunk(beforeLines: string[], afterLines: string[], isAdded: boolean, isDeleted: boolean): string[] {
  const oldStart = isAdded ? 0 : 1
  const newStart = isDeleted ? 0 : 1
  return [
    `@@ -${oldStart},${beforeLines.length} +${newStart},${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ]
}

function localizedFileHunk(beforeLines: string[], afterLines: string[]): string[] {
  const context = 3
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix++
  }

  const beforeChangeEnd = beforeLines.length - suffix
  const afterChangeEnd = afterLines.length - suffix
  const beforeHunkStart = Math.max(0, prefix - context)
  const afterHunkStart = Math.max(0, prefix - context)
  const beforeHunkEnd = Math.min(beforeLines.length, beforeChangeEnd + context)
  const afterHunkEnd = Math.min(afterLines.length, afterChangeEnd + context)
  const beforeHunkLength = beforeHunkEnd - beforeHunkStart
  const afterHunkLength = afterHunkEnd - afterHunkStart
  const lines = [`@@ -${hunkStartLine(beforeHunkStart, beforeHunkLength)},${beforeHunkLength} +${hunkStartLine(afterHunkStart, afterHunkLength)},${afterHunkLength} @@`]

  for (let index = beforeHunkStart; index < prefix; index++) {
    lines.push(` ${beforeLines[index]}`)
  }
  for (let index = prefix; index < beforeChangeEnd; index++) {
    lines.push(`-${beforeLines[index]}`)
  }
  for (let index = prefix; index < afterChangeEnd; index++) {
    lines.push(`+${afterLines[index]}`)
  }
  for (let index = afterChangeEnd; index < afterHunkEnd; index++) {
    lines.push(` ${afterLines[index]}`)
  }

  return lines
}

function hunkStartLine(startIndex: number, lineCount: number): number {
  return lineCount === 0 ? 0 : startIndex + 1
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return []
  }

  return text.replace(/\n$/, "").split("\n")
}

function suspiciousFullFileRewriteRiskFlags(patch: string): string[] {
  const flags = new Set<string>()
  let currentPath = ""
  let currentHunkLines = { old: 0, new: 0, added: 0, removed: 0 }

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      recordSuspiciousRewrite(flags, currentPath, currentHunkLines)
      currentPath = line.replace(/^diff --git a/, "").replace(/ b.*$/, "")
      currentHunkLines = { old: 0, new: 0, added: 0, removed: 0 }
      continue
    }

    const hunk = line.match(/^@@ -(?:\d+),(\d+) \+(?:\d+),(\d+) @@/)
    if (hunk) {
      recordSuspiciousRewrite(flags, currentPath, currentHunkLines)
      currentHunkLines = { old: Number(hunk[1]), new: Number(hunk[2]), added: 0, removed: 0 }
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunkLines.added++
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunkLines.removed++
    }
  }

  recordSuspiciousRewrite(flags, currentPath, currentHunkLines)
  return [...flags].sort()
}

function recordSuspiciousRewrite(flags: Set<string>, path: string, hunkLines: { old: number; new: number; added: number; removed: number }): void {
  const fileLines = Math.max(hunkLines.old, hunkLines.new)
  const touchedLines = hunkLines.added + hunkLines.removed
  const hunkLinesTotal = hunkLines.old + hunkLines.new
  if (!path || fileLines < 50 || hunkLinesTotal === 0) {
    return
  }

  if (touchedLines / hunkLinesTotal >= 0.8) {
    flags.add(`suspicious-full-file-rewrite:${path}`)
  }
}
