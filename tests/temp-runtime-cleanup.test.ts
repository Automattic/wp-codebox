import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inventoryTempRuntimeDirectories } from "../packages/cli/src/commands/temp-runtime-cleanup.js"

const customTmp = await mkdtemp(join(tmpdir(), "wp-codebox-cleanup-test-root-"))
const originalTmp = process.env.TMPDIR
process.env.TMPDIR = customTmp

try {
  const stale = await ownedDirectory("wp-codebox-release-stale", 7200)
  const recent = await ownedDirectory("wp-codebox-plugin-recent", 30)
  const live = await ownedDirectory("wp-codebox-readonly-mounts-live", 7200)
  const unrelated = await ownedDirectory("unrelated-project-cache", 7200)
  const fakePlayground = await ownedDirectory("node-playground-cli-site-fake", 7200)
  const registry = join(customTmp, "registry")
  await mkdir(join(registry, "preview-leases"), { recursive: true })

  const liveProcess = [{ pid: process.pid + 1000, command: `node worker ${live}`, references: [live] }]
  let report = await inventoryTempRuntimeDirectories({ cleanup: false, staleAfterSeconds: 3600, runRegistryRoots: [], processRows: liveProcess })
  assert.equal(report.tempRoot, customTmp, "effective TMPDIR is inventoried")
  assert.equal(report.candidateCount, 1)
  assert.equal(report.retainedReasons.recent, 1)
  assert.equal(report.retainedReasons["live-process"], 1)
  assert.ok(report.estimatedAllocatedBytes > 0)

  const leased = await ownedDirectory("wp-codebox-source-leased", 7200)
  await writeFile(join(registry, "preview-leases", "active.json"), JSON.stringify({ status: "available", expiresAt: new Date(Date.now() + 60_000).toISOString() }))
  report = await inventoryTempRuntimeDirectories({ cleanup: false, staleAfterSeconds: 3600, runRegistryRoots: [registry], processRows: [] })
  assert.equal(report.candidateCount, 0, "an active preview lease conservatively protects owned runtimes")
  assert.equal(report.retainedReasons["active-lease"], 3)
  await rm(join(registry, "preview-leases", "active.json"))

  await writeFile(join(registry, "recent-run.json"), JSON.stringify({ schema: "wp-codebox/run-registry-entry/v1", heartbeatAt: new Date().toISOString() }))
  report = await inventoryTempRuntimeDirectories({ cleanup: false, staleAfterSeconds: 3600, runRegistryRoots: [registry], processRows: [] })
  assert.equal(report.candidateCount, 0, "a recent run heartbeat conservatively protects owned runtimes")
  assert.equal(report.retainedReasons["recent-run"], 3)
  await rm(join(registry, "recent-run.json"))

  report = await inventoryTempRuntimeDirectories({ cleanup: true, staleAfterSeconds: 3600, runRegistryRoots: [], processRows: liveProcess })
  assert.equal(report.reclaimedAllocatedBytes, report.estimatedAllocatedBytes)
  await assert.rejects(stat(stale), /ENOENT/)
  await assert.rejects(stat(leased), /ENOENT/)
  await stat(recent)
  await stat(live)
  await stat(unrelated)
  await stat(fakePlayground)

  report = await inventoryTempRuntimeDirectories({ cleanup: true, staleAfterSeconds: 3600, runRegistryRoots: [], processRows: liveProcess })
  assert.equal(report.candidateCount, 0, "cleanup is idempotent")
  assert.equal(await readFile(join(unrelated, "payload"), "utf8"), "owned blocks")
  console.log("Temp runtime cleanup tests passed")
} finally {
  if (originalTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = originalTmp
  await rm(customTmp, { recursive: true, force: true })
}

async function ownedDirectory(name: string, ageSeconds: number): Promise<string> {
  const path = join(customTmp, name)
  await mkdir(path)
  await writeFile(join(path, "payload"), "owned blocks")
  const timestamp = new Date(Date.now() - ageSeconds * 1000)
  await utimes(join(path, "payload"), timestamp, timestamp)
  await utimes(path, timestamp, timestamp)
  return path
}
