import assert from "node:assert/strict"
import { access, lutimes, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { inventoryTempRuntimeDirectories, type ProcessEvidence } from "../packages/cli/src/commands/temp-runtime-cleanup.js"
import { cleanupRecipePreparedSources, prepareRecipeWorkspaces } from "../packages/cli/src/recipe-sources.js"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/index.js"

const customTmp = await mkdtemp(join(tmpdir(), "wp-codebox-cleanup-test-root-"))
const originalTmp = process.env.TMPDIR
process.env.TMPDIR = customTmp
const complete = (rows: ProcessEvidence["rows"] = []): ProcessEvidence => ({ available: true, complete: true, rows, blockers: [] })
const unavailable = async (): Promise<ProcessEvidence> => ({ available: false, complete: false, rows: [], blockers: ["proc-unavailable:EACCES"] })

try {
  const normalWorkspaces = await prepareRecipeWorkspaces(workspaceRecipe([{ seed: { type: "plugin_scaffold", slug: "normal" } }]), customTmp)
  const normalWorkspacePaths = normalWorkspaces.flatMap((workspace) => workspace.cleanupPaths)
  assert.equal(normalWorkspacePaths.length, 2)
  await cleanupRecipePreparedSources(normalWorkspaces, [])
  await Promise.all(normalWorkspacePaths.map(async (path) => await assert.rejects(access(path), /ENOENT/)))

  await assert.rejects(
    prepareRecipeWorkspaces(workspaceRecipe([
      { seed: { type: "plugin_scaffold", slug: "prepared-before-failure" } },
      { seed: { type: "directory", slug: "failing", source: "missing-workspace" } },
    ]), customTmp),
    /ENOENT/,
  )
  assert.deepEqual((await readdir(customTmp)).filter((name) => name.startsWith("wp-codebox-workspace-")).sort(), [], "workspace preparation failures clean every allocated fixture")

  const stale = await ownedDirectory("wp-codebox-release-stale", 172_800)
  let report = await inventory({ cleanup: false })
  assert.equal(report.tempRoot, customTmp, "effective TMPDIR is inventoried")
  assert.equal(report.candidateCount, 1, "an old orphan is reported in dry-run mode")
  assert.equal(report.entries[0]?.kind, "release-package")
  assert.equal(report.entries[0]?.sizeBounded, true)
  assert.ok((report.entries[0]?.allocatedBytes ?? 0) > 0)
  assert.deepEqual(report.entries[0]?.blockingEvidence, [])
  await access(stale)

  report = await inventory({ cleanup: true })
  assert.equal(report.entries[0]?.state, "removed", "guarded cleanup removes a stale owned fixture")
  assert.equal(report.reclaimedAllocatedBytes, report.estimatedAllocatedBytes)
  await assert.rejects(access(stale), /ENOENT/)

  const recent = await ownedDirectory("wp-codebox-plugin-recent", 30)
  report = await inventory({ cleanup: true })
  assert.equal(entry(report, recent).retainedReason, "recent")
  assert.match(entry(report, recent).blockingEvidence[0] ?? "", /^age:/)
  await rm(recent, { recursive: true })

  const active = await ownedDirectory("wp-codebox-readonly-mounts-active", 172_800)
  const activeRows = [{ pid: process.pid + 1_000, command: "node worker", references: [active] }]
  report = await inventory({ cleanup: true, processEvidence: async () => complete(activeRows) })
  assert.equal(entry(report, active).retainedReason, "live-process")
  assert.deepEqual(entry(report, active).blockingEvidence, [`pid:${process.pid + 1_000}:path-reference`])
  await rm(active, { recursive: true })

  const becameActive = await ownedDirectory("wp-codebox-fuzz-command-became-active", 172_800)
  let processProbeCount = 0
  report = await inventory({
    cleanup: true,
    processEvidence: async () => ++processProbeCount === 1 ? complete() : complete([{ pid: process.pid + 2_000, command: `node worker ${becameActive}`, references: [] }]),
  })
  assert.equal(entry(report, becameActive).retainedReason, "live-process", "fresh process evidence protects a run that became active after inventory")
  await rm(becameActive, { recursive: true })

  const boundaryUnavailable = await ownedDirectory("wp-codebox-fuzz-workload-boundary-unavailable", 172_800)
  let boundaryProbeCount = 0
  report = await inventory({
    cleanup: true,
    processEvidence: async () => ++boundaryProbeCount === 3 ? await unavailable() : complete(),
  })
  assert.equal(entry(report, boundaryUnavailable).retainedReason, "evidence-unavailable", "cleanup restores quarantine when destructive-boundary evidence becomes unavailable")
  await access(boundaryUnavailable)
  await rm(boundaryUnavailable, { recursive: true })

  const noEvidence = await ownedDirectory("wp-codebox-workload-cli-no-evidence", 172_800)
  report = await inventory({ cleanup: true, processEvidence: unavailable })
  assert.equal(entry(report, noEvidence).retainedReason, "evidence-unavailable", "cleanup fails closed without complete process evidence")
  assert.deepEqual(entry(report, noEvidence).blockingEvidence, ["proc-unavailable:EACCES"])
  await rm(noEvidence, { recursive: true })

  const unrelated = await ownedDirectory("unrelated-project-cache", 172_800)
  const broadUnknown = await ownedDirectory("wp-codebox-unknown-family-old", 172_800)
  const homeboyOwned = await ownedDirectory("homeboy-wp-codebox-phpunit-old", 172_800)
  report = await inventory({ cleanup: true })
  assert.equal(report.ownedCount, 0, "unknown and externally owned prefixes never become candidates")
  assert.equal(await readFile(join(unrelated, "payload"), "utf8"), "owned blocks")
  await access(broadUnknown)
  await access(homeboyOwned)

  const outside = join(customTmp, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "marker"), "outside")
  const symlinkCandidate = join(customTmp, "wp-codebox-release-symlink")
  await symlink(outside, symlinkCandidate)
  report = await inventory({ cleanup: true })
  assert.equal(entry(report, symlinkCandidate).retainedReason, "unsafe-path", "candidate-root symlinks are refused")
  assert.equal(await readFile(join(outside, "marker"), "utf8"), "outside")
  await rm(symlinkCandidate)

  const nestedSymlink = await ownedDirectory("wp-codebox-release-contained-symlink", 172_800)
  const nestedSymlinkPath = join(nestedSymlink, "outside-link")
  await symlink(outside, nestedSymlinkPath)
  const staleTimestamp = new Date(Date.now() - 172_800 * 1_000)
  await lutimes(nestedSymlinkPath, staleTimestamp, staleTimestamp)
  await ageDirectory(nestedSymlink, 172_800)
  report = await inventory({ cleanup: true })
  assert.equal(entry(report, nestedSymlink).state, "removed", "contained cleanup unlinks but never follows nested symlinks")
  assert.equal(await readFile(join(outside, "marker"), "utf8"), "outside")

  const raced = await ownedDirectory("wp-codebox-release-raced", 172_800)
  const displaced = join(customTmp, "displaced-race-fixture")
  report = await inventory({
    cleanup: true,
    beforeRemove: async (path) => {
      if (path !== raced) return
      await rename(path, displaced)
      await symlink(outside, path)
    },
  })
  assert.equal(entry(report, raced).retainedReason, "changed-before-cleanup", "destructive-boundary revalidation refuses a replaced candidate")
  assert.equal(await readFile(join(outside, "marker"), "utf8"), "outside")
  await rm(raced)
  await rm(displaced, { recursive: true })

  const refreshed = await ownedDirectory("wp-codebox-release-refreshed", 172_800)
  report = await inventory({
    cleanup: true,
    beforeRemove: async (path) => {
      if (path === refreshed) await ageDirectory(path, 0)
    },
  })
  assert.equal(entry(report, refreshed).retainedReason, "recent", "fresh age evidence preserves a fixture reused during cleanup")
  await rm(refreshed, { recursive: true })

  const overBudget = await ownedDirectory("wp-codebox-release-over-budget", 172_800)
  await writeFile(join(overBudget, "second"), "entry")
  await ageDirectory(overBudget, 172_800)
  report = await inventory({ cleanup: true, usageEntryLimit: 2 })
  assert.equal(entry(report, overBudget).retainedReason, "scan-budget-exhausted")
  assert.equal(entry(report, overBudget).sizeBounded, false)
  assert.equal(entry(report, overBudget).allocatedBytes, undefined)
  await rm(overBudget, { recursive: true })

  const registryProtected = await ownedDirectory("wp-codebox-source-registry", 172_800)
  const registry = join(customTmp, "registry")
  await mkdir(join(registry, "preview-leases"), { recursive: true })
  await writeFile(join(registry, "preview-leases", "active.json"), JSON.stringify({ status: "available", expiresAt: new Date(Date.now() + 60_000).toISOString() }))
  report = await inventory({ cleanup: true, runRegistryRoots: [registry] })
  assert.equal(entry(report, registryProtected).retainedReason, "active-lease")
  await rm(registryProtected, { recursive: true })

  await ownedDirectory("wp-codebox-release-scan-one", 172_800)
  await ownedDirectory("wp-codebox-release-scan-two", 172_800)
  report = await inventory({ cleanup: false, scanLimit: 1 })
  assert.equal(report.scannedCount, 1)
  assert.equal(report.scanComplete, false, "temp-root inventory is bounded")

  console.log("Temp runtime cleanup tests passed")
} finally {
  if (originalTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = originalTmp
  await rm(customTmp, { recursive: true, force: true })
}

interface InventoryOverrides {
  cleanup: boolean
  processEvidence?: () => Promise<ProcessEvidence>
  usageEntryLimit?: number
  scanLimit?: number
  runRegistryRoots?: string[]
  beforeRemove?: (path: string) => Promise<void>
}

async function inventory(overrides: InventoryOverrides) {
  return await inventoryTempRuntimeDirectories({
    staleAfterSeconds: 86_400,
    runRegistryRoots: [],
    processEvidence: async () => complete(),
    ...overrides,
  })
}

function workspaceRecipe(workspaces: Array<Record<string, unknown>>): WorkspaceRecipe {
  return { inputs: { workspaces } } as unknown as WorkspaceRecipe
}

function entry(report: Awaited<ReturnType<typeof inventoryTempRuntimeDirectories>>, path: string) {
  const candidate = report.entries.find((row) => row.path === path)
  assert.ok(candidate, `missing report entry for ${basename(path)}`)
  return candidate
}

async function ownedDirectory(name: string, ageSeconds: number): Promise<string> {
  const path = join(customTmp, name)
  await mkdir(path)
  await writeFile(join(path, "payload"), "owned blocks")
  await ageDirectory(path, ageSeconds)
  return path
}

async function ageDirectory(path: string, ageSeconds: number): Promise<void> {
  const timestamp = new Date(Date.now() - ageSeconds * 1_000)
  for (const child of ["payload", "second"]) {
    await utimes(join(path, child), timestamp, timestamp).catch(() => undefined)
  }
  await utimes(path, timestamp, timestamp)
}
