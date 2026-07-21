import { randomUUID } from "node:crypto"
import { hostname, homedir } from "node:os"
import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

const CUSTOM_ARCHIVE_PATTERN = /^custom-[A-Za-z0-9._-]+\.zip$/
const CUSTOM_SIDECAR_PATTERN = /^(custom-[A-Za-z0-9._-]+\.zip)\.(lock|refs)$/
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_COUNT = 20
const DEFAULT_LEASE_MS = 120_000
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1_000

const CACHE_DIRECTORY_ENV = "WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR"
const CACHE_MAX_AGE_MS_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_AGE_MS"
const CACHE_MAX_BYTES_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_BYTES"
const CACHE_MAX_COUNT_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_MAX_COUNT"
const CACHE_LEASE_MS_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_LEASE_MS"
const CACHE_STALE_LOCK_MS_ENV = "WP_CODEBOX_PLAYGROUND_CUSTOM_ARCHIVE_STALE_LOCK_MS"

interface CacheOwnerRecord {
  schema: "wp-codebox/playground-cache-lease/v1"
  token: string
  hostname: string
  bootId: string
  pid: number
  processStart: string
  createdAt: string
  heartbeatAt: string
  expiresAt: string
}

interface LeaseHandle {
  token: string
  release(): Promise<void>
}

interface LeaseState {
  active: boolean
  token?: string
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
  leaseMs: number
  staleLockMs: number
}

export interface PlaygroundCustomArchiveCacheMaintenanceOptions extends Partial<PlaygroundCustomArchiveCachePolicy> {
  mode?: "diagnose" | "dry-run" | "apply"
  now?: number
}

export interface PlaygroundCustomArchiveCacheDiagnostic {
  code: string
  message: string
  severity: "warning" | "error"
  path?: string
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
    filesystemCount: number
    paths: string[]
  }
  sidecars: {
    orphanCount: number
    activeCount: number
    removedCount: number
    paths: string[]
  }
  removedCount: number
  removedBytes: number
  verifiedReclaimedBytes: number
  retainedCount: number
  retainedBytes: number
  diagnostics: PlaygroundCustomArchiveCacheDiagnostic[]
}

interface CustomArchiveEntry {
  path: string
  size: number
  mtimeMs: number
  lockPath: string
  activeLock: boolean
  activeReferences: number
  filesystemProtected: boolean
}

const processIdentityPromise = processIdentity()

