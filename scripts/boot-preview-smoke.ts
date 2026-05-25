import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-boot-preview-"))

try {
  const output = await runCliJson([
    "boot",
    "--mount",
    "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
    "--artifacts",
    artifactsDirectory,
    "--hold",
    "1s",
    "--json",
  ])

  assert.equal(output.success, true)
  assert.equal(output.schema, "wp-codebox/boot/v1")
  assert.equal(output.execution, undefined)
  assert.equal(output.runtime.backend, "wordpress-playground")
  assert.equal(output.artifacts.preview.status, "available")
  assert.equal(output.artifacts.preview.holdSeconds, 1)
  assert.match(output.artifacts.preview.url, /^http:\/\//)

  const commands = await readFile(output.artifacts.commandsPath, "utf8")
  assert.equal(commands.trim(), "", "boot should not create a fake workflow command")

  const review = JSON.parse(await readFile(output.artifacts.reviewPath, "utf8"))
  assert.equal(review.preview.status, "available")
  assert.equal(review.preview.holdSeconds, 1)

  const metadata = JSON.parse(await readFile(output.artifacts.metadataPath, "utf8"))
  assert.equal(metadata.context.task.kind, "cli-boot")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}

async function runCliJson(args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", ...args], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 10,
  })
  return JSON.parse(stdout)
}
