import { execFile } from "node:child_process"
import { readFile, lstat, realpath, readdir } from "node:fs/promises"
import { isAbsolute, resolve, relative } from "node:path"
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
  seedIdentity?: RunnerWorkspaceSeedIdentity
  verify?: () => Promise<void>
}

export interface RunnerWorkspaceSeedIdentity {
  content_digest: { algorithm: "sha256"; value: string }
  git?: { head: string }
}

export interface RunnerWorkspaceApplyFailureEvidence {
  expected_identity?: RunnerWorkspaceSeedIdentity
  actual_identity: RunnerWorkspaceSeedIdentity
  patch: { artifact_path: string; sha256: string }
  changed_files: { artifact_path: string; sha256: string }
}

export interface RunnerWorkspaceApplyResult {
  schema: "wp-codebox/runner-workspace-apply-result/v1"
  status: "applied" | "no-op"
  changedFiles: string[]
  patchSha256?: string
  integrity?: RunnerWorkspaceIntegritySnapshot
  publicationFiles?: RunnerWorkspacePublicationFile[]
}

export interface RunnerWorkspacePublicationFile {
  path: string
  mode: "100644" | "100755"
  content?: string
  sha256?: string
  deleted: boolean
}

export interface RunnerWorkspaceIntegritySnapshot {
  workspaceRoot: string
  files: RunnerWorkspacePublicationFile[]
  baseline: RunnerWorkspacePublicationFile[]
}

export interface RunnerWorkspaceIntegrityFailureEvidence {
  schema: "wp-codebox/runner-workspace-integrity-failure/v1"
  added: string[]
  modified: string[]
  deleted: string[]
  total: number
  truncated: boolean
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
  const baseline = await snapshotWorkspace(workspaceRoot)
  verifyDigest(patch, patchRef.sha256)

  const changed = parseChangedFiles(changedRaw)
  validateChangedFiles(changed, request.writablePaths)
  const failureEvidence = runnerWorkspaceFailureEvidence(request.seedIdentity, await runnerWorkspaceIdentity(workspaceRoot), artifactRoot, patchPath, patch, changedPath, changedRaw)
  if (request.seedIdentity) {
    if (!sameIdentity(request.seedIdentity, failureEvidence.actual_identity)) {
      throw applyFailure("Runner workspace seed identity does not match the host workspace; refusing to apply patch.", {
        ...failureEvidence,
      })
    }
  }
  if (changed.length === 0) {
    if (patch.trim()) throw new Error("Canonical patch is non-empty but changed-files declares no changes.")
    return { schema: "wp-codebox/runner-workspace-apply-result/v1", status: "no-op", changedFiles: [] }
  }
  if (!patch.trim()) throw new Error("Canonical changed-files declares changes but patch is empty.")
  validatePatchPaths(patch, changed)

  try {
    await execGit(workspaceRoot, ["apply", "--check", "--whitespace=error", "--", patchPath])
    await execGit(workspaceRoot, ["apply", "--whitespace=error", "--", patchPath])
  } catch (error) {
    throw applyFailure(error instanceof Error ? error.message : String(error), failureEvidence)
  }
  const files = await snapshotWorkspace(workspaceRoot)
  validateAppliedWorkspace(baseline, files, changed)
  if (request.verify) await request.verify()

  return {
    schema: "wp-codebox/runner-workspace-apply-result/v1",
    status: "applied",
    changedFiles: changed.map((file) => file.relativePath),
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    integrity: { workspaceRoot, files, baseline },
    publicationFiles: changed.map((change) => {
      const file = files.find((candidate) => candidate.path === change.relativePath)
      return file ? file : { path: change.relativePath, mode: "100644", deleted: true }
    }),
  }
}