export async function withPlaygroundArchiveCacheLock<T>(cacheDirectory: string, version: string, callback: (lock: PlaygroundArchiveCacheLock) => Promise<T>, timeoutError?: (lockPath: string) => Error): Promise<T> {
  await mkdir(cacheDirectory, { recursive: true })
  const lockPath = join(cacheDirectory, `${version}.zip.lock`)
  const startedAt = Date.now()
  const policy = cacheLeasePolicy()
  let lease: LeaseHandle | undefined

  for (;;) {
    lease = await tryAcquireCacheLock(lockPath, policy.leaseMs)
    if (lease) {
      break
    }
    if (!await cacheLockIsActive(lockPath, Date.now(), policy, true)) {
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
    await lease.release()
  }
}

export async function acquirePlaygroundArchiveReference(archivePath: string): Promise<PlaygroundArchiveReference> {
  const policy = cacheLeasePolicy()
  const referencesDirectory = `${archivePath}.refs`
  await mkdir(referencesDirectory, { recursive: true })
  const token = randomUUID()
  const referencePath = join(referencesDirectory, `${token}.json`)
  const lease = await createFileLease(referencePath, token, policy.leaseMs)

  return {
    archivePath,
    path: referencePath,
    release: lease.release,
  }
}

export function playgroundWordPressArchiveCacheDirectory(): string {
  return process.env[CACHE_DIRECTORY_ENV] || join(homedir(), ".wordpress-playground")
}

export async function maintainPlaygroundCustomArchiveCache(cacheDirectory = playgroundWordPressArchiveCacheDirectory(), options: PlaygroundCustomArchiveCacheMaintenanceOptions = {}): Promise<PlaygroundCustomArchiveCacheMaintenance> {
  const mode = options.mode ?? "apply"
  const now = options.now ?? Date.now()
  const policy = customArchiveCachePolicy(options)
  const diagnostics: PlaygroundCustomArchiveCacheDiagnostic[] = []
  await mkdir(cacheDirectory, { recursive: true })

  const directoryEntries = await readdir(cacheDirectory, { withFileTypes: true })
  const archiveNames = directoryEntries.map((entry) => entry.name).filter((name) => CUSTOM_ARCHIVE_PATTERN.test(name)).sort()
  const entries: CustomArchiveEntry[] = []
  for (const name of archiveNames) {
    const archivePath = join(cacheDirectory, name)
    try {
      const archiveStat = await lstat(archivePath)
      const regular = archiveStat.isFile()
      const singlyLinked = archiveStat.nlink === 1
      const filesystemProtected = !regular || !singlyLinked
      if (filesystemProtected) {
        diagnostics.push({
          code: regular ? "custom-archive-multiply-linked" : "custom-archive-not-regular",
          message: regular ? "Custom archive has multiple hard links and was protected from retention." : "Custom archive is not a regular file and was protected from retention.",
          severity: "warning",
          path: archivePath,
        })
      }
      const lockPath = `${archivePath}.lock`
      const activeLock = await cacheLockIsActive(lockPath, now, policy, mode === "apply")
      const activeReferences = await activeArchiveReferenceCount(archivePath, now, policy, mode === "apply")
      entries.push({
        path: archivePath,
        size: regular ? archiveStat.size : 0,
        mtimeMs: archiveStat.mtimeMs,
        lockPath,
        activeLock,
        activeReferences,
        filesystemProtected,
      })
    } catch (error) {
      if (!errorHasCode(error, "ENOENT")) {
        throw error
      }
    }
  }

  const protectedEntries = entries.filter((entry) => entry.activeLock || entry.activeReferences > 0 || entry.filesystemProtected)
  let retainedCountForBounds = protectedEntries.length
  let retainedBytesForBounds = protectedEntries.reduce((total, entry) => total + entry.size, 0)
  const candidates: CustomArchiveEntry[] = []
  const eligible = entries.filter((entry) => !protectedEntries.includes(entry)).sort(newestFirst)
  for (const entry of eligible) {
    const stale = now - entry.mtimeMs > policy.maxAgeMs
    const exceedsCount = retainedCountForBounds + 1 > policy.maxCount
    const exceedsBytes = retainedBytesForBounds + entry.size > policy.maxBytes
    if (stale || exceedsCount || exceedsBytes) {
      candidates.push(entry)
    } else {
      retainedCountForBounds += 1
      retainedBytesForBounds += entry.size
    }
  }

  let removedCount = 0
  let removedBytes = 0
  let verifiedReclaimedBytes = 0
  if (mode === "apply") {
    for (const candidate of candidates.sort(oldestFirst)) {
      const lease = await tryAcquireCacheLock(candidate.lockPath, policy.leaseMs)
      if (!lease) {
        continue
      }
      try {
        if (await activeArchiveReferenceCount(candidate.path, Date.now(), policy, true) > 0) {
          continue
        }
        let current
        try {
          current = await lstat(candidate.path)
        } catch (error) {
          if (errorHasCode(error, "ENOENT")) {
            continue
          }
          throw error
        }
        if (!current.isFile() || current.nlink !== 1) {
          diagnostics.push({ code: "custom-archive-changed-before-removal", message: "Custom archive changed to an unsafe filesystem entry before removal and was protected.", severity: "warning", path: candidate.path })
          continue
        }
        const currentAllocatedBytes = allocatedBytes(current.blocks)
        await unlink(candidate.path)
        try {
          await lstat(candidate.path)
          diagnostics.push({ code: "custom-archive-removal-unverified", message: "Custom archive path still exists after unlink and reclaimed bytes could not be verified.", severity: "warning", path: candidate.path })
        } catch (error) {
          if (!errorHasCode(error, "ENOENT")) {
            throw error
          }
          removedCount += 1
          removedBytes += current.size
          verifiedReclaimedBytes += currentAllocatedBytes
          await removeOrphanReferencesDirectory(`${candidate.path}.refs`, Date.now(), policy, diagnostics)
        }
      } finally {
        await lease.release()
      }
    }
  }

  const sidecars = await maintainOrphanSidecars(cacheDirectory, directoryEntries.map((entry) => entry.name), now, policy, mode, diagnostics)
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0)
  return {
    schema: "wp-codebox/playground-custom-archive-cache-maintenance/v1",
    mode,
    cacheDirectory,
    policy,
    customArchiveCount: entries.length,
    customArchiveBytes: totalBytes,
    candidateCount: candidates.length,
    candidateBytes: candidates.reduce((total, entry) => total + entry.size, 0),
    activeProtection: {
      count: protectedEntries.length,
      bytes: protectedEntries.reduce((total, entry) => total + entry.size, 0),
      lockCount: protectedEntries.filter((entry) => entry.activeLock).length,
      referenceCount: protectedEntries.reduce((total, entry) => total + entry.activeReferences, 0),
      filesystemCount: protectedEntries.filter((entry) => entry.filesystemProtected).length,
      paths: protectedEntries.map((entry) => entry.path).sort(),
    },
    sidecars,
    removedCount,
    removedBytes,
    verifiedReclaimedBytes,
    retainedCount: entries.length - removedCount,
    retainedBytes: totalBytes - removedBytes,
    diagnostics,
  }
}

