import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = new URL("..", import.meta.url).pathname
const cacheDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-doctor-cache-"))

try {
  const corruptArchive = join(cacheDirectory, "broken.zip")
  await writeFile(corruptArchive, "not a zip")

  const doctor = await runCli(["doctor", "--archive-root", cacheDirectory, "--json"])
  assert.equal(doctor.schema, "wp-codebox/doctor/v1")
  assert.equal(doctor.cleanup, false)
  assert.equal(doctor.status, "warning")
  assert.ok(doctor.checks.some((check: { id: string }) => check.id === "wp-codebox.binary"))
  assert.equal(existsSync(corruptArchive), true, "doctor must not remove corrupt archives without --fix")

  const cleanup = await runCli(["cleanup", "--archive-root", cacheDirectory, "--json"])
  assert.equal(cleanup.schema, "wp-codebox/doctor/v1")
  assert.equal(cleanup.cleanup, true)
  assert.equal(cleanup.status, "ok")
  assert.equal(existsSync(corruptArchive), false, "cleanup should remove corrupt archives")

  console.log("Doctor command smoke passed")
} finally {
  await rm(cacheDirectory, { recursive: true, force: true })
}

async function runCli(args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", ...args], { cwd: root })
  return JSON.parse(stdout)
}
