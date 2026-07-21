import assert from "node:assert/strict"
import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

import { acquirePlaygroundArchiveReference, maintainPlaygroundCustomArchiveCache, playgroundWordPressArchiveCacheDirectory, withPlaygroundArchiveCacheLock } from "../packages/runtime-playground/src/playground-wordpress-archive-cache.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-playground-custom-cache-"))
const now = Date.now()
const environmentNames = [
  "WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR",
  "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_AGE_MS",
  "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_BYTES",
  "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT",
  "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_LEASE_MS",
] as const
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]))

try {
  const stableArchive = await archive("6.9.1.zip", 101, now - 100_000)
  await archive("custom-stale.zip", 11, now - 100_000)
  await archive("custom-invalid.zip", 13, now - 100_000, "not a zip")
  const referencedArchive = await archive("custom-referenced.zip", 17, now - 100_000)
  const lockedArchive = await archive("custom-locked.zip", 19, now - 100_000)

  const firstReference = await acquirePlaygroundArchiveReference(referencedArchive)
  const secondReference = await acquirePlaygroundArchiveReference(referencedArchive)
  const activeLock = `${lockedArchive}.lock`
  await mkdir(activeLock)
  await writeLease(join(activeLock, "owner.json"), { token: "foreign-active-lock", expiresAt: now + 60_000, ownerHostname: "foreign-host" })

  const dryRun = await maintainPlaygroundCustomArchiveCache(root, { mode: "dry-run", now, maxAgeMs: 1_000, maxBytes: 1_000, maxCount: 20 })
  assert.equal(dryRun.customArchiveCount, 4, "stable release archives must not enter custom retention")
  assert.equal(dryRun.candidateCount, 2, "stale unprotected archives must be candidates regardless of archive validity")
  assert.equal(dryRun.candidateBytes, 24)
  assert.deepEqual(dryRun.activeProtection, {
    count: 2,
    bytes: 36,
    lockCount: 1,
    referenceCount: 2,
    filesystemCount: 0,
    paths: [lockedArchive, referencedArchive].sort(),
  })
  assert.equal(dryRun.removedCount, 0)

  await firstReference.release()
  const sharedUse = await maintainPlaygroundCustomArchiveCache(root, { mode: "diagnose", now, maxAgeMs: 1_000 })
  assert.equal(sharedUse.activeProtection.referenceCount, 1, "one shared user must keep the archive protected")

  const staleAllocated = await allocatedBytes(join(root, "custom-stale.zip")) + await allocatedBytes(join(root, "custom-invalid.zip"))
  const applied = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1_000, maxBytes: 1_000, maxCount: 20 })
  assert.equal(applied.removedCount, 2)
  assert.equal(applied.removedBytes, 24)
  assert.equal(applied.estimatedAllocatedBytesRemoved, staleAllocated)
  assert.ok(Number.isFinite(applied.observedFilesystemFreeBytesDelta))
  assert.deepEqual(await customArchiveNames(), ["custom-locked.zip", "custom-referenced.zip"])
  assert.ok((await readdir(root)).includes("6.9.1.zip"), "stable release archive must remain intact")

  await secondReference.release()
  await rm(activeLock, { recursive: true })
  const afterRelease = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1_000 })
  assert.equal(afterRelease.removedCount, 2, "teardown must make formerly active archives reclaimable")

  for (let index = 0; index < 5; index += 1) {
    await archive(`custom-bound-${index}.zip`, 10, now - (5 - index) * 1_000)
  }
  const bounds = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1_000_000, maxBytes: 25, maxCount: 2 })
  assert.equal(bounds.candidateCount, 3)
  assert.equal(bounds.removedCount, 3)
  assert.deepEqual(await customArchiveNames(), ["custom-bound-3.zip", "custom-bound-4.zip"])
  const idempotent = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1_000_000, maxBytes: 25, maxCount: 2 })
  assert.equal(idempotent.candidateCount, 0)
  assert.equal(idempotent.removedCount, 0)

  const linkedTarget = join(root, "linked-target.zip")
  await writeFile(linkedTarget, Buffer.alloc(8_192, "h"))
  const hardLink = join(root, "custom-hard-link.zip")
  const symbolicLink = join(root, "custom-symbolic-link.zip")
  await link(linkedTarget, hardLink)
  await symlink(linkedTarget, symbolicLink)
  await utimes(hardLink, (now - 100_000) / 1_000, (now - 100_000) / 1_000)
  const links = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1 })
  assert.equal(links.activeProtection.filesystemCount, 2)
  assert.ok(links.diagnostics.some((item) => item.code === "custom-archive-multiply-linked"))
  assert.ok(links.diagnostics.some((item) => item.code === "custom-archive-not-regular"))
  assert.equal((await lstat(linkedTarget)).size, 8_192)
  assert.ok((await readdir(root)).includes("custom-hard-link.zip"))
  assert.ok((await readdir(root)).includes("custom-symbolic-link.zip"))

  const attackTarget = await mkdtemp(join(tmpdir(), "wp-codebox-playground-refs-attack-"))
  const attackMarker = join(attackTarget, "do-not-delete.txt")
  await writeFile(attackMarker, "outside cache")
  const attackedArchive = await archive("custom-refs-attack.zip", 41, now - 100_000)
  await symlink(attackTarget, `${attackedArchive}.refs`)
  await assert.rejects(() => acquirePlaygroundArchiveReference(attackedArchive), /must be a real directory/)
  const attackCleanup = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1 })
  assert.ok(attackCleanup.diagnostics.some((item) => item.code === "custom-archive-refs-not-directory"))
  assert.equal(await readFile(attackMarker, "utf8"), "outside cache", "reference cleanup must never follow a sidecar symlink")
  assert.ok(!await exists(`${attackedArchive}.refs`))
  const orphanAttack = join(root, "custom-orphan-attack.zip.refs")
  await symlink(attackTarget, orphanAttack)
  const orphanAttackCleanup = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now })
  assert.ok(!await exists(orphanAttack))
  assert.equal(await readFile(attackMarker, "utf8"), "outside cache")
  await rm(attackTarget, { recursive: true, force: true })

  const childAttackTarget = await mkdtemp(join(tmpdir(), "wp-codebox-playground-ref-child-attack-"))
  const externalLease = join(childAttackTarget, "external-lease.json")
  await writeLease(externalLease, { token: "external-symlink-lease", expiresAt: now + 60_000, ownerHostname: "outside-cache" })
  const childAttackArchive = await archive("custom-ref-child-attack.zip", 42, now - 100_000)
  await mkdir(`${childAttackArchive}.refs`)
  await symlink(externalLease, join(`${childAttackArchive}.refs`, "malicious.json"))
  const childAttackCleanup = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1 })
  assert.ok(childAttackCleanup.diagnostics.some((item) => item.code === "custom-archive-ref-entry-unsafe"))
  assert.ok(!await exists(childAttackArchive), "unsafe child lease entries must not protect stale archives")
  assert.ok(await exists(externalLease), "lease child inspection must never follow or remove an external symlink target")
  await rm(childAttackTarget, { recursive: true, force: true })

  const generationArchive = await archive("custom-generation-race.zip", 43, now - 100_000)
  const oldGeneration = await acquirePlaygroundArchiveReference(generationArchive, { leaseMs: 100, heartbeat: false })
  await new Promise((resolve) => setTimeout(resolve, 125))
  await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", maxAgeMs: 1 })
  await archive("custom-generation-race.zip", 43, Date.now())
  const replacementGeneration = await acquirePlaygroundArchiveReference(generationArchive, { leaseMs: 1_000, heartbeat: false })
  const replacementBefore = await readFile(replacementGeneration.path, "utf8")
  await oldGeneration.renew()
  assert.equal(await readFile(replacementGeneration.path, "utf8"), replacementBefore, "an old generation heartbeat must not overwrite its replacement")
  await oldGeneration.release()
  assert.ok(await exists(replacementGeneration.path), "old generation release must not remove replacement ownership")
  await replacementGeneration.release()

  const samePathArchive = await archive("custom-same-path-release.zip", 45, Date.now())
  const staleSamePath = await acquirePlaygroundArchiveReference(samePathArchive, { leaseMs: 1_000, heartbeat: false })
  await rm(staleSamePath.path)
  await writeLease(staleSamePath.path, { token: "same-path-replacement-token", expiresAt: Date.now() + 60_000 })
  const samePathReplacement = await readFile(staleSamePath.path, "utf8")
  await staleSamePath.release()
  assert.equal(await readFile(staleSamePath.path, "utf8"), samePathReplacement, "stale release must not unlink a replacement at the exact same pathname")
  await rm(staleSamePath.path)
  await rm(`${samePathArchive}.refs`, { recursive: true })

  const replacedCandidate = await archive("custom-replaced-candidate.zip", 47, now - 100_000)
  let replaced = false
  const replacementResult = await maintainPlaygroundCustomArchiveCache(root, {
    mode: "apply",
    now,
    maxAgeMs: 1,
    async candidateInterlock(path) {
      if (path !== replacedCandidate || replaced) return
      replaced = true
      await rm(path)
      await writeFile(path, "fresh replacement generation")
    },
  })
  assert.equal(await readFile(replacedCandidate, "utf8"), "fresh replacement generation")
  assert.ok(replacementResult.diagnostics.some((item) => item.code === "custom-archive-generation-changed"), "replacement generation must be revalidated after lock acquisition")

  const allocationRoot = await mkdtemp(join(tmpdir(), "wp-codebox-playground-allocation-"))
  const openArchive = join(allocationRoot, "custom-open-file.zip")
  await writeFile(openArchive, Buffer.alloc(1024 * 1024, "a"))
  await utimes(openArchive, 1, 1)
  const openHandle = await open(openArchive, "r")
  const openRemoval = await maintainPlaygroundCustomArchiveCache(allocationRoot, { mode: "apply", maxAgeMs: 1 })
  assert.equal(openRemoval.removedBytes, 1024 * 1024)
  assert.ok(openRemoval.estimatedAllocatedBytesRemoved >= 1024 * 1024)
  assert.ok(Number.isFinite(openRemoval.observedFilesystemFreeBytesDelta), "filesystem free-space delta is observational and may include concurrent allocation changes")
  await openHandle.close()
  await rm(allocationRoot, { recursive: true, force: true })

  const pidReuseArchive = await archive("custom-pid-reuse.zip", 23, now - 100_000)
  await mkdir(`${pidReuseArchive}.refs`)
  await writeLease(join(`${pidReuseArchive}.refs`, "reused-pid.json"), { token: "different-process-token", expiresAt: now + 60_000, pid: process.pid, processStart: "different-start" })
  const pidReuse = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1 })
  assert.ok(pidReuse.activeProtection.paths.includes(pidReuseArchive), "PID reuse must not invalidate an unexpired token lease")

  const expiredArchive = await archive("custom-expired-lease.zip", 29, now - 100_000)
  await mkdir(`${expiredArchive}.refs`)
  await writeLease(join(`${expiredArchive}.refs`, "expired.json"), { token: "expired-token", expiresAt: now - 1, pid: process.pid })
  const expired = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now, maxAgeMs: 1 })
  assert.ok(!await exists(expiredArchive), "expiry, not PID identity, must reclaim crashed leases")

  const orphanArchive = join(root, "custom-orphan.zip")
  await mkdir(`${orphanArchive}.refs`)
  await writeLease(join(`${orphanArchive}.refs`, "active.json"), { token: "foreign-reference", expiresAt: now + 60_000, ownerHostname: "remote-container" })
  const orphanLock = `${join(root, "custom-orphan-lock.zip")}.lock`
  await mkdir(orphanLock)
  await writeLease(join(orphanLock, "owner.json"), { token: "expired-orphan-lock", expiresAt: now - 1 })
  const orphanFirst = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now })
  assert.equal(orphanFirst.sidecars.orphanCount, 2)
  assert.equal(orphanFirst.sidecars.activeCount, 1)
  assert.equal(orphanFirst.sidecars.removedCount, 1)
  assert.ok(await exists(`${orphanArchive}.refs`), "foreign unexpired orphan lease must remain protected")
  await writeLease(join(`${orphanArchive}.refs`, "active.json"), { token: "foreign-reference", expiresAt: now - 1, ownerHostname: "remote-container" })
  const orphanExpired = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", now })
  assert.equal(orphanExpired.sidecars.removedCount, 1)
  assert.ok(!await exists(`${orphanArchive}.refs`))

  const concurrentArchive = await archive("custom-concurrent.zip", 31, now - 100_000)
  const concurrentReference = await acquirePlaygroundArchiveReference(concurrentArchive)
  const concurrentMaintenance = await Promise.all(Array.from({ length: 4 }, () => maintainPlaygroundCustomArchiveCache(root, { mode: "apply", maxAgeMs: 1 })))
  assert.ok(await exists(concurrentArchive), "concurrent maintenance must not race an acquired reference")
  assert.ok(concurrentMaintenance.some((result) => result.activeProtection.paths.includes(concurrentArchive)))
  await concurrentReference.release()

  const lockRaceArchive = await archive("custom-lock-race.zip", 37, now - 100_000)
  let lockAcquired!: () => void
  let releaseLock!: () => void
  const acquired = new Promise<void>((resolve) => { lockAcquired = resolve })
  const held = new Promise<void>((resolve) => { releaseLock = resolve })
  const lockHolder = withPlaygroundArchiveCacheLock(root, "custom-lock-race", async () => {
    lockAcquired()
    await held
  })
  await acquired
  const duringAcquisition = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", maxAgeMs: 1 })
  assert.ok(duringAcquisition.activeProtection.paths.includes(lockRaceArchive), "maintenance must protect an archive while another actor holds its acquisition lock")
  releaseLock()
  await lockHolder

  process.env.WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR = root
  process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_AGE_MS = "0"
  process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_BYTES = "1"
  process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT = "0"
  assert.equal(playgroundWordPressArchiveCacheDirectory(), root)
  const environmentPolicy = await maintainPlaygroundCustomArchiveCache(undefined, { mode: "dry-run" })
  assert.equal(environmentPolicy.policy.maxAgeMs, 0)
  assert.equal(environmentPolicy.policy.maxBytes, 1)
  assert.equal(environmentPolicy.policy.maxCount, 0)
  process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT = "invalid"
  await assert.rejects(() => maintainPlaygroundCustomArchiveCache(), /must be a finite number/)
  delete process.env.WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT

  const recoveredVersion = "custom-recovered"
  const recoveredLock = join(root, `${recoveredVersion}.zip.lock`)
  await mkdir(recoveredLock)
  await writeLease(join(recoveredLock, "owner.json"), { token: "expired-producer", expiresAt: Date.now() - 1 })
  let acquiredRecoveredLock = false
  await withPlaygroundArchiveCacheLock(root, recoveredVersion, async () => {
    acquiredRecoveredLock = true
  })
  assert.equal(acquiredRecoveredLock, true, "an expired producer lease must not block future cache users")

  const recoveredTempVersion = "custom-recovered-temp"
  const recoveredTempLock = join(root, `${recoveredTempVersion}.zip.lock`)
  await mkdir(recoveredTempLock)
  await writeFile(join(recoveredTempLock, ".owner.json.crashed.tmp"), "partial")
  await utimes(recoveredTempLock, 1, 1)
  let acquiredRecoveredTempLock = false
  await withPlaygroundArchiveCacheLock(root, recoveredTempVersion, async () => {
    acquiredRecoveredTempLock = true
  })
  assert.equal(acquiredRecoveredTempLock, true, "stale heartbeat temp files from an older generation must not wedge archive acquisition")
  assert.ok((await readdir(root)).includes(stableArchive.split("/").at(-1)!))

  console.log("playground custom archive cache retention passed")
} finally {
  for (const name of environmentNames) {
    const value = originalEnvironment[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(root, { recursive: true, force: true })
}

async function archive(name: string, size: number, mtimeMs: number, content = "x"): Promise<string> {
  const path = join(root, name)
  await writeFile(path, Buffer.alloc(size, content))
  await utimes(path, mtimeMs / 1_000, mtimeMs / 1_000)
  return path
}

async function customArchiveNames(): Promise<string[]> {
  return (await readdir(root)).filter((name) => /^custom-.*\.zip$/.test(name)).sort()
}

async function allocatedBytes(path: string): Promise<number> {
  return (await lstat(path)).blocks * 512
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT") ? false : Promise.reject(error)
  }
}

async function writeLease(path: string, options: { token: string; expiresAt: number; ownerHostname?: string; pid?: number; processStart?: string }): Promise<void> {
  const timestamp = new Date(now).toISOString()
  await writeFile(path, JSON.stringify({
    schema: "wp-codebox/playground-cache-lease/v1",
    token: options.token,
    hostname: options.ownerHostname ?? hostname(),
    bootId: "test-boot",
    pid: options.pid ?? 987_654,
    processStart: options.processStart ?? "test-start",
    createdAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: new Date(options.expiresAt).toISOString(),
  }))
}