function customArchiveCachePolicy(options: PlaygroundCustomArchiveCacheMaintenanceOptions): PlaygroundCustomArchiveCachePolicy {
  return {
    maxAgeMs: boundedNumber(options.maxAgeMs, CACHE_MAX_AGE_MS_ENV, DEFAULT_MAX_AGE_MS),
    maxBytes: boundedNumber(options.maxBytes, CACHE_MAX_BYTES_ENV, DEFAULT_MAX_BYTES),
    maxCount: boundedNumber(options.maxCount, CACHE_MAX_COUNT_ENV, DEFAULT_MAX_COUNT),
    leaseMs: boundedNumber(options.leaseMs, CACHE_LEASE_MS_ENV, DEFAULT_LEASE_MS, 100),
    staleLockMs: boundedNumber(options.staleLockMs, CACHE_STALE_LOCK_MS_ENV, DEFAULT_STALE_LOCK_MS),
  }
}

function cacheLeasePolicy(): Pick<PlaygroundCustomArchiveCachePolicy, "leaseMs" | "staleLockMs"> {
  return {
    leaseMs: boundedNumber(undefined, CACHE_LEASE_MS_ENV, DEFAULT_LEASE_MS, 100),
    staleLockMs: boundedNumber(undefined, CACHE_STALE_LOCK_MS_ENV, DEFAULT_STALE_LOCK_MS),
  }
}

async function tryAcquireCacheLock(lockPath: string, leaseMs: number): Promise<LeaseHandle | undefined> {
  const token = randomUUID()
  try {
    await mkdir(lockPath)
  } catch (error) {
    if (errorHasCode(error, "EEXIST")) {
      return undefined
    }
    throw error
  }
  try {
    return await createDirectoryLease(lockPath, token, leaseMs)
  } catch (error) {
    await quarantineDirectory(lockPath)
    throw error
  }
}

async function createDirectoryLease(lockPath: string, token: string, leaseMs: number): Promise<LeaseHandle> {
  const ownerPath = join(lockPath, "owner.json")
  await writeLease(ownerPath, await ownerRecord(token, leaseMs))
  return heartbeatLease(ownerPath, token, leaseMs, async () => {
    await quarantineDirectoryIfOwned(lockPath, token)
  })
}

async function createFileLease(path: string, token: string, leaseMs: number): Promise<LeaseHandle> {
  await writeLease(path, await ownerRecord(token, leaseMs), true)
  return heartbeatLease(path, token, leaseMs, async () => {
    const owner = await readOwnerRecord(path)
    if (owner?.token === token) {
      await rm(path, { force: true })
    }
  })
}

function heartbeatLease(path: string, token: string, leaseMs: number, removeOwned: () => Promise<void>): LeaseHandle {
  let stopped = false
  let heartbeat: Promise<void> | undefined
  const interval = setInterval(() => {
    if (stopped || heartbeat) {
      return
    }
    heartbeat = refreshLease(path, token, leaseMs).catch(() => undefined).finally(() => {
      heartbeat = undefined
    })
  }, Math.max(50, Math.floor(leaseMs / 3)))
  interval.unref()

  return {
    token,
    async release() {
      stopped = true
      clearInterval(interval)
      await heartbeat?.catch(() => undefined)
      await removeOwned()
    },
  }
}

