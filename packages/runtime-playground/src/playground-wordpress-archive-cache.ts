import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"

const CUSTOM_ARCHIVE_PATTERN = /^custom-[A-Za-z0-9._-]+\.zip$/
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_COUNT = 20
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1_000

const CACHE_DIRECTORY_ENV = "WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR"
const CACHE_MAX_AGE_MS_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_AGE_MS"
const CACHE_MAX_BYTES_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_BYTES"
const CACHE_MAX_COUNT_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT"
const CACHE_STALE_LOCK_MS_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_STALE_LOCK_MS"

interface CacheOwnerRecord {
  pid: number
  createdAt: string
}

export interface PlaygroundArchiveCacheLock {
  path: string
  waitedMs: number
}

export interface PlaygroundArchiveReference {
  archivePath: string
  path: string
  release(): Promise<void>
}

export interface PlaygroundCustomArchiveCachePolicy {
  maxAgeMs: number
  maxBytes: number
  maxCount: number
  staleLockMs: number
}

export interface PlaygroundCustomArchiveCacheMaintenanceOptions extends Partial<PlaygroundCustomArchiveCachePolicy> {
  mode?: "diagnose" | "dry-run" | "apply"
  now?: number
}

export interface PlaygroundCustomArchiveCacheMaintenance {
  schema: "wp-codebox/playground-custom-archive-cache-maintenance/v1"
  mode: "diagnose" | "dry-run" | "apply"
  cacheDirectory: string
  policy: PlaygroundCustomArchiveCachePolicy
  customArchiveCount: number
  customArchiveBytes: number
  candidateCount: number
  candidateBytes: number
  activeProtection: {
    count: number
    bytes: number
    lockCount: number
    referenceCount: number
    paths: string[]
  }
  removedCount: number
  removedBytes: number
  verifiedReclaimedBytes: number
  retainedCount: number
  retainedBytes: number
}

interface CustomArchiveEntry {
  path: string
  size: number
  mtimeMs: number
  lockPath: string
  activeLock: boolean
  activeReferences: number
}

