import { randomUUID } from "node:crypto"
import { lstat, opendir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"

export type TempRuntimeRetentionReason = "recent" | "live-process" | "active-lease" | "recent-run" | "evidence-unavailable" | "unsafe-path" | "changed-before-cleanup" | "scan-budget-exhausted"

export interface TempRuntimeCandidate {
  path: string
  kind: string
  ownershipEvidence: string
  ageSeconds?: number
  allocatedBytes?: number
  measuredEntries: number
  sizeBounded: boolean
  state: "candidate" | "retained" | "removed" | "failed"
  retainedReason?: TempRuntimeRetentionReason
  blockingEvidence: string[]
  error?: string
}

export interface TempRuntimeInventory {
  tempRoot: string
  scannedCount: number
  scanLimit: number
  scanComplete: boolean
  ownedCount: number
  candidateCount: number
  retainedCount: number
  retainedReasons: Record<string, number>
  estimatedAllocatedBytes: number
  reclaimedAllocatedBytes: number
  entries: TempRuntimeCandidate[]
}

export interface ProcessRow { pid: number; command: string; references: string[] }
export interface ProcessEvidence { available: boolean; complete: boolean; rows: ProcessRow[]; blockers: string[] }

interface TempRuntimeCleanupOptions {
  cleanup: boolean
  staleAfterSeconds: number
  runRegistryRoots: string[]
  now?: number
  processRows?: ProcessRow[]
  processEvidence?: () => Promise<ProcessEvidence>
  scanLimit?: number
  usageEntryLimit?: number
  beforeRemove?: (path: string) => Promise<void>
}

interface DirectoryIdentity { device: number; inode: number }
interface UsageEvidence { allocatedBytes: number; latestMtimeMs: number; measuredEntries: number; complete: boolean; blockers: string[] }
interface RuntimeProtection { reason?: TempRuntimeRetentionReason; evidence: string[] }

export const DEFAULT_TEMP_RUNTIME_SCAN_LIMIT = 5_000
export const DEFAULT_TEMP_RUNTIME_USAGE_ENTRY_LIMIT = 100_000

const OWNED_PREFIXES: ReadonlyArray<readonly [prefix: string, kind: string]> = [
  ["wp-codebox-agent-task-artifacts-", "agent-task-artifacts"],
  ["wp-codebox-agent-task-recipe-", "agent-task-recipe"],
  ["wp-codebox-dependency-consumer-", "dependency-consumer"],
  ["wp-codebox-dependency-overlay-", "dependency-overlay"],
  ["wp-codebox-fuzz-command-", "fuzz-command"],
  ["wp-codebox-fuzz-workload-", "fuzz-workload"],
  ["wp-codebox-git-head-", "git-head"],
  ["wp-codebox-input-mount-baseline-", "input-mount-baseline"],
  ["wp-codebox-mariadb-", "native-mariadb"],
  ["wp-codebox-overlay-php-ai-client-", "runtime-overlay"],
  ["wp-codebox-plugin-", "plugin-overlay"],
  ["wp-codebox-readonly-mounts-", "readonly-mounts"],
  ["wp-codebox-release-coverage-", "release-coverage"],
  ["wp-codebox-release-", "release-package"],
  ["wp-codebox-source-package-", "source-package"],
  ["wp-codebox-source-", "source"],
  ["wp-codebox-staged-file-", "staged-file"],
  ["wp-codebox-workload-cli-", "workload-cli"],
  ["wp-codebox-workspace-preload-", "workspace-preload"],
  ["wp-codebox-workspace-baseline-", "workspace-baseline"],
  ["wp-codebox-workspace-", "workspace"],
]

export async function inventoryTempRuntimeDirectories(options: TempRuntimeCleanupOptions): Promise<TempRuntimeInventory> {
  const tempRoot = await realpath(tmpdir())
  const rootStat = await stat(tempRoot)
  const now = options.now ?? Date.now()
  const scanLimit = positiveLimit(options.scanLimit, DEFAULT_TEMP_RUNTIME_SCAN_LIMIT)
  const usageEntryLimit = positiveLimit(options.usageEntryLimit, DEFAULT_TEMP_RUNTIME_USAGE_ENTRY_LIMIT)
  const processProvider = options.processEvidence ?? (options.processRows ? async () => completeProcessEvidence(options.processRows ?? []) : runtimeProcessEvidence)
  const initialProcesses = await processProvider()
  const initialProtection = await globalRuntimeProtection(initialProcesses, options.runRegistryRoots, now, options.staleAfterSeconds)
  const entries: TempRuntimeCandidate[] = []
  let scannedCount = 0
  let scanComplete = true

  const directory = await opendir(tempRoot)
  for await (const entry of directory) {
    if (scannedCount >= scanLimit) {
      scanComplete = false
      break
    }
    scannedCount++
    const ownership = ownedPrefix(entry.name)
    if (!ownership) continue
    const path = join(tempRoot, entry.name)
    const row: TempRuntimeCandidate = {
      path,
      kind: ownership.kind,
      ownershipEvidence: `registered-producer-prefix:${ownership.prefix}`,
      measuredEntries: 0,
      sizeBounded: false,
      state: "candidate",
      blockingEvidence: [],
    }
    entries.push(row)

    const before = await lstat(path).catch(() => undefined)
    if (!before || !before.isDirectory() || before.isSymbolicLink() || before.dev !== rootStat.dev || !isDirectChild(tempRoot, path)) {
      retain(row, "unsafe-path", "candidate is not a direct, same-filesystem directory")
      continue
    }
    const canonical = await realpath(path).catch(() => "")
    if (canonical !== resolve(path)) {
      retain(row, "unsafe-path", "candidate canonical path escapes or differs from its owned path")
      continue
    }

    const usage = await allocatedUsage(path, rootStat.dev, usageEntryLimit)
    applyUsage(row, usage, now)
    if (!usage.complete) {
      retain(row, usage.blockers.some((blocker) => blocker === "usage-entry-limit") ? "scan-budget-exhausted" : "unsafe-path", ...usage.blockers)
      continue
    }
    const ageSeconds = row.ageSeconds ?? 0
    const protection = ageSeconds < options.staleAfterSeconds
      ? { reason: "recent" as const, evidence: [`age:${ageSeconds}s<${options.staleAfterSeconds}s`] }
      : processReferencesPath(initialProcesses.rows, path)
        ? { reason: "live-process" as const, evidence: processPathEvidence(initialProcesses.rows, path) }
        : initialProtection
    if (protection.reason) {
      retain(row, protection.reason, ...protection.evidence)
    } else if (options.cleanup) {
      await removeCandidate(row, { device: before.dev, inode: before.ino }, tempRoot, rootStat.dev, options, processProvider, usageEntryLimit)
    }
  }

  const retainedReasons: Record<string, number> = {}
  for (const row of entries) {
    if (row.retainedReason) retainedReasons[row.retainedReason] = (retainedReasons[row.retainedReason] ?? 0) + 1
  }
  return {
    tempRoot,
    scannedCount,
    scanLimit,
    scanComplete,
    ownedCount: entries.length,
    candidateCount: entries.filter((row) => row.state === "candidate" || row.state === "removed" || row.state === "failed").length,
    retainedCount: entries.filter((row) => row.state === "retained").length,
    retainedReasons,
    estimatedAllocatedBytes: entries.filter((row) => row.state !== "retained").reduce((total, row) => total + (row.allocatedBytes ?? 0), 0),
    reclaimedAllocatedBytes: entries.filter((row) => row.state === "removed").reduce((total, row) => total + (row.allocatedBytes ?? 0), 0),
    entries,
  }
}

function ownedPrefix(name: string): { prefix: string; kind: string } | undefined {
  const owned = OWNED_PREFIXES.find(([prefix]) => name.startsWith(prefix) && name.length > prefix.length)
  return owned ? { prefix: owned[0], kind: owned[1] } : undefined
}

async function allocatedUsage(root: string, expectedDevice: number, entryLimit: number): Promise<UsageEvidence> {
  const metadata = await lstat(root)
  let allocatedBytes = metadata.blocks * 512
  let latestMtimeMs = metadata.mtimeMs
  let measuredEntries = 1
  const blockers: string[] = []
  const pending = [root]

  while (pending.length > 0) {
    const directoryPath = pending.pop()!
    let directory
    try {
      directory = await opendir(directoryPath)
    } catch (error) {
      blockers.push(`unreadable-directory:${relativeEvidencePath(root, directoryPath)}:${errorCode(error)}`)
      continue
    }
    for await (const entry of directory) {
      if (measuredEntries >= entryLimit) {
        blockers.push("usage-entry-limit")
        return { allocatedBytes, latestMtimeMs, measuredEntries, complete: false, blockers }
      }
      const path = join(directoryPath, entry.name)
      const child = await lstat(path).catch((error) => {
        if (errorCode(error) !== "ENOENT") blockers.push(`unreadable-entry:${relativeEvidencePath(root, path)}:${errorCode(error)}`)
        return undefined
      })
      if (!child) continue
      measuredEntries++
      allocatedBytes += child.blocks * 512
      latestMtimeMs = Math.max(latestMtimeMs, child.mtimeMs)
      if (child.isDirectory() && !child.isSymbolicLink()) {
        if (child.dev !== expectedDevice) blockers.push(`mount-point:${relativeEvidencePath(root, path)}`)
        else pending.push(path)
      }
    }
  }
  return { allocatedBytes, latestMtimeMs, measuredEntries, complete: blockers.length === 0, blockers }
}

async function removeCandidate(row: TempRuntimeCandidate, identity: DirectoryIdentity, tempRoot: string, rootDevice: number, options: TempRuntimeCleanupOptions, processProvider: () => Promise<ProcessEvidence>, usageEntryLimit: number): Promise<void> {
  try {
    await options.beforeRemove?.(row.path)
    const freshProcesses = await processProvider()
    const freshProtection = await globalRuntimeProtection(freshProcesses, options.runRegistryRoots, Date.now(), options.staleAfterSeconds)
    if (freshProtection.reason) {
      retain(row, freshProtection.reason, ...freshProtection.evidence)
      return
    }
    const liveEvidence = processPathEvidence(freshProcesses.rows, row.path)
    if (liveEvidence.length > 0) {
      retain(row, "live-process", ...liveEvidence)
      return
    }

    const canonical = await realpath(row.path)
    const current = await lstat(row.path)
    const ownership = ownedPrefix(basename(row.path))
    if (!ownership || canonical !== resolve(row.path) || !isDirectChild(tempRoot, canonical) || !current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.device || current.ino !== identity.inode) {
      retain(row, "changed-before-cleanup", "path, ownership, type, device, or inode changed before cleanup")
      return
    }
    const freshUsage = await allocatedUsage(row.path, rootDevice, usageEntryLimit)
    applyUsage(row, freshUsage, Date.now())
    if (!freshUsage.complete) {
      retain(row, freshUsage.blockers.some((blocker) => blocker === "usage-entry-limit") ? "scan-budget-exhausted" : "unsafe-path", ...freshUsage.blockers)
      return
    }
    if ((row.ageSeconds ?? 0) < options.staleAfterSeconds) {
      retain(row, "recent", `fresh-age:${row.ageSeconds ?? 0}s<${options.staleAfterSeconds}s`)
      return
    }

    const quarantine = join(tempRoot, `.wp-codebox-cleanup-${process.pid}-${randomUUID()}`)
    await rename(row.path, quarantine)
    const quarantined = await lstat(quarantine)
    const quarantinedCanonical = await realpath(quarantine)
    if (quarantinedCanonical !== resolve(quarantine) || !isDirectChild(tempRoot, quarantine) || !quarantined.isDirectory() || quarantined.isSymbolicLink() || quarantined.dev !== identity.device || quarantined.ino !== identity.inode) {
      await restoreChangedCandidate(quarantine, row.path)
      retain(row, "changed-before-cleanup", "candidate identity changed at quarantine boundary")
      return
    }
    const quarantineUsage = await allocatedUsage(quarantine, rootDevice, usageEntryLimit)
    if (!quarantineUsage.complete) {
      await restoreChangedCandidate(quarantine, row.path)
      retain(row, quarantineUsage.blockers.some((blocker) => blocker === "usage-entry-limit") ? "scan-budget-exhausted" : "unsafe-path", ...quarantineUsage.blockers)
      return
    }
    const boundaryProcesses = await processProvider()
    const boundaryProtection = await globalRuntimeProtection(boundaryProcesses, options.runRegistryRoots, Date.now(), options.staleAfterSeconds)
    const boundaryPathEvidence = processPathEvidence(boundaryProcesses.rows, quarantine)
    if (boundaryProtection.reason || boundaryPathEvidence.length > 0) {
      await restoreChangedCandidate(quarantine, row.path)
      retain(row, boundaryPathEvidence.length > 0 ? "live-process" : boundaryProtection.reason!, ...(boundaryPathEvidence.length > 0 ? boundaryPathEvidence : boundaryProtection.evidence))
      return
    }
    await rm(quarantine, { recursive: true })
    row.state = "removed"
  } catch (error) {
    row.state = "failed"
    row.error = errorMessage(error)
  }
}

async function restoreChangedCandidate(quarantine: string, original: string): Promise<void> {
  try {
    await lstat(original)
  } catch (error) {
    if (errorCode(error) === "ENOENT") await rename(quarantine, original)
  }
}

async function globalRuntimeProtection(processes: ProcessEvidence, registryRoots: string[], now: number, staleAfterSeconds: number): Promise<RuntimeProtection> {
  if (!processes.available || !processes.complete) {
    return { reason: "evidence-unavailable", evidence: processes.blockers.length > 0 ? processes.blockers : ["process-evidence-unavailable"] }
  }
  const activeCommands = processes.rows.filter((row) => row.pid !== process.pid && /wp-codebox/.test(row.command) && /(recipe-run|agent-task-run|run-agent-task|preview-lease-child)/.test(row.command))
  if (activeCommands.length > 0) return { reason: "live-process", evidence: activeCommands.slice(0, 20).map((row) => `pid:${row.pid}:runtime-command`) }
  for (const root of registryRoots) {
    const registry = await registryProtection(root, now, staleAfterSeconds)
    if (registry.reason) return registry
  }
  return { evidence: [] }
}

async function registryProtection(root: string, now: number, staleAfterSeconds: number): Promise<RuntimeProtection> {
  const canonicalRoot = resolve(root)
  const rootEntries = await safeReaddir(canonicalRoot)
  if (!rootEntries.available) return rootEntries.missing ? { evidence: [] } : { reason: "evidence-unavailable", evidence: [`run-registry:${canonicalRoot}:${rootEntries.error}`] }
  const leaseDirectory = join(canonicalRoot, "preview-leases")
  const leaseEntries = await safeReaddir(leaseDirectory)
  if (!leaseEntries.available && !leaseEntries.missing) return { reason: "evidence-unavailable", evidence: [`preview-leases:${leaseDirectory}:${leaseEntries.error}`] }
  for (const name of leaseEntries.entries) {
    if (!name.endsWith(".json")) continue
    const lease = await readJson(join(leaseDirectory, name))
    if (!lease.available) return { reason: "evidence-unavailable", evidence: [`preview-lease:${name}:${lease.error}`] }
    if (!lease.value || !["starting", "available", "release_requested"].includes(String(lease.value.status))) continue
    const expiresAt = Date.parse(String(lease.value.expiresAt ?? ""))
    if (!Number.isFinite(expiresAt) || expiresAt > now) return { reason: "active-lease", evidence: [`preview-lease:${name}`] }
  }
  for (const name of rootEntries.entries) {
    if (!name.endsWith(".json")) continue
    const run = await readJson(join(canonicalRoot, name))
    if (!run.available) return { reason: "evidence-unavailable", evidence: [`run-registry-entry:${name}:${run.error}`] }
    if (run.value?.schema !== "wp-codebox/run-registry-entry/v1") continue
    const heartbeat = Date.parse(String(run.value.heartbeatAt ?? run.value.updatedAt ?? ""))
    if (Number.isFinite(heartbeat) && now - heartbeat < staleAfterSeconds * 1000) return { reason: "recent-run", evidence: [`run-heartbeat:${name}`] }
  }
  return { evidence: [] }
}

async function safeReaddir(path: string): Promise<{ available: boolean; missing: boolean; entries: string[]; error?: string }> {
  try {
    return { available: true, missing: false, entries: await readdir(path) }
  } catch (error) {
    return { available: false, missing: errorCode(error) === "ENOENT", entries: [], error: errorCode(error) }
  }
}

async function readJson(path: string): Promise<{ available: boolean; value?: Record<string, unknown>; error?: string }> {
  try {
    return { available: true, value: JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> }
  } catch (error) {
    return { available: false, error: errorCode(error) }
  }
}

async function runtimeProcessEvidence(): Promise<ProcessEvidence> {
  if (process.platform !== "linux") return { available: false, complete: false, rows: [], blockers: [`unsupported-platform:${process.platform}`] }
  const procEntries = await safeReaddir("/proc")
  if (!procEntries.available) return { available: false, complete: false, rows: [], blockers: [`proc-unavailable:${procEntries.error}`] }
  const rows: ProcessRow[] = []
  const blockers: string[] = []
  for (const name of procEntries.entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number.parseInt(name, 10)
    const commandRead = await readProcCommand(pid)
    if (commandRead.vanished) continue
    if (!commandRead.available) {
      blockers.push(`pid:${pid}:cmdline:${commandRead.error}`)
      continue
    }
    if (!commandRead.command) continue
    const references: string[] = []
    const cwd = await readProcReference(`/proc/${pid}/cwd`)
    if (cwd.value) references.push(cwd.value)
    else if (!cwd.vanished) blockers.push(`pid:${pid}:cwd:${cwd.error}`)
    const descriptors = await safeReaddir(`/proc/${pid}/fd`)
    if (!descriptors.available && !descriptors.missing) blockers.push(`pid:${pid}:fd:${descriptors.error}`)
    for (const fd of descriptors.entries) {
      const reference = await readProcReference(`/proc/${pid}/fd/${fd}`)
      if (reference.value) references.push(reference.value)
      else if (!reference.vanished) blockers.push(`pid:${pid}:fd:${fd}:${reference.error}`)
    }
    rows.push({ pid, command: commandRead.command, references })
  }
  return { available: true, complete: blockers.length === 0, rows, blockers: blockers.slice(0, 100) }
}

async function readProcCommand(pid: number): Promise<{ available: boolean; vanished: boolean; command: string; error?: string }> {
  try {
    return { available: true, vanished: false, command: (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim() }
  } catch (error) {
    return { available: false, vanished: errorCode(error) === "ENOENT", command: "", error: errorCode(error) }
  }
}

async function readProcReference(path: string): Promise<{ value?: string; vanished: boolean; error?: string }> {
  try {
    return { value: await realpath(path), vanished: false }
  } catch (error) {
    const code = errorCode(error)
    return { vanished: code === "ENOENT", error: code }
  }
}

function completeProcessEvidence(rows: ProcessRow[]): ProcessEvidence {
  return { available: true, complete: true, rows, blockers: [] }
}

function processPathEvidence(processes: ProcessRow[], path: string): string[] {
  const prefix = `${resolve(path)}${sep}`
  return processes.flatMap((row) => {
    if (row.pid === process.pid) return []
    if (row.command.includes(path)) return [`pid:${row.pid}:command`]
    if (row.references.some((reference) => reference === path || reference.startsWith(prefix))) return [`pid:${row.pid}:path-reference`]
    return []
  }).slice(0, 20)
}

function processReferencesPath(processes: ProcessRow[], path: string): boolean {
  return processPathEvidence(processes, path).length > 0
}

function applyUsage(row: TempRuntimeCandidate, usage: UsageEvidence, now: number): void {
  row.measuredEntries = usage.measuredEntries
  row.sizeBounded = usage.complete
  row.allocatedBytes = usage.complete ? usage.allocatedBytes : undefined
  row.ageSeconds = Math.max(0, Math.floor((now - usage.latestMtimeMs) / 1000))
}

function retain(row: TempRuntimeCandidate, reason: TempRuntimeRetentionReason, ...evidence: string[]): void {
  row.state = "retained"
  row.retainedReason = reason
  row.blockingEvidence = evidence.slice(0, 100)
}

function relativeEvidencePath(root: string, path: string): string {
  return resolve(path) === resolve(root) ? "." : resolve(path).slice(`${resolve(root)}${sep}`.length)
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback
}

function isDirectChild(root: string, path: string): boolean {
  return resolve(path).startsWith(`${resolve(root)}${sep}`) && basename(path) !== "" && resolve(join(path, "..")) === resolve(root)
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