async function refreshLease(path: string, token: string, leaseMs: number): Promise<void> {
  const owner = await readOwnerRecord(path)
  if (owner?.token !== token) {
    return
  }
  const now = new Date()
  await writeLease(path, { ...owner, heartbeatAt: now.toISOString(), expiresAt: new Date(now.getTime() + leaseMs).toISOString() })
}

async function cacheLockIsActive(lockPath: string, now: number, policy: Pick<PlaygroundCustomArchiveCachePolicy, "staleLockMs">, removeStale: boolean): Promise<boolean> {
  const state = await leaseState(join(lockPath, "owner.json"), lockPath, now, policy.staleLockMs)
  if (!state.active && removeStale) {
    if (state.token) {
      await quarantineDirectoryIfOwned(lockPath, state.token)
    } else {
      await quarantineLegacyDirectoryIfStale(lockPath, now, policy.staleLockMs)
    }
  }
  return state.active
}

async function activeArchiveReferenceCount(archivePath: string, now: number, policy: Pick<PlaygroundCustomArchiveCachePolicy, "staleLockMs">, removeStale: boolean): Promise<number> {
  const referencesDirectory = `${archivePath}.refs`
  let names: string[]
  try {
    names = await readdir(referencesDirectory)
  } catch (error) {
    if (errorHasCode(error, "ENOENT") || errorHasCode(error, "ENOTDIR")) {
      return 0
    }
    throw error
  }
  let active = 0
  for (const name of names.sort()) {
    const path = join(referencesDirectory, name)
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      if (removeStale) {
        await rm(path, { force: true })
      }
      continue
    }
    const state = await leaseState(path, path, now, policy.staleLockMs)
    if (state.active) {
      active += 1
    } else if (removeStale) {
      const current = await readOwnerRecord(path)
      if (!state.token || current?.token === state.token) {
        await rm(path, { recursive: true, force: true })
      }
    }
  }
  return active
}

async function leaseState(ownerPath: string, sidecarPath: string, now: number, legacyStaleMs: number): Promise<LeaseState> {
  const owner = await readOwnerRecord(ownerPath)
  if (owner) {
    const expiresAt = Date.parse(owner.expiresAt)
    return { active: Number.isFinite(expiresAt) && expiresAt > now, token: owner.token }
  }
  try {
    const sidecarStat = await lstat(sidecarPath)
    return { active: now - sidecarStat.mtimeMs <= legacyStaleMs }
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return { active: false }
    }
    throw error
  }
}

async function maintainOrphanSidecars(cacheDirectory: string, names: string[], now: number, policy: PlaygroundCustomArchiveCachePolicy, mode: PlaygroundCustomArchiveCacheMaintenance["mode"], diagnostics: PlaygroundCustomArchiveCacheDiagnostic[]): Promise<PlaygroundCustomArchiveCacheMaintenance["sidecars"]> {
  const paths: string[] = []
  let activeCount = 0
  let removedCount = 0
  for (const name of names.sort()) {
    const match = CUSTOM_SIDECAR_PATTERN.exec(name)
    if (!match || names.includes(match[1])) {
      continue
    }
    const path = join(cacheDirectory, name)
    paths.push(path)
    if (match[2] === "lock") {
      const active = await cacheLockIsActive(path, now, policy, mode === "apply")
      if (active) {
        activeCount += 1
      } else if (mode === "apply" && !await pathExists(path)) {
        removedCount += 1
      }
      continue
    }
    const active = await activeReferenceCountInDirectory(path, now, policy, mode === "apply")
    if (active > 0) {
      activeCount += 1
    } else if (mode === "apply" && await removeOrphanReferencesDirectory(path, now, policy, diagnostics)) {
      removedCount += 1
    }
  }
  return { orphanCount: paths.length, activeCount, removedCount, paths }
}

