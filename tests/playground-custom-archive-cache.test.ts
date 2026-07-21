import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { acquirePlaygroundArchiveReference, maintainPlaygroundCustomArchiveCache, withPlaygroundArchiveCacheLock } from "../packages/runtime-playground/src/playground-wordpress-archive-cache.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-playground-custom-cache-"))
const now = Date.now()

try {
  const stableArchive = await archive("6.9.1.zip", 101, now - 100_000)
  const staleArchive = await archive("custom-stale.zip", 11, now - 100_000)
  const invalidArchive = await archive("custom-invalid.zip", 13, now - 100_000, "not a zip")
  const referencedArchive = await archive("custom-referenced.zip", 17, now - 100_000)
  const lockedArchive = await archive("custom-locked.zip", 19, now - 100_000)

  const firstReference = await acquirePlaygroundArchiveReference(referencedArchive)
  const secondReference = await acquirePlaygroundArchiveReference(referencedArchive)
  const activeLock = `${lockedArchive}.lock`
  await mkdir(activeLock)
  await writeFile(join(activeLock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() }))

  const dryRun = await maintainPlaygroundCustomArchiveCache(root, {
    mode: "dry-run",
    now,
    maxAgeMs: 1_000,
    maxBytes: 1_000,
    maxCount: 20,
  })
  assert.equal(dryRun.customArchiveCount, 4, "stable release archives must not enter custom retention")
  assert.equal(dryRun.candidateCount, 2, "stale unprotected archives must be candidates regardless of archive validity")
  assert.equal(dryRun.candidateBytes, 24)
  assert.deepEqual(dryRun.activeProtection, {
    count: 2,
    bytes: 36,
    lockCount: 1,
    referenceCount: 2,
    paths: [lockedArchive, referencedArchive].sort(),
  })
  assert.equal(dryRun.removedCount, 0)
  assert.deepEqual(await customArchiveNames(), ["custom-invalid.zip", "custom-locked.zip", "custom-referenced.zip", "custom-stale.zip"])

  await firstReference.release()
  const sharedUse = await maintainPlaygroundCustomArchiveCache(root, { mode: "diagnose", now, maxAgeMs: 1_000 })
  assert.equal(sharedUse.activeProtection.referenceCount, 1, "one shared user must keep the archive protected")
  assert.ok(sharedUse.activeProtection.paths.includes(referencedArchive))

  const applied = await maintainPlaygroundCustomArchiveCache(root, {
    mode: "apply",
    now,
    maxAgeMs: 1_000,
    maxBytes: 1_000,
    maxCount: 20,
  })
  assert.equal(applied.removedCount, 2)
  assert.equal(applied.removedBytes, 24)
  assert.equal(applied.verifiedReclaimedBytes, 24)
  assert.equal(applied.retainedCount, 2)
  assert.equal(applied.retainedBytes, 36)
  assert.deepEqual(await customArchiveNames(), ["custom-locked.zip", "custom-referenced.zip"])
  assert.ok((await readdir(root)).includes("6.9.1.zip"), "stable release archive must remain intact")

  await secondReference.release()
  await rm(activeLock, { recursive: true })
  const afterRelease = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1_000 })
  assert.equal(afterRelease.removedCount, 2, "teardown must make formerly active archives reclaimable")
  assert.deepEqual(await customArchiveNames(), [])

  for (let index = 0; index < 5; index += 1) {
    await archive(`custom-bound-${index}.zip`, 10, now - (5 - index) * 1_000)
  }
  const bounds = await maintainPlaygroundCustomArchiveCache(root, {
    mode: "apply",
    now,
    maxAgeMs: 1_000_000,
    maxBytes: 25,
    maxCount: 2,
  })
  assert.equal(bounds.candidateCount, 3, "count and byte bounds must retain only the newest fitting archives")
  assert.equal(bounds.removedCount, 3)
  assert.equal(bounds.verifiedReclaimedBytes, 30)
  assert.deepEqual(await customArchiveNames(), ["custom-bound-3.zip", "custom-bound-4.zip"])

  const idempotent = await maintainPlaygroundCustomArchiveCache(root, {
    mode: "apply",
    now,
    maxAgeMs: 1_000_000,
    maxBytes: 25,
    maxCount: 2,
  })
  assert.equal(idempotent.candidateCount, 0)
  assert.equal(idempotent.removedCount, 0)
  assert.equal(idempotent.verifiedReclaimedBytes, 0)

  const crashedArchive = await archive("custom-crashed.zip", 23, now - 100_000)
  const referencesDirectory = `${crashedArchive}.refs`
  await mkdir(referencesDirectory)
  await writeFile(join(referencesDirectory, "stale.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: new Date(now - 100_000).toISOString() }))
  const crashedLock = `${crashedArchive}.lock`
  await mkdir(crashedLock)
  await writeFile(join(crashedLock, "owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: new Date(now - 100_000).toISOString() }))
  const crashRecovery = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1_000 })
  assert.ok(crashRecovery.removedCount >= 1, "dead process locks and references must not retain stale archives forever")
  assert.ok(!(await customArchiveNames()).includes("custom-crashed.zip"))

  assert.ok((await readdir(root)).includes(stableArchive.split("/").at(-1)!))

  const recoveredVersion = "custom-recovered"
  const recoveredLock = join(root, `${recoveredVersion}.zip.lock`)
  await mkdir(recoveredLock)
  await writeFile(join(recoveredLock, "owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: new Date(now - 100_000).toISOString() }))
  let acquiredRecoveredLock = false
  await withPlaygroundArchiveCacheLock(root, recoveredVersion, async () => {
    acquiredRecoveredLock = true
  })
  assert.equal(acquiredRecoveredLock, true, "a crashed archive producer must not block future cache users")

  console.log("playground custom archive cache retention passed")
} finally {
  await rm(root, { recursive: true, force: true })
}

async function archive(name: string, size: number, mtimeMs: number, content = "x"): Promise<string> {
  const path = join(root, name)
  const bytes = Buffer.alloc(size, content)
  await writeFile(path, bytes)
  await utimes(path, mtimeMs / 1_000, mtimeMs / 1_000)
  return path
}

async function customArchiveNames(): Promise<string[]> {
  return (await readdir(root)).filter((name) => /^custom-.*\.zip$/.test(name)).sort()
}
