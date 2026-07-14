import { execFile } from "node:child_process"
import { readFile, lstat, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { pathIsWithinRoot, relativePathMatchesExcludePattern } from "./file-tree-policy.js"

const execFileAsync = promisify(execFile)
const MAX_PATCH_BYTES = 5 * 1024 * 1024

export interface RunnerWorkspaceArtifactRef {
  kind: string
  path: string
  sha256?: string
  size_bytes?: number
}

export interface RunnerWorkspaceChangedFile {
  path: string
  status: "added" | "modified" | "deleted"
  relativePath: string
  beforeMode?: string
  afterMode?: string
}

export interface RunnerWorkspaceApplyRequest {
  artifactRoot: string
  artifactRefs: RunnerWorkspaceArtifactRef[]
  workspaceRoot: string
  writablePaths: string[]
  verify?: () => Promise<void>
}

export interface RunnerWorkspaceApplyResult {
  schema: "wp-codebox/runner-workspace-apply-result/v1"
  status: "applied" | "no-op"
  changedFiles: string[]
  patchSha256?: string
}

/**
 * Promotes the canonical sandbox patch artifact into the checked-out workspace.
 * Artifact references are treated as locators only after containment and digest
 * checks; sandbox-provided paths and filesystem trees are never trusted.
 */
export async function applyRunnerWorkspacePatch(request: RunnerWorkspaceApplyRequest): Promise<RunnerWorkspaceApplyResult> {
  const artifactRoot = await realpath(resolve(request.artifactRoot))
  const workspaceRoot = await realpath(resolve(request.workspaceRoot))
  const patchRef = exactlyOne(request.artifactRefs, "codebox-patch")
  const changedRef = exactlyOne(request.artifactRefs, "codebox-changed-files")
  const patchPath = await artifactPath(artifactRoot, patchRef.path)
  const changedPath = await artifactPath(artifactRoot, changedRef.path)
  const [patch, changedRaw] = await Promise.all([readBoundedText(patchPath), readBoundedText(changedPath)])
  verifyDigest(patch, patchRef.sha256)

  const changed = parseChangedFiles(changedRaw)
  validateChangedFiles(changed, request.writablePaths)
  if (changed.length === 0) {
    if (patch.trim()) throw new Error("Canonical patch is non-empty but changed-files declares no changes.")
    return { schema: "wp-codebox/runner-workspace-apply-result/v1", status: "no-op", changedFiles: [] }
  }
  if (!patch.trim()) throw new Error("Canonical changed-files declares changes but patch is empty.")
  validatePatchPaths(patch, changed)

  await execGit(workspaceRoot, ["apply", "--check", "--whitespace=error", "--", patchPath])
  await execGit(workspaceRoot, ["apply", "--whitespace=error", "--", patchPath])
  if (request.verify) await request.verify()

  return {
    schema: "wp-codebox/runner-workspace-apply-result/v1",
    status: "applied",
    changedFiles: changed.map((file) => file.relativePath),
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  }
}

function exactlyOne(refs: RunnerWorkspaceArtifactRef[], kind: string): RunnerWorkspaceArtifactRef {
  const matches = refs.filter((ref) => ref.kind === kind)
  if (matches.length !== 1) throw new Error(`Expected exactly one canonical ${kind} artifact reference.`)
  return matches[0]
}

async function artifactPath(root: string, value: string): Promise<string> {
  if (!value) throw new Error("Artifact reference path is required.")
  const candidate = await realpath(isAbsolute(value) ? resolve(value) : resolve(root, value))
  if (!pathIsWithinRoot(candidate, root)) throw new Error("Artifact reference escapes the trusted artifact root.")
  return candidate
}

async function readBoundedText(path: string): Promise<string> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PATCH_BYTES) throw new Error("Artifact must be a bounded regular file.")
  const text = await readFile(path, "utf8")
  if (text.includes("\0")) throw new Error("Artifact must be text.")
  return text
}

function verifyDigest(text: string, expected?: string): void {
  if (!expected) return
  const digest = createHash("sha256").update(text).digest("hex")
  if (digest !== expected.replace(/^sha256:/, "")) throw new Error("Canonical patch digest does not match its artifact reference.")
}

function parseChangedFiles(raw: string): RunnerWorkspaceChangedFile[] {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { schema?: unknown }).schema !== "wp-codebox/changed-files/v1" || !Array.isArray((value as { files?: unknown }).files)) {
    throw new Error("Changed-files artifact does not match wp-codebox/changed-files/v1.")
  }
  return (value as { files: unknown[] }).files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Changed-files artifact contains an invalid file.")
    const record = file as Record<string, unknown>
    const relativePath = typeof record.relativePath === "string" ? record.relativePath : ""
    const status = record.status
    if (!relativePath || !["added", "modified", "deleted"].includes(String(status))) throw new Error("Changed-files artifact contains an invalid change.")
    return { path: typeof record.path === "string" ? record.path : relativePath, relativePath, status: status as RunnerWorkspaceChangedFile["status"], beforeMode: stringValue(record.beforeMode), afterMode: stringValue(record.afterMode) }
  })
}

function validateChangedFiles(files: RunnerWorkspaceChangedFile[], writablePaths: string[]): void {
  if (writablePaths.length === 0) throw new Error("A non-empty writable path policy is required.")
  for (const file of files) {
    const path = file.relativePath.replaceAll("\\", "/")
    if (!path || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git" || part === ".codebox")) throw new Error(`Changed file has a denied path: ${file.relativePath}`)
    if (![file.beforeMode, file.afterMode].filter(Boolean).every((mode) => mode === "100644")) throw new Error(`Changed file has an unsupported mode: ${file.relativePath}`)
    if (!writablePaths.some((pattern) => relativePathMatchesExcludePattern(path, pattern))) throw new Error(`Changed file is outside writable_paths: ${file.relativePath}`)
  }
}

function validatePatchPaths(patch: string, changed: RunnerWorkspaceChangedFile[]): void {
  const declared = new Set(changed.map((file) => file.relativePath))
  const paths = patch.split("\n").flatMap((line) => {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) return []
    const path = line.slice(4).split("\t", 1)[0].trim().replace(/^[ab]\//, "")
    return path === "/dev/null" ? [] : [path]
  })
  if (paths.length === 0 || paths.some((path) => !declared.has(path))) throw new Error("Patch paths do not exactly correspond to canonical changed-files.")
}

async function execGit(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, { cwd, maxBuffer: MAX_PATCH_BYTES })
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : ""
    throw new Error(`Host git apply failed: ${stderr || "patch rejected"}`)
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
