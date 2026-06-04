import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const tempRoot = await mkdtemp(join(tmpdir(), "wp-codebox-installed-binary-smoke-"))
const packRoot = join(tempRoot, "pack")
const installRoot = join(tempRoot, "install")

try {
  await execFileAsync("npm", ["run", "build"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 })
  await mkdir(packRoot, { recursive: true })

  const { stdout: packStdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packRoot], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 10,
  })
  const [pack] = JSON.parse(packStdout) as Array<{ filename: string }>
  const tarballPath = join(packRoot, pack.filename)

  await execFileAsync("npm", ["install", "--global", tarballPath, "--prefix", installRoot, "--no-audit", "--no-fund"], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 40,
  })

  const binaryPath = join(installRoot, "bin", "wp-codebox")
  const { stdout } = await execFileAsync(binaryPath, ["commands", "--json"], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 10,
  })
  const catalog = JSON.parse(stdout) as { schema?: string; commands?: Array<{ id?: string }> }
  assert.equal(catalog.schema, "wp-codebox/command-catalog/v1", "Installed binary should emit the command catalog")
  assert.ok(
    catalog.commands?.some((command) => command.id === "wp-codebox.agent-sandbox-run"),
    "Installed binary should expose the agent sandbox recipe helper",
  )

  console.log("Package installed binary smoke passed")
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
