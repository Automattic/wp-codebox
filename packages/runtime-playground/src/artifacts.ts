import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { normalizeBlueprint, preferredVersionsForEnvironment } from "./blueprint.js"
import type {
  ArtifactManifestFile,
  ArtifactProvenance,
  ArtifactReview,
  ArtifactTestResults,
  MountSpec,
  RuntimeCreateSpec,
  RuntimeInfo,
} from "@chubes4/wp-codebox-core"

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
  baselineSource: string
  artifactPath: string
  changed: boolean
}

export interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted"
  mountIndex: number
  mountTarget: string
  relativePath: string
  patchPath: string
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
}

export const MAX_CAPTURED_MOUNT_FILES = 200
export const MAX_CAPTURED_MOUNT_FILE_BYTES = 1024 * 1024
export const SKIPPED_CAPTURE_DIRECTORIES = new Set([".git", "node_modules"])

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
}: {
  artifactId: string
  createdAt: string
  provenance: ArtifactProvenance
  changedFiles: CanonicalChangedFiles
  patch: string
  contentDigest: string
  runtimeCreatedAt: string
  mounts: MountSpec[]
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
      patch: "files/patch.diff",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      artifactContentDigest: contentDigest,
      changedFiles: "files/changed-files.json",
      testResults: "files/test-results.json",
    },
    riskFlags: [],
  }
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
    runtime: stripUndefined({
      backend: runtime.backend,
      version: provenanceString(provenanceContext(context, "runtime"), "version"),
      wordpressVersion: runtime.environment.version,
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

export function fileEntry(path: string, kind: ArtifactManifestFile["kind"], contentType: string): ArtifactManifestFile {
  return { path, kind, contentType }
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

export async function directoryDiff(baselineDirectory: string, currentDirectory: string, targetPrefix: string): Promise<DirectoryDiffResult> {
  const [baselineFiles, currentFiles] = await Promise.all([
    listTextFiles(baselineDirectory),
    listTextFiles(currentDirectory),
  ])
  const paths = [...new Set([...baselineFiles.keys(), ...currentFiles.keys()])].sort()
  const patches: string[] = []
  const files: DirectoryDiffResult["files"] = []

  for (const relativePath of paths) {
    const before = baselineFiles.get(relativePath)
    const after = currentFiles.get(relativePath)
    if (before === after) {
      continue
    }

    const path = `${targetPrefix}/${relativePath}`
    patches.push(fileDiff(path, before ?? "", after ?? "", before === undefined, after === undefined))
    files.push({
      path,
      relativePath,
      status: before === undefined ? "added" : after === undefined ? "deleted" : "modified",
    })
  }

  return {
    patch: patches.join("\n"),
    files,
  }
}

async function listTextFiles(directory: string, prefix = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_CAPTURE_DIRECTORIES.has(entry.name)) {
      continue
    }

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const [path, contents] of await listTextFiles(fullPath, relativePath)) {
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

function provenanceContext(context: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = context[key]
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return undefined
  }

  return value
}

function provenanceString(context: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = context?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}

function fileDiff(path: string, before: string, after: string, isAdded: boolean, isDeleted: boolean): string {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  const oldPath = isAdded ? "/dev/null" : `a${path}`
  const newPath = isDeleted ? "/dev/null" : `b${path}`
  const lines = [
    `diff --git ${oldPath} ${newPath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ]

  return `${lines.join("\n")}\n`
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return []
  }

  return text.replace(/\n$/, "").split("\n")
}