export async function runnerWorkspaceIdentity(root: string): Promise<RunnerWorkspaceSeedIdentity> {
  const digest = createHash("sha256")
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if ([".git", ".codebox", "node_modules", "vendor", "dist", "build", "coverage", ".cache"].includes(entry.name)) continue
      const absolute = resolve(directory, entry.name)
      const path = relative(root, absolute).replaceAll("\\", "/")
      const stat = await lstat(absolute)
      if (excludedSeedFile(path)) continue
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Runner workspace contains an unsupported path type: ${path}`)
      if (stat.isDirectory()) {
        digest.update(`directory\0${path}\n`)
        await visit(absolute)
        continue
      }
      const bytes = await readFile(absolute)
      digest.update(`file\0${path}\0${(stat.mode & 0o111 ? 0o755 : 0o644).toString(8)}\0${bytes.length}\n`)
      digest.update(bytes)
    }
  }
  await visit(root)
  const identity: RunnerWorkspaceSeedIdentity = { content_digest: { algorithm: "sha256", value: digest.digest("hex") } }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, maxBuffer: 1024 })
    const head = stdout.trim()
    if (/^[a-f0-9]{40}$/i.test(head)) identity.git = { head }
  } catch { /* A non-git workspace still has a content identity. */ }
  return identity
}

/** Ensures checks did not mutate approved output or introduce unrelated files. */
export async function verifyRunnerWorkspaceIntegrity(snapshot: RunnerWorkspaceIntegritySnapshot): Promise<void> {
  const current = await snapshotWorkspace(snapshot.workspaceRoot)
  if (JSON.stringify(current) !== JSON.stringify(snapshot.files)) {
    const approved = new Map(snapshot.files.map((file) => [file.path, file]))
    const actual = new Map(current.map((file) => [file.path, file]))
    const added = [...actual.keys()].filter((path) => !approved.has(path)).sort()
    const deleted = [...approved.keys()].filter((path) => !actual.has(path)).sort()
    const modified = [...approved.keys()].filter((path) => actual.has(path) && JSON.stringify(approved.get(path)) !== JSON.stringify(actual.get(path))).sort()
    const changed = [...added, ...modified, ...deleted]
    const limit = 100
    const error = new Error(`Runner workspace changed after approval; refusing publication. Changed paths: ${changed.slice(0, 10).join(", ")}`) as Error & { evidence?: RunnerWorkspaceIntegrityFailureEvidence }
    error.evidence = {
      schema: "wp-codebox/runner-workspace-integrity-failure/v1",
      added: added.slice(0, limit),
      modified: modified.slice(0, limit),
      deleted: deleted.slice(0, limit),
      total: changed.length,
      truncated: changed.length > limit,
    }
    throw error
  }
}

function exactlyOne(refs: RunnerWorkspaceArtifactRef[], kind: string): RunnerWorkspaceArtifactRef {
  const matches = refs.filter((ref) => ref.kind === kind)
  if (matches.length !== 1) throw new Error(`Expected exactly one canonical ${kind} artifact reference.`)
  return matches[0]
}

async function artifactPath(root: string, value: string): Promise<string> {
  if (!value) throw new Error("Artifact reference path is required.")
  const requested = isAbsolute(value) ? resolve(value) : resolve(root, value)
  const requestedStat = await lstat(requested)
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) throw new Error("Artifact must be a bounded regular file.")
  const candidate = await realpath(requested)
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
    if (![file.beforeMode, file.afterMode].filter(Boolean).every((mode) => mode === "100644" || mode === "100755")) throw new Error(`Changed file has an unsupported mode: ${file.relativePath}`)
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
  if (paths.length === 0 || paths.some((path) => !declared.has(path)) || [...declared].some((path) => !paths.includes(path))) throw new Error("Patch paths do not exactly correspond to canonical changed-files.")
  for (const line of patch.split("\n")) {
    if (/^(old mode|new mode|new file mode|deleted file mode) /.test(line)) {
      const mode = line.split(" ").at(-1)
      if (mode !== "100644" && mode !== "100755") throw new Error("Patch contains an unsupported file mode.")
    }
    if (/^(similarity index|rename from|rename to|copy from|copy to|Subproject commit)/.test(line)) throw new Error("Patch contains unsupported git metadata.")
  }
}

async function snapshotWorkspace(root: string): Promise<RunnerWorkspacePublicationFile[]> {
  const output: RunnerWorkspacePublicationFile[] = []
  const paths = await workspaceSnapshotPaths(root)
  for (const path of paths) {
    const absolute = resolve(root, path)
    if (!pathIsWithinRoot(absolute, root)) throw new Error(`Runner workspace contains a denied path: ${path}`)
    let stat
    try {
      stat = await lstat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Runner workspace contains an unsupported path type: ${path}`)
    const mode = (stat.mode & 0o111) ? "100755" : "100644"
    const bytes = await readFile(absolute)
    output.push({ path, mode, content: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), deleted: false })
  }
  return output
}