export async function withPlaygroundArchiveCacheLock<T>(cacheDirectory: string, version: string, callback: (lock: PlaygroundArchiveCacheLock) => Promise<T>, timeoutError?: (lockPath: string) => Error): Promise<T> {
  await mkdir(cacheDirectory, { recursive: true })
  const lockPath = join(cacheDirectory, `${version}.zip.lock`)
  const startedAt = Date.now()

  for (;;) {
    if (await tryAcquireCacheLock(lockPath)) {
      break
    }
    if (!await cacheLockIsActive(lockPath, Date.now(), customArchiveCachePolicy({}).staleLockMs, true)) {
      continue
    }
    if (Date.now() - startedAt > 120_000) {
      throw timeoutError?.(lockPath) ?? new Error(`Timed out waiting for WordPress archive cache lock: ${lockPath}`)
    }
    await delay(100)
  }

  try {
    return await callback({ path: lockPath, waitedMs: Date.now() - startedAt })
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

export async function acquirePlaygroundArchiveReference(archivePath: string): Promise<PlaygroundArchiveReference> {
  const referencesDirectory = `${archivePath}.refs`
  await mkdir(referencesDirectory, { recursive: true })
  const referencePath = join(referencesDirectory, `${process.pid}-${randomUUID()}.json`)
  await writeFile(referencePath, `${JSON.stringify(ownerRecord())}\n`, { flag: "wx" })
  let released = false

  return {
    archivePath,
    path: referencePath,
    async release() {
      if (released) {
        return
      }
      released = true
      await rm(referencePath, { force: true })
    },
  }
}

export function playgroundWordPressArchiveCacheDirectory(): string {
  return process.env[CACHE_DIRECTORY_ENV] || join(homedir(), ".wordpress-playground")
}

export async function maintainPlaygroundCustomArchiveCache(cacheDirectory = playgroundWordPressArchiveCacheDirectory(), options: PlaygroundCustomArchiveCacheMaintenanceOptions = {}): Promise<PlaygroundCustomArchiveCacheMaintenance> {
  const mode = options.mode ?? "apply"
  const now = options.now ?? Date.now()
  const policy = customArchiveCachePolicy(options)
  await mkdir(cacheDirectory, { recursive: true })

  const archiveNames = (await readdir(cacheDirectory)).filter((name) => CUSTOM_ARCHIVE_PATTERN.test(name)).sort()
  const entries: CustomArchiveEntry[] = []
  for (const name of archiveNames) {
    const archivePath = join(cacheDirectory, name)
    try {
      const archiveStat = await stat(archivePath)
      if (!archiveStat.isFile()) {
        continue
      }
      const lockPath = `${archivePath}.lock`
      const activeLock = await cacheLockIsActive(lockPath, now, policy.staleLockMs, mode === "apply")
      const activeReferences = await activeArchiveReferenceCount(archivePath, mode === "apply")
      entries.push({ path: archivePath, size: archiveStat.size, mtimeMs: archiveStat.mtimeMs, lockPath, activeLock, activeReferences })
    } catch (error) {
      if (!errorHasCode(error, "ENOENT")) {
        throw error
      }
    }
  }

  const protectedEntries = entries.filter((entry) => entry.activeLock || entry.activeReferences > 0)
  let retainedCount = protectedEntries.length
  let retainedBytes = protectedEntries.reduce((total, entry) => total + entry.size, 0)
  const candidates: CustomArchiveEntry[] = []
  const eligible = entries.filter((entry) => !entry.activeLock && entry.activeReferences === 0).sort(newestFirst)

  for (const entry of eligible) {
    const stale = now - entry.mtimeMs > policy.maxAgeMs
    const exceedsCount = retainedCount + 1 > policy.maxCount
    const exceedsBytes = retainedBytes + entry.size > policy.maxBytes
    if (stale || exceedsCount || exceedsBytes) {
      candidates.push(entry)
    } else {
      retainedCount += 1
      retainedBytes += entry.size
    }
  }

  let removedCount = 0
  let removedBytes = 0
  let verifiedReclaimedBytes = 0
  if (mode === "apply") {
    for (const candidate of candidates.sort(oldestFirst)) {
      if (!await tryAcquireCacheLock(candidate.lockPath)) {
        continue
      }
      try {
        if (await activeArchiveReferenceCount(candidate.path, true) > 0) {
          continue
        }
        let beforeSize: number
        try {
          beforeSize = (await stat(candidate.path)).size
        } catch (error) {
          if (errorHasCode(error, "ENOENT")) {
            continue
          }
          throw error
        }
        await unlink(candidate.path)
        if (!existsSync(candidate.path)) {
          removedCount += 1
          removedBytes += beforeSize
          verifiedReclaimedBytes += beforeSize
          await rm(`${candidate.path}.refs`, { recursive: true, force: true })
        }
      } finally {
        await rm(candidate.lockPath, { recursive: true, force: true })
      }
    }
  }

  return {
    schema: "wp-codebox/playground-custom-archive-cache-maintenance/v1",
    mode,
    cacheDirectory,
    policy,
    customArchiveCount: entries.length,
    customArchiveBytes: entries.reduce((total, entry) => total + entry.size, 0),
    candidateCount: candidates.length,
    candidateBytes: candidates.reduce((total, entry) => total + entry.size, 0),
    activeProtection: {
      count: protectedEntries.length,
      bytes: protectedEntries.reduce((total, entry) => total + entry.size, 0),
      lockCount: protectedEntries.filter((entry) => entry.activeLock).length,
      referenceCount: protectedEntries.reduce((total, entry) => total + entry.activeReferences, 0),
      paths: protectedEntries.map((entry) => entry.path).sort(),
    },
    removedCount,
    removedBytes,
    verifiedReclaimedBytes,
    retainedCount: entries.length - removedCount,
    retainedBytes: entries.reduce((total, entry) => total + entry.size, 0) - removedBytes,
  }
}

function customArchiveCachePolicy(options: PlaygroundCustomArchiveCacheMaintenanceOptions): PlaygroundCustomArchiveCachePolicy {
  return {
    maxAgeMs: boundedNumber(options.maxAgeMs, CACHE_MAX_AGE_MS_ENV, DEFAULT_MAX_AGE_MS),
    maxBytes: boundedNumber(options.maxBytes, CACHE_MAX_BYTES_ENV, DEFAULT_MAX_BYTES),
    maxCount: boundedNumber(options.maxCount, CACHE_MAX_COUNT_ENV, DEFAULT_MAX_COUNT),
    staleLockMs: boundedNumber(options.staleLockMs, CACHE_STALE_LOCK_MS_ENV, DEFAULT_STALE_LOCK_MS),
  }
}

async function tryAcquireCacheLock(lockPath: string): Promise<boolean> {
  try {
    await mkdir(lockPath)
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(ownerRecord())}\n`)
    return true
  } catch (error) {
    if (errorHasCode(error, "EEXIST")) {
      return false
    }
    await rm(lockPath, { recursive: true, force: true })
    throw error
  }
}

async function cacheLockIsActive(lockPath: string, now: number, staleLockMs: number, removeStale: boolean): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath)
    const owner = await readOwnerRecord(join(lockPath, "owner.json"))
    const active = owner ? processIsAlive(owner.pid) : now - lockStat.mtimeMs <= staleLockMs
    if (!active && removeStale) {
      await rm(lockPath, { recursive: true, force: true })
    }
    return active
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
}

async function activeArchiveReferenceCount(archivePath: string, removeStale: boolean): Promise<number> {
  const referencesDirectory = `${archivePath}.refs`
  let names: string[]
  try {
    names = await readdir(referencesDirectory)
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return 0
    }
    throw error
  }

  let active = 0
  for (const name of names.sort()) {
    const path = join(referencesDirectory, name)
    const owner = await readOwnerRecord(path)
    if (owner && processIsAlive(owner.pid)) {
      active += 1
    } else if (removeStale) {
      await rm(path, { recursive: true, force: true })
    }
  }
  return active
}

async function readOwnerRecord(path: string): Promise<CacheOwnerRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<CacheOwnerRecord>
    return Number.isInteger(value.pid) && typeof value.createdAt === "string" ? value as CacheOwnerRecord : undefined
  } catch (error) {
    if (errorHasCode(error, "ENOENT") || errorHasCode(error, "EISDIR") || error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}

function ownerRecord(): CacheOwnerRecord {
  return { pid: process.pid, createdAt: new Date().toISOString() }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorHasCode(error, "EPERM")
  }
}

function boundedNumber(explicit: number | undefined, environmentName: string, fallback: number): number {
  const candidate = explicit ?? (process.env[environmentName] === undefined ? fallback : Number(process.env[environmentName]))
  if (!Number.isFinite(candidate) || candidate < 0) {
    throw new Error(`${environmentName} must be a non-negative finite number`)
  }
  return Math.floor(candidate)
}

function newestFirst(left: CustomArchiveEntry, right: CustomArchiveEntry): number {
  return right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)
}

function oldestFirst(left: CustomArchiveEntry, right: CustomArchiveEntry): number {
  return left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path)
}

function errorHasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code)
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

export function isCustomPlaygroundWordPressArchive(archivePath: string): boolean {
  return CUSTOM_ARCHIVE_PATTERN.test(basename(archivePath))
}
