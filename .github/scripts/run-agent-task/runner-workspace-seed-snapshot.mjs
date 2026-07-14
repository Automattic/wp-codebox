import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

export const RUNNER_WORKSPACE_SEED_EXCLUDES = [".git/**", ".codebox/**", "node_modules/**", "vendor/**", "dist/**", "build/**", "coverage/**", ".cache/**"]
const EXCLUDED_ROOT_NAMES = new Set(RUNNER_WORKSPACE_SEED_EXCLUDES.map((pattern) => pattern.slice(0, -3)))
const MAX_FILES = 10_000
const MAX_BYTES = 256 * 1024 * 1024

function snapshotError(message) {
  const error = new Error(message)
  error.code = "wp-codebox.agent-task.runner-workspace-snapshot"
  return error
}

function fileMode(stat) {
  return stat.mode & 0o111 ? 0o755 : 0o644
}

export async function createRunnerWorkspaceSeedSnapshot(source) {
  const sourceRoot = resolve(source)
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-runner-workspace-seed-"))
  const digest = createHash("sha256")
  let fileCount = 0
  let byteCount = 0

  try {
    async function copyTree(currentSource, currentTarget) {
      const entries = await readdir(currentSource, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (EXCLUDED_ROOT_NAMES.has(entry.name)) continue
        const input = join(currentSource, entry.name)
        const output = join(currentTarget, entry.name)
        const stat = await lstat(input)
        const path = relative(sourceRoot, input).replaceAll("\\", "/")
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
          throw snapshotError(`Runner workspace seed contains unsupported filesystem entry: ${path}`)
        }
        if (stat.isDirectory()) {
          await mkdir(output, { recursive: true, mode: 0o755 })
          await chmod(output, 0o755)
          digest.update(`directory\0${path}\n`)
          await copyTree(input, output)
          continue
        }
        fileCount += 1
        byteCount += stat.size
        if (fileCount > MAX_FILES) throw snapshotError(`Runner workspace seed exceeds the ${MAX_FILES} file limit.`)
        if (byteCount > MAX_BYTES) throw snapshotError(`Runner workspace seed exceeds the ${MAX_BYTES} byte limit.`)
        const bytes = await readFile(input)
        digest.update(`file\0${path}\0${fileMode(stat).toString(8)}\0${bytes.length}\n`)
        digest.update(bytes)
        await copyFile(input, output)
        await chmod(output, fileMode(stat))
      }
    }

    const sourceStat = await lstat(sourceRoot)
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw snapshotError("Runner workspace seed source must be a real directory.")
    await copyTree(sourceRoot, root)
    return {
      source: root,
      provenance: {
        schema: "wp-codebox/runner-workspace-seed-snapshot/v1",
        digest: { sha256: digest.digest("hex") },
        files: fileCount,
        bytes: byteCount,
        excludes: RUNNER_WORKSPACE_SEED_EXCLUDES,
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