async function workspaceSnapshotPaths(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: MAX_PATCH_BYTES })
    return stdout.split("\0")
      .filter((path) => path && path !== ".codebox" && !path.startsWith(".codebox/"))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    const paths: string[] = []
    async function visit(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if ([".git", ".codebox", "node_modules", "vendor"].includes(entry.name)) continue
        const absolute = resolve(directory, entry.name)
        const path = relative(root, absolute).replaceAll("\\", "/")
        if (entry.isDirectory()) {
          await visit(absolute)
        } else {
          paths.push(path)
        }
      }
    }
    await visit(root)
    return paths.sort((left, right) => left.localeCompare(right))
  }
}

function validateAppliedWorkspace(baseline: RunnerWorkspacePublicationFile[], current: RunnerWorkspacePublicationFile[], changed: RunnerWorkspaceChangedFile[]): void {
  const before = new Map(baseline.map((file) => [file.path, file]))
  const after = new Map(current.map((file) => [file.path, file]))
  const actual = new Set([...before.keys(), ...after.keys()].filter((path) => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path))))
  const declared = new Set(changed.map((file) => file.relativePath))
  if (actual.size !== declared.size || [...actual].some((path) => !declared.has(path))) throw new Error("Applied workspace differs from the canonical changed-files manifest.")
  for (const file of changed) {
    const value = after.get(file.relativePath)
    if (file.status === "deleted") {
      if (value) throw new Error(`Canonical deletion was not applied: ${file.relativePath}`)
      continue
    }
    if (!value || value.mode !== file.afterMode) throw new Error(`Applied file mode does not match canonical manifest: ${file.relativePath}`)
  }
}

function sameIdentity(expected: RunnerWorkspaceSeedIdentity, actual: RunnerWorkspaceSeedIdentity): boolean {
  return expected.content_digest.algorithm === "sha256"
    && expected.content_digest.value === actual.content_digest.value
    && (!expected.git?.head || expected.git.head === actual.git?.head)
}

function runnerWorkspaceFailureEvidence(expected: RunnerWorkspaceSeedIdentity | undefined, actual: RunnerWorkspaceSeedIdentity, artifactRoot: string, patchPath: string, patch: string, changedPath: string, changedRaw: string): RunnerWorkspaceApplyFailureEvidence {
  return {
    ...(expected ? { expected_identity: expected } : {}),
    actual_identity: actual,
    patch: { artifact_path: relative(artifactRoot, patchPath).replaceAll("\\", "/"), sha256: createHash("sha256").update(patch).digest("hex") },
    changed_files: { artifact_path: relative(artifactRoot, changedPath).replaceAll("\\", "/"), sha256: createHash("sha256").update(changedRaw).digest("hex") },
  }
}

function excludedSeedFile(path: string): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? ""
  return (name === ".env" || (name.startsWith(".env.") && name !== ".env.example"))
    || [".npmrc", ".yarnrc.yml", ".pypirc", ".netrc", "auth.json", "credentials", "credentials.json", "secrets.json", "token.json", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].includes(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name)
}

function applyFailure(message: string, evidence: RunnerWorkspaceApplyFailureEvidence): Error {
  const error = new Error(message) as Error & { evidence?: RunnerWorkspaceApplyFailureEvidence }
  error.evidence = evidence
  return error
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
