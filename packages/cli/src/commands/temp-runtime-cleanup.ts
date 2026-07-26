import { lstat, opendir, readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"

export type TempRuntimeRetentionReason = "recent" | "live-process" | "active-lease" | "recent-run" | "changed-before-cleanup"

export interface TempRuntimeCandidate {
  path: string
  kind: string
  ownershipEvidence: string
  ageSeconds: number
  allocatedBytes: number
  state: "candidate" | "retained" | "removed" | "failed"
  retainedReason?: TempRuntimeRetentionReason
  error?: string
}

export interface TempRuntimeInventory {
  tempRoot: string
  scannedCount: number
  ownedCount: number
  candidateCount: number
  retainedCount: number
  retainedReasons: Record<string, number>
  estimatedAllocatedBytes: number
  reclaimedAllocatedBytes: number
  entries: TempRuntimeCandidate[]
}

interface TempRuntimeCleanupOptions {
  cleanup: boolean
  staleAfterSeconds: number
  runRegistryRoots: string[]
  now?: number
  processRows?: ProcessRow[]
}

interface ProcessRow { pid: number; command: string; references: string[] }
interface DirectoryIdentity { device: number; inode: number }

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
]

export async function inventoryTempRuntimeDirectories(options: TempRuntimeCleanupOptions): Promise<TempRuntimeInventory> {
  const tempRoot = await realpath(tmpdir())
  const rootStat = await stat(tempRoot)
  const now = options.now ?? Date.now()
  const processes = options.processRows ?? await runtimeProcessRows()
  const globalProtection = await globalRuntimeProtection(processes, options.runRegistryRoots, now, options.staleAfterSeconds)
  const entries: TempRuntimeCandidate[] = []
  let scannedCount = 0

  const directory = await opendir(tempRoot)
  for await (const entry of directory) {
    scannedCount++
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const path = join(tempRoot, entry.name)
    const ownership = await ownershipEvidence(path, entry.name)
    if (!ownership) continue

    const before = await stat(path)
    if (!before.isDirectory() || before.dev !== rootStat.dev || !isDirectChild(tempRoot, path)) continue
    const usage = await allocatedUsage(path)
    const ageSeconds = Math.max(0, Math.floor((now - usage.latestMtimeMs) / 1000))
    const row: TempRuntimeCandidate = {
      path,
      kind: ownership.kind,
      ownershipEvidence: ownership.evidence,
      ageSeconds,
      allocatedBytes: usage.allocatedBytes,
      state: "candidate",
    }
    const retainedReason = ageSeconds < options.staleAfterSeconds
      ? "recent"
      : processReferencesPath(processes, path)
        ? "live-process"
        : globalProtection
    if (retainedReason) {
      row.state = "retained"
      row.retainedReason = retainedReason
    } else if (options.cleanup) {
      await removeCandidate(row, { device: before.dev, inode: before.ino }, tempRoot)
    }
    entries.push(row)
  }

  const retainedReasons: Record<string, number> = {}
  for (const row of entries) {
    if (row.retainedReason) retainedReasons[row.retainedReason] = (retainedReasons[row.retainedReason] ?? 0) + 1
  }
  return {
    tempRoot,
    scannedCount,
    ownedCount: entries.length,
    candidateCount: entries.filter((row) => row.state === "candidate" || row.state === "removed" || row.state === "failed").length,
    retainedCount: entries.filter((row) => row.state === "retained").length,
    retainedReasons,
    estimatedAllocatedBytes: entries.filter((row) => row.state !== "retained").reduce((total, row) => total + row.allocatedBytes, 0),
    reclaimedAllocatedBytes: entries.filter((row) => row.state === "removed").reduce((total, row) => total + row.allocatedBytes, 0),
    entries,
  }
}

async function ownershipEvidence(path: string, name: string): Promise<{ kind: string; evidence: string } | undefined> {
  const owned = OWNED_PREFIXES.find(([prefix]) => name.startsWith(prefix) && name.length > prefix.length)
  if (owned) return { kind: owned[1], evidence: `registered-producer-prefix:${owned[0]}` }
  if (!name.startsWith("node-playground-cli-site-") || name.length === "node-playground-cli-site-".length) return undefined
  const children = new Set(await readdir(path).catch(() => []))
  if (!children.has("wp-content") || (!children.has("wp-includes") && !children.has("wp-config.php"))) return undefined
  return { kind: "playground-site", evidence: "registered-upstream-prefix+wordpress-layout" }
}

