import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = new URL("..", import.meta.url).pathname
const cacheDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-doctor-cache-"))
const runtimeTempDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-doctor-runtime-"))

try {
  const corruptArchive = join(cacheDirectory, "broken.zip")
  const staleRuntime = join(runtimeTempDirectory, "wp-codebox-release-abandoned")
  await writeFile(corruptArchive, "not a zip")
  await mkdir(staleRuntime)
  await writeFile(join(staleRuntime, "payload"), "allocated runtime data")
  const staleTimestamp = new Date(Date.now() - 7200 * 1000)
  await utimes(join(staleRuntime, "payload"), staleTimestamp, staleTimestamp)
  await utimes(staleRuntime, staleTimestamp, staleTimestamp)

  const doctor = await runCli(["doctor", "--archive-root", cacheDirectory, "--json"])
  assert.equal(doctor.schema, "wp-codebox/doctor/v1")
  assert.equal(doctor.cleanup, false)
  assert.equal(doctor.status, "warning")
  assert.ok(doctor.checks.some((check: { id: string }) => check.id === "wp-codebox.binary"))
  const runtimeCheck = doctor.checks.find((check: { id: string }) => check.id === "wp-codebox.temp-runtime")
  assert.equal(runtimeCheck.details.candidateCount, 1)
  assert.ok(runtimeCheck.details.estimatedAllocatedBytes > 0)
  assert.equal(existsSync(corruptArchive), true, "doctor must not remove corrupt archives without --fix")

  const cleanup = await runCli(["cleanup", "--archive-root", cacheDirectory, "--json"])
  assert.equal(cleanup.schema, "wp-codebox/doctor/v1")
  assert.equal(cleanup.cleanup, true)
  assert.equal(cleanup.status, "ok")
  const cleanupRuntimeCheck = cleanup.checks.find((check: { id: string }) => check.id === "wp-codebox.temp-runtime")
  assert.equal(cleanupRuntimeCheck.details.reclaimedAllocatedBytes, runtimeCheck.details.estimatedAllocatedBytes)
  await assert.rejects(stat(staleRuntime), /ENOENT/)
  assert.equal(existsSync(corruptArchive), false, "cleanup should remove corrupt archives")

  console.log("Doctor command smoke passed")
} finally {
  await rm(cacheDirectory, { recursive: true, force: true })
  await rm(runtimeTempDirectory, { recursive: true, force: true })
}

async function runCli(args: string[]): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", ...args], { cwd: root, env: { ...process.env, TMPDIR: runtimeTempDirectory } })
  return JSON.parse(stdout)
}
