import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { lstat, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { maintainPlaygroundCustomArchiveCache } from "../packages/runtime-playground/src/playground-wordpress-archive-cache.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-playground-cache-process-"))
const fixture = join(process.cwd(), "tests/fixtures/playground-cache-lease-child.ts")
const tsx = join(process.cwd(), "node_modules/.bin/tsx")
const children: ChildProcess[] = []

try {
  const archivePath = join(root, "custom-shared-process.zip")
  await writeFile(archivePath, Buffer.alloc(8_192, "p"))
  await utimes(archivePath, 1, 1)

  const first = await startChild("first", archivePath)
  const second = await startChild("second", archivePath)
  const shared = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", maxAgeMs: 1 })
  assert.equal(shared.activeProtection.referenceCount, 2)
  assert.ok(await exists(archivePath), "two separate processes must share archive protection")

  await stopChild(first)
  const oneRemaining = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", maxAgeMs: 1 })
  assert.equal(oneRemaining.activeProtection.referenceCount, 1)
  assert.ok(await exists(archivePath), "one remaining process must keep the archive protected")

  killChildGroup(second.child)
  await childExit(second.child)
  const immediatelyAfterCrash = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", maxAgeMs: 1 })
  assert.equal(immediatelyAfterCrash.activeProtection.referenceCount, 1, "a crashed process remains protected until its bounded lease expires")
  assert.ok(await exists(archivePath), "archive must remain while crashed-process lease is unexpired")
  await waitForReferenceExpiry(`${archivePath}.refs`)
  const afterExpiry = await maintainPlaygroundCustomArchiveCache(root, { mode: "apply", maxAgeMs: 1 })
  assert.ok(afterExpiry.removedCount >= 1, JSON.stringify(afterExpiry))
  assert.ok(!await exists(archivePath), "expired crashed-process lease must become reclaimable")

  console.log("playground custom archive separate-process leases passed")
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) killChildGroup(child)
  }
  await rm(root, { recursive: true, force: true })
}

async function startChild(name: string, archivePath: string): Promise<{ child: ChildProcess; stopPath: string }> {
  const readyPath = join(root, `${name}.ready`)
  const stopPath = join(root, `${name}.stop`)
  const child = spawn(tsx, [fixture, archivePath, readyPath, stopPath], {
    env: { ...process.env, WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_LEASE_MS: "300" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  children.push(child)
  await waitForPath(readyPath, child)
  const referencePath = await readFile(readyPath, "utf8")
  const owner = JSON.parse(await readFile(referencePath, "utf8")) as { heartbeatAt: string; expiresAt: string }
  assert.ok(Date.parse(owner.expiresAt) - Date.parse(owner.heartbeatAt) <= 350, "child must use the configured short lease")
  return { child, stopPath }
}

async function stopChild(entry: { child: ChildProcess; stopPath: string }): Promise<void> {
  await writeFile(entry.stopPath, "stop")
  await childExit(entry.child)
}

async function waitForPath(path: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await exists(path)) return
    if (child.exitCode !== null) throw new Error(`lease child exited early with ${child.exitCode}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for lease child: ${path}`)
}

async function childExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve())
    child.once("error", reject)
  })
}

function killChildGroup(child: ChildProcess): void {
  if (child.pid) {
    process.kill(-child.pid, "SIGKILL")
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function referenceRecords(path: string): Promise<unknown[]> {
  if (!await exists(path)) return []
  return Promise.all((await readdir(path)).map(async (name) => JSON.parse(await readFile(join(path, name), "utf8"))))
}

async function waitForReferenceExpiry(path: string): Promise<void> {
  const records = await referenceRecords(path) as Array<{ expiresAt?: string }>
  const latestExpiry = Math.max(Date.now(), ...records.map((record) => Date.parse(record.expiresAt ?? ""))).valueOf()
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, latestExpiry - Date.now()) + 100))
}
