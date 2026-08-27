import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { withPlaygroundArchiveCacheLock } from "../packages/runtime-playground/src/playground-wordpress-archive-cache.js"

async function cacheRootWithLock(version: string, lease: Record<string, unknown> | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-archive-cache-lease-"))
  const lockPath = join(root, `${version}.zip.lock`)
  await mkdir(lockPath, { recursive: true })
  if (lease) {
    await writeFile(join(lockPath, `${lease.token as string}.lease.json`), `${JSON.stringify(lease)}\n`)
  }
  return root
}

function leaseRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "wp-codebox/playground-cache-lease/v1",
    token: "11111111-2222-3333-4444-555555555555",
    hostname: "orphan.test",
    bootId: "unavailable",
    pid: 999_999,
    processStart: "1.0",
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  }
}

test("a released lease left behind by a dead owner is reclaimed immediately", async () => {
  // `expireLease` stamps the epoch on release. A process that dies before it can
  // remove the directory leaves exactly this shape behind.
  const root = await cacheRootWithLock("readonly-mount-cache", leaseRecord({ expiresAt: new Date(0).toISOString() }))
  const startedAt = Date.now()
  const waited = await withPlaygroundArchiveCacheLock(root, "readonly-mount-cache", async (lock) => lock.waitedMs)

  assert.ok(Date.now() - startedAt < 10_000, `reclaiming an orphaned lease must not wait for the acquisition timeout, waited ${waited}ms`)
})

test("a lock directory holding no lease at all is reclaimed rather than blocking", async () => {
  const root = await cacheRootWithLock("readonly-mount-cache", undefined)
  const startedAt = Date.now()
  await withPlaygroundArchiveCacheLock(root, "readonly-mount-cache", async () => undefined)

  assert.ok(Date.now() - startedAt < 10_000, "an empty lock directory must not block acquisition")
})

test("a live lease is preserved and the lock is released cleanly afterwards", async () => {
  const root = await cacheRootWithLock(
    "readonly-mount-cache",
    leaseRecord({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  )
  const lockPath = join(root, "readonly-mount-cache.zip.lock")
  const before = await readdir(lockPath)
  assert.equal(before.length, 1, "the live lease must still be present before acquisition is attempted")
})
