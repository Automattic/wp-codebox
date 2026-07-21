import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { hostname, homedir } from "node:os"
import { lstat, mkdir, open, readFile, readdir, rmdir, statfs, unlink, type FileHandle } from "node:fs/promises"
import { basename, join } from "node:path"

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
  renew(): Promise<void>
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
  renew(): Promise<void>
  release(): Promise<void>
}

export interface PlaygroundArchiveReferenceOptions {
  leaseMs?: number
  heartbeat?: boolean
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
  candidateInterlock?: (archivePath: string) => void | Promise<void>
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
  estimatedAllocatedBytesRemoved: number
  observedFilesystemFreeBytesDelta: number
  retainedCount: number
  retainedBytes: number
  diagnostics: PlaygroundCustomArchiveCacheDiagnostic[]
}

interface CustomArchiveEntry {
  path: string
  size: number
  mtimeMs: number
  dev: number
  ino: number
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

export async function acquirePlaygroundArchiveReference(archivePath: string, options: PlaygroundArchiveReferenceOptions = {}): Promise<PlaygroundArchiveReference> {
  const policy = cacheLeasePolicy()
  const leaseMs = options.leaseMs ?? policy.leaseMs
  const referencesDirectory = `${archivePath}.refs`
  const directoryHandle = await openSafeLeaseDirectory(referencesDirectory, true)
  const token = randomUUID()
  const fileName = `${token}.json`
  const referencePath = join(referencesDirectory, fileName)
  let lease: LeaseHandle
  try {
    lease = await createFileLease(directoryHandle, fileName, referencePath, token, leaseMs, referencesDirectory, options.heartbeat !== false)
  } catch (error) {
    await directoryHandle.close()
    throw error
  }

  return {
    archivePath,
    path: referencePath,
    renew: lease.renew,
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
      const activeReferences = await activeArchiveReferenceCount(archivePath, now, policy, mode === "apply", diagnostics)
      entries.push({
        path: archivePath,
        size: regular ? archiveStat.size : 0,
        mtimeMs: archiveStat.mtimeMs,
        dev: archiveStat.dev,
        ino: archiveStat.ino,
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
  let estimatedAllocatedBytesRemoved = 0
  const filesystemBefore = mode === "apply" ? await filesystemAvailableBytes(cacheDirectory) : undefined
  if (mode === "apply") {
    for (const candidate of candidates.sort(oldestFirst)) {
      await options.candidateInterlock?.(candidate.path)
      const lease = await tryAcquireCacheLock(candidate.lockPath, policy.leaseMs)
      if (!lease) {
        continue
      }
      try {
        if (await activeArchiveReferenceCount(candidate.path, Date.now(), policy, true, diagnostics) > 0) {
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
        if (current.dev !== candidate.dev || current.ino !== candidate.ino || current.mtimeMs !== candidate.mtimeMs || current.size !== candidate.size) {
          diagnostics.push({ code: "custom-archive-generation-changed", message: "Custom archive was replaced or modified after candidate selection and was protected from removal.", severity: "warning", path: candidate.path })
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
          estimatedAllocatedBytesRemoved += currentAllocatedBytes
          await removeOrphanReferencesDirectory(`${candidate.path}.refs`, Date.now(), policy, diagnostics)
        }
      } finally {
        await lease.release()
      }
    }
  }

  const sidecars = await maintainOrphanSidecars(cacheDirectory, directoryEntries.map((entry) => entry.name), now, policy, mode, diagnostics)
  const filesystemAfter = mode === "apply" ? await filesystemAvailableBytes(cacheDirectory) : undefined
  const observedFilesystemFreeBytesDelta = filesystemBefore === undefined || filesystemAfter === undefined ? 0 : filesystemAfter - filesystemBefore
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
    estimatedAllocatedBytesRemoved,
    observedFilesystemFreeBytesDelta,
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
  let directoryHandle: FileHandle | undefined
  try {
    directoryHandle = await openSafeLeaseDirectory(lockPath, false)
    return await createDirectoryLease(directoryHandle, lockPath, token, leaseMs)
  } catch (error) {
    await directoryHandle?.close().catch(() => undefined)
    await rmdir(lockPath).catch(() => undefined)
    throw error
  }
}

async function createDirectoryLease(directoryHandle: FileHandle, lockPath: string, token: string, leaseMs: number): Promise<LeaseHandle> {
  const fileName = `${token}.lease.json`
  return createFileLease(directoryHandle, fileName, join(lockPath, fileName), token, leaseMs, lockPath, true)
}

async function createFileLease(directoryHandle: FileHandle, fileName: string, displayPath: string, token: string, leaseMs: number, directoryPath: string, automaticHeartbeat: boolean): Promise<LeaseHandle> {
  const anchoredPath = join(fileDescriptorPath(directoryHandle), fileName)
  const fileHandle = await open(anchoredPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  await writeOwnerToHandle(fileHandle, await ownerRecord(token, leaseMs))
  return heartbeatLease(fileHandle, token, leaseMs, async () => {
    await unlink(anchoredPath).catch((error) => {
      if (!errorHasCode(error, "ENOENT")) throw error
    })
    await fileHandle.close()
    await directoryHandle.close()
    await rmdir(directoryPath).catch((error) => {
      if (!errorHasCode(error, "ENOENT") && !errorHasCode(error, "ENOTEMPTY")) throw error
    })
  }, displayPath, automaticHeartbeat)
}

function heartbeatLease(fileHandle: FileHandle, token: string, leaseMs: number, removeOwned: () => Promise<void>, displayPath: string, automaticHeartbeat: boolean): LeaseHandle {
  let stopped = false
  let heartbeat: Promise<void> | undefined
  const renew = async () => refreshLease(fileHandle, token, leaseMs)
  const interval = automaticHeartbeat ? setInterval(() => {
    if (stopped || heartbeat) {
      return
    }
    heartbeat = refreshLease(fileHandle, token, leaseMs).catch((error) => {
      console.warn(`[wp-codebox] playground-cache-lease-refresh-failed: ${displayPath}: ${errorMessage(error)}`)
    }).finally(() => {
      heartbeat = undefined
    })
  }, Math.max(50, Math.floor(leaseMs / 3))) : undefined
  interval?.unref()

  return {
    token,
    renew,
    async release() {
      stopped = true
      if (interval) clearInterval(interval)
      await heartbeat?.catch(() => undefined)
      await removeOwned()
    },
  }
}

async function refreshLease(fileHandle: FileHandle, token: string, leaseMs: number): Promise<void> {
  const owner = await readOwnerFromHandle(fileHandle)
  if (owner?.token !== token) {
    return
  }
  const now = new Date()
  await writeOwnerToHandle(fileHandle, { ...owner, heartbeatAt: now.toISOString(), expiresAt: new Date(now.getTime() + leaseMs).toISOString() })
}

async function cacheLockIsActive(lockPath: string, now: number, policy: Pick<PlaygroundCustomArchiveCachePolicy, "staleLockMs">, removeStale: boolean): Promise<boolean> {
  let lockStat
  try {
    lockStat = await lstat(lockPath)
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return false
    throw error
  }
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return true
  const directoryHandle = await openSafeLeaseDirectory(lockPath, false)
  let active = false
  try {
    const anchoredDirectory = fileDescriptorPath(directoryHandle)
    const names = await readdir(anchoredDirectory)
    for (const name of names.sort()) {
      const path = join(anchoredDirectory, name)
      if (name !== "owner.json" && !name.endsWith(".lease.json")) {
        const unknownStat = await lstat(path)
        if (unknownStat.isDirectory() || now - lockStat.mtimeMs <= policy.staleLockMs || !removeStale) {
          active = true
        } else {
          await unlink(path)
        }
        continue
      }
      const state = await inspectLeaseFile(path, now, policy.staleLockMs, removeStale)
      if (state.active) {
        active = true
      } else if (removeStale) {
        await unlink(path).catch((error) => {
          if (!errorHasCode(error, "ENOENT")) throw error
        })
      }
    }
    if (names.length === 0 && now - lockStat.mtimeMs <= policy.staleLockMs) active = true
  } finally {
    await directoryHandle.close()
    if (removeStale && !active) {
      await rmdir(lockPath).catch((error) => {
        if (!errorHasCode(error, "ENOENT") && !errorHasCode(error, "ENOTEMPTY")) throw error
      })
    }
  }
  return active
}

async function activeArchiveReferenceCount(archivePath: string, now: number, policy: Pick<PlaygroundCustomArchiveCachePolicy, "staleLockMs">, removeStale: boolean, diagnostics: PlaygroundCustomArchiveCacheDiagnostic[] = []): Promise<number> {
  const referencesDirectory = `${archivePath}.refs`
  let referencesStat
  try {
    referencesStat = await lstat(referencesDirectory)
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return 0
    throw error
  }
  if (!referencesStat.isDirectory() || referencesStat.isSymbolicLink()) {
    diagnostics.push({ code: "custom-archive-refs-not-directory", message: "Archive reference sidecar is not a real directory and was not followed.", severity: "warning", path: referencesDirectory })
    if (removeStale) await unlink(referencesDirectory)
    return removeStale ? 0 : 1
  }
  const directoryHandle = await openSafeLeaseDirectory(referencesDirectory, false)
  const anchoredDirectory = fileDescriptorPath(directoryHandle)
  const names = await readdir(anchoredDirectory)
  let active = 0
  try {
    for (const name of names.sort()) {
      const path = join(anchoredDirectory, name)
      const state = await inspectLeaseFile(path, now, policy.staleLockMs, removeStale, diagnostics)
      if (state.active) {
        active += 1
      }
    }
  } finally {
    await directoryHandle.close()
  }
  return active
}

async function inspectLeaseFile(path: string, now: number, legacyStaleMs: number, removeUnsafe: boolean, diagnostics: PlaygroundCustomArchiveCacheDiagnostic[] = []): Promise<LeaseState> {
  let pathStat
  try {
    pathStat = await lstat(path)
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return { active: false }
    throw error
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1) {
    diagnostics.push({ code: "custom-archive-ref-entry-unsafe", message: "Archive lease entry is not a singly-linked regular file and was not followed.", severity: "warning", path })
    if (removeUnsafe && !pathStat.isDirectory()) await unlink(path)
    return { active: !removeUnsafe || pathStat.isDirectory() }
  }

  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedStat = await handle.stat()
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      diagnostics.push({ code: "custom-archive-ref-entry-changed", message: "Archive lease entry changed while opening and was conservatively protected.", severity: "warning", path })
      return { active: true }
    }
    const owner = await readOwnerFromHandle(handle)
    if (owner) {
      const expiresAt = Date.parse(owner.expiresAt)
      if (Number.isFinite(expiresAt) && expiresAt > now) return { active: true, token: owner.token }
      if (removeUnsafe) await unlink(path)
      return { active: false, token: owner.token }
    }
    const active = now - pathStat.mtimeMs <= legacyStaleMs
    if (!active && removeUnsafe) await unlink(path)
    return { active }
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return { active: false }
    if (errorHasCode(error, "ELOOP")) {
      diagnostics.push({ code: "custom-archive-ref-entry-unsafe", message: "Archive lease entry became a symlink and was conservatively protected.", severity: "warning", path })
      return { active: true }
    }
    throw error
  } finally {
    await handle?.close()
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
    const active = await activeReferenceCountInDirectory(path, now, policy, mode === "apply", diagnostics)
    if (active > 0) {
      activeCount += 1
    } else if (mode === "apply" && !await pathExists(path)) {
      removedCount += 1
    } else if (mode === "apply" && await removeOrphanReferencesDirectory(path, now, policy, diagnostics)) {
      removedCount += 1
    }
  }
  return { orphanCount: paths.length, activeCount, removedCount, paths }
}

async function activeReferenceCountInDirectory(path: string, now: number, policy: Pick<PlaygroundCustomArchiveCachePolicy, "staleLockMs">, removeStale: boolean, diagnostics: PlaygroundCustomArchiveCacheDiagnostic[] = []): Promise<number> {
  return activeArchiveReferenceCount(path.slice(0, -".refs".length), now, policy, removeStale, diagnostics)
}

async function removeOrphanReferencesDirectory(path: string, now: number, policy: Pick<PlaygroundCustomArchiveCachePolicy, "staleLockMs">, diagnostics: PlaygroundCustomArchiveCacheDiagnostic[]): Promise<boolean> {
  let sidecarStat
  try {
    sidecarStat = await lstat(path)
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return false
    throw error
  }
  if (!sidecarStat.isDirectory() || sidecarStat.isSymbolicLink()) {
    diagnostics.push({ code: "custom-archive-refs-not-directory", message: "Archive reference sidecar is not a real directory and was unlinked without following it.", severity: "warning", path })
    await unlink(path)
    return true
  }
  if (await activeReferenceCountInDirectory(path, now, policy, true, diagnostics) > 0) {
    return false
  }
  try {
    await rmdir(path)
    return true
  } catch (error) {
    if (errorHasCode(error, "ENOENT") || errorHasCode(error, "ENOTEMPTY")) {
      return false
    }
    diagnostics.push({ code: "orphan-reference-cleanup-failed", message: errorMessage(error), severity: "warning", path })
    return false
  }
}

async function openSafeLeaseDirectory(path: string, create: boolean): Promise<FileHandle> {
  if (create) {
    await mkdir(path).catch((error) => {
      if (!errorHasCode(error, "EEXIST")) throw error
    })
  }
  const pathStat = await lstat(path)
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error(`Playground cache lease sidecar must be a real directory: ${path}`)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const handleStat = await handle.stat()
  if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
    await handle.close()
    throw new Error(`Playground cache lease sidecar changed while opening: ${path}`)
  }
  return handle
}

function fileDescriptorPath(handle: FileHandle): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`
  if (process.platform === "darwin" || process.platform === "freebsd") return `/dev/fd/${handle.fd}`
  throw new Error("Playground cache leases require a platform with file-descriptor paths")
}

async function readOwnerFromHandle(handle: FileHandle): Promise<CacheOwnerRecord | undefined> {
  try {
    const fileStat = await handle.stat()
    const contents = Buffer.alloc(fileStat.size)
    await handle.read(contents, 0, contents.length, 0)
    return normalizeOwnerRecord(JSON.parse(contents.toString("utf8")))
  } catch (error) {
    if (error instanceof SyntaxError || errorHasCode(error, "ENOENT")) return undefined
    throw error
  }
}

async function writeOwnerToHandle(handle: FileHandle, owner: CacheOwnerRecord): Promise<void> {
  const contents = Buffer.from(`${JSON.stringify(owner)}\n`)
  await handle.write(contents, 0, contents.length, 0)
  await handle.truncate(contents.length)
  await handle.sync()
}

function normalizeOwnerRecord(value: Partial<CacheOwnerRecord>): CacheOwnerRecord | undefined {
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

async function filesystemAvailableBytes(path: string): Promise<number | undefined> {
  try {
    const filesystem = await statfs(path)
    return filesystem.bavail * filesystem.bsize
  } catch {
    return undefined
  }
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