async function allocatedUsage(root: string): Promise<{ allocatedBytes: number; latestMtimeMs: number }> {
  const metadata = await stat(root)
  let allocatedBytes = metadata.blocks * 512
  let latestMtimeMs = metadata.mtimeMs
  const directory = await opendir(root)
  for await (const entry of directory) {
    const path = join(root, entry.name)
    const child = await lstat(path).catch(() => undefined)
    if (!child) continue
    allocatedBytes += child.blocks * 512
    latestMtimeMs = Math.max(latestMtimeMs, child.mtimeMs)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = await allocatedUsage(path)
      allocatedBytes += nested.allocatedBytes - child.blocks * 512
      latestMtimeMs = Math.max(latestMtimeMs, nested.latestMtimeMs)
    }
  }
  return { allocatedBytes, latestMtimeMs }
}

async function removeCandidate(row: TempRuntimeCandidate, identity: DirectoryIdentity, tempRoot: string): Promise<void> {
  try {
    const canonical = await realpath(row.path)
    const current = await stat(row.path)
    if (canonical !== resolve(row.path) || !isDirectChild(tempRoot, canonical) || current.dev !== identity.device || current.ino !== identity.inode) {
      row.state = "retained"
      row.retainedReason = "changed-before-cleanup"
      return
    }
    await rm(row.path, { recursive: true })
    row.state = "removed"
  } catch (error) {
    row.state = "failed"
    row.error = errorMessage(error)
  }
}

async function globalRuntimeProtection(processes: ProcessRow[], registryRoots: string[], now: number, staleAfterSeconds: number): Promise<TempRuntimeRetentionReason | undefined> {
  if (processes.some((row) => row.pid !== process.pid && /wp-codebox/.test(row.command) && /(recipe-run|agent-task-run|run-agent-task|preview-lease-child)/.test(row.command))) return "live-process"
  for (const root of registryRoots) {
    const leaseProtection = await activeLeaseInRegistry(root, now)
    if (leaseProtection) return "active-lease"
    if (await recentRunInRegistry(root, now, staleAfterSeconds)) return "recent-run"
  }
  return undefined
}

async function activeLeaseInRegistry(root: string, now: number): Promise<boolean> {
  const leaseDirectory = join(resolve(root), "preview-leases")
  for (const name of await readdir(leaseDirectory).catch(() => [])) {
    if (!name.endsWith(".json")) continue
    const lease = await readJson(join(leaseDirectory, name))
    if (!lease || !["starting", "available", "release_requested"].includes(String(lease.status))) continue
    const expiresAt = Date.parse(String(lease.expiresAt ?? ""))
    if (!Number.isFinite(expiresAt) || expiresAt > now) return true
  }
  return false
}

async function recentRunInRegistry(root: string, now: number, staleAfterSeconds: number): Promise<boolean> {
  for (const name of await readdir(resolve(root)).catch(() => [])) {
    if (!name.endsWith(".json")) continue
    const run = await readJson(join(resolve(root), name))
    if (run?.schema !== "wp-codebox/run-registry-entry/v1") continue
    const heartbeat = Date.parse(String(run.heartbeatAt ?? run.updatedAt ?? ""))
    if (Number.isFinite(heartbeat) && now - heartbeat < staleAfterSeconds * 1000) return true
  }
  return false
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> } catch { return undefined }
}

async function runtimeProcessRows(): Promise<ProcessRow[]> {
  if (process.platform !== "linux") return []
  const rows: ProcessRow[] = []
  for (const name of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number.parseInt(name, 10)
    const command = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).replace(/\0/g, " ").trim()
    if (!command) continue
    const references = [await realpath(`/proc/${pid}/cwd`).catch(() => "")]
    for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [])) references.push(await realpath(`/proc/${pid}/fd/${fd}`).catch(() => ""))
    rows.push({ pid, command, references: references.filter(Boolean) })
  }
  return rows
}

function processReferencesPath(processes: ProcessRow[], path: string): boolean {
  const prefix = `${resolve(path)}${sep}`
  return processes.some((row) => row.pid !== process.pid && (row.command.includes(path) || row.references.some((reference) => reference === path || reference.startsWith(prefix))))
}

function isDirectChild(root: string, path: string): boolean {
  return resolve(path).startsWith(`${resolve(root)}${sep}`) && basename(path) !== "" && resolve(join(path, "..")) === resolve(root)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