async function activeReferenceCountInDirectory(path: string, now: number, policy: Pick<PlaygroundCustomArchiveCachePolicy, "staleLockMs">, removeStale: boolean): Promise<number> {
  return activeArchiveReferenceCount(path.slice(0, -".refs".length), now, policy, removeStale)
}

async function removeOrphanReferencesDirectory(path: string, now: number, policy: Pick<PlaygroundCustomArchiveCachePolicy, "staleLockMs">, diagnostics: PlaygroundCustomArchiveCacheDiagnostic[]): Promise<boolean> {
  if (await activeReferenceCountInDirectory(path, now, policy, true) > 0) {
    return false
  }
  try {
    const quarantined = `${path}.cleanup-${randomUUID()}`
    await rename(path, quarantined)
    await rm(quarantined, { recursive: true, force: true })
    return true
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return false
    }
    diagnostics.push({ code: "orphan-reference-cleanup-failed", message: errorMessage(error), severity: "warning", path })
    return false
  }
}

async function quarantineDirectoryIfOwned(path: string, token: string): Promise<boolean> {
  if ((await readOwnerRecord(join(path, "owner.json")))?.token !== token) {
    return false
  }
  return quarantineDirectory(path)
}

async function quarantineLegacyDirectoryIfStale(path: string, now: number, staleMs: number): Promise<boolean> {
  try {
    if (now - (await lstat(path)).mtimeMs <= staleMs || await readOwnerRecord(join(path, "owner.json"))) {
      return false
    }
    return quarantineDirectory(path)
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
}

async function quarantineDirectory(path: string): Promise<boolean> {
  const quarantined = `${path}.cleanup-${randomUUID()}`
  try {
    await rename(path, quarantined)
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
  await rm(quarantined, { recursive: true, force: true })
  return true
}

async function writeLease(path: string, owner: CacheOwnerRecord, exclusive = false): Promise<void> {
  if (exclusive) {
    await writeFile(path, `${JSON.stringify(owner)}\n`, { flag: "wx" })
    return
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${owner.token}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(owner)}\n`)
  try {
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function readOwnerRecord(path: string): Promise<CacheOwnerRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<CacheOwnerRecord>
    return value.schema === "wp-codebox/playground-cache-lease/v1"
      && typeof value.token === "string"
      && typeof value.hostname === "string"
      && typeof value.bootId === "string"
      && Number.isInteger(value.pid)
      && typeof value.processStart === "string"
      && typeof value.createdAt === "string"
      && typeof value.heartbeatAt === "string"
      && typeof value.expiresAt === "string"
      ? value as CacheOwnerRecord
      : undefined
  } catch (error) {
    if (errorHasCode(error, "ENOENT") || errorHasCode(error, "EISDIR") || error instanceof SyntaxError) {
      return undefined
    }
    throw error
  }
}

async function ownerRecord(token: string, leaseMs: number): Promise<CacheOwnerRecord> {
  const identity = await processIdentityPromise
  const now = new Date()
  return {
    schema: "wp-codebox/playground-cache-lease/v1",
    token,
    ...identity,
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  }
}

async function processIdentity(): Promise<Pick<CacheOwnerRecord, "hostname" | "bootId" | "pid" | "processStart">> {
  const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").then((value) => value.trim()).catch(() => "unavailable")
  const processStart = await readFile(`/proc/${process.pid}/stat`, "utf8").then((value) => value.trim().split(/\s+/)[21] ?? "unavailable").catch(() => String(process.uptime()))
  return { hostname: hostname(), bootId, pid: process.pid, processStart }
}

function boundedNumber(explicit: number | undefined, environmentName: string, fallback: number, minimum = 0): number {
  const candidate = explicit ?? (process.env[environmentName] === undefined ? fallback : Number(process.env[environmentName]))
  if (!Number.isFinite(candidate) || candidate < minimum) {
    throw new Error(`${environmentName} must be a finite number greater than or equal to ${minimum}`)
  }
  return Math.floor(candidate)
}

function allocatedBytes(blocks: number): number {
  return Math.max(0, blocks) * 512
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return false
    }
    throw error
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

export function isCustomPlaygroundWordPressArchive(archivePath: string): boolean {
  return CUSTOM_ARCHIVE_PATTERN.test(basename(archivePath))
}
