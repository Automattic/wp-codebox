import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

// Snapshot policy is intentionally allow-by-exception: disposable build trees and
// credential-bearing files never enter the agent-readable workspace. `.env.example`
// is the one documented environment-template exception.
export const RUNNER_WORKSPACE_SEED_EXCLUDES = [".git/**", ".codebox/**", "node_modules/**", "vendor/**", "dist/**", "build/**", "coverage/**", ".cache/**", ".env", ".env.*", ".npmrc", ".yarnrc.yml", ".pypirc", ".netrc", "auth.json", "id_rsa", "id_ed25519", "*.pem", "*.key", "credential files"]
const EXCLUDED_ROOT_NAMES = new Set(RUNNER_WORKSPACE_SEED_EXCLUDES.filter((pattern) => pattern.endsWith("/**")).map((pattern) => pattern.slice(0, -3)))
const MAX_FILES = 10_000
const MAX_BYTES = 256 * 1024 * 1024
const execFileAsync = promisify(execFile)

function snapshotError(message) {
  const error = new Error(message)
  error.code = "wp-codebox.agent-task.runner-workspace-snapshot"
  return error
}

function fileMode(stat) {
  return stat.mode & 0o111 ? 0o755 : 0o644
}

function secretCategory(path) {
  const name = path.split("/").at(-1)?.toLowerCase() || ""
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") return "environment"
  if ([".npmrc", ".yarnrc.yml", ".pypirc", ".netrc", "auth.json", "credentials", "credentials.json", "secrets.json", "token.json"].includes(name)) return "credentials"
  if (["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].includes(name) || /\.(?:pem|key|p12|pfx)$/i.test(name)) return "private-key"
  return ""
}

export async function createRunnerWorkspaceSeedSnapshot(source) {
  const sourceRoot = resolve(source)
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-runner-workspace-seed-"))
  const digest = createHash("sha256")
  let fileCount = 0
  let byteCount = 0
  const excluded = new Map()
  const exclude = (category) => excluded.set(category, (excluded.get(category) || 0) + 1)

  try {
    async function copyTree(currentSource, currentTarget) {
      const entries = await readdir(currentSource, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (EXCLUDED_ROOT_NAMES.has(entry.name)) {
          exclude("generated-tree")
          continue
        }
        const input = join(currentSource, entry.name)
        const output = join(currentTarget, entry.name)
        const stat = await lstat(input)
        const path = relative(sourceRoot, input).replaceAll("\\", "/")
        const category = secretCategory(path)
        if (category) {
          exclude(category)
          continue
        }
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
    const contentDigest = digest.digest("hex")
    const head = await gitHead(sourceRoot)
    return {
      source: root,
      provenance: {
        schema: "wp-codebox/runner-workspace-seed-snapshot/v1",
        digest: { sha256: contentDigest },
        identity: {
          content_digest: { algorithm: "sha256", value: contentDigest },
          ...(head ? { git: { head } } : {}),
        },
        files: fileCount,
        bytes: byteCount,
        excludes: RUNNER_WORKSPACE_SEED_EXCLUDES,
        excluded: {
          files: [...excluded.values()].reduce((total, count) => total + count, 0),
          categories: [...excluded.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, count]) => ({ category, count })),
        },
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function gitHead(source) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source })
    const head = stdout.trim()
    return /^[a-f0-9]{40}$/i.test(head) ? head : ""
  } catch {
    return ""
  }
}
