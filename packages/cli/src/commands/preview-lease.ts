import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, openSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { defaultRunRegistryDirectory, RuntimeRunRegistry, type ArtifactPreview } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { loadWorkspaceRecipe } from "../recipe-validation.js"

export interface PreviewLeaseMetadata {
  schema: "wp-codebox/preview-lease/v1"
  leaseId: string
  runId?: string
  registryDirectory: string
  leaseFile: string
  status: "starting" | "available" | "release_requested" | "released" | "expired" | "failed"
  pid?: number
  createdAt: string
  updatedAt: string
  expiresAt?: string
  holdSeconds?: number
  preview?: ArtifactPreview
  releaseCommand: string[]
  statusCommand: string[]
  outputFile?: string
  error?: { name: string; message: string; code?: string }
}

interface PreviewLeaseStartOptions {
  args: string[]
  json: boolean
  recipePath: string
  artifactsDirectory?: string
  runRegistryDirectory?: string
  previewHoldSeconds?: number
}

interface PreviewLeaseLookupOptions {
  leaseId?: string
  leaseFile?: string
  registryDirectory?: string
  json: boolean
}

const PREVIEW_LEASE_READY_TIMEOUT_MS = 30 * 60 * 1000

export async function startPreviewLeaseRecipeRun(options: PreviewLeaseStartOptions): Promise<number> {
  if (!options.previewHoldSeconds || options.previewHoldSeconds <= 0) {
    throw new Error("--preview-lease requires --preview-hold-seconds so the detached runtime has a bounded lifetime")
  }

  const leaseId = createPreviewLeaseId()
  const registryDirectory = await resolvePreviewLeaseRegistryDirectory(options)
  const leaseFile = previewLeaseFile(registryDirectory, leaseId)
  const outputFile = join(dirname(leaseFile), `${leaseId}.recipe-run.json`)
  const now = new Date().toISOString()
  await writePreviewLease({
    schema: "wp-codebox/preview-lease/v1",
    leaseId,
    registryDirectory,
    leaseFile,
    status: "starting",
    createdAt: now,
    updatedAt: now,
    holdSeconds: options.previewHoldSeconds,
    outputFile,
    releaseCommand: previewLeaseReleaseCommand(registryDirectory, leaseId),
    statusCommand: previewLeaseStatusCommand(registryDirectory, leaseId),
  })

  const executable = process.argv[1]
  if (!executable) {
    throw new Error("Unable to resolve wp-codebox CLI entrypoint for preview lease child")
  }
  await mkdir(dirname(outputFile), { recursive: true })
  const stdoutFd = openSync(outputFile, "a")
  const stderrFd = openSync(`${outputFile}.stderr`, "a")

  const child = spawn(process.execPath, [...process.execArgv, executable, "recipe-run", ...withoutPreviewLeaseFlag(options.args), "--json", "--preview-hold-blocking", "--preview-lease-child", "--preview-lease-id", leaseId, "--preview-lease-file", leaseFile], {
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    env: {
      ...process.env,
      WP_CODEBOX_PREVIEW_LEASE_CHILD: "1",
    },
  })
  closeSync(stdoutFd)
  closeSync(stderrFd)
  child.unref()

  await updatePreviewLease(leaseFile, { pid: child.pid })
  const lease = await waitForPreviewLease(leaseFile, child.pid)
  printPreviewLeaseOutput(lease, options.json)
  return lease.status === "available" ? 0 : 1
}

export async function markPreviewLeaseAvailable(leaseFile: string, update: { runId: string; preview?: ArtifactPreview; holdSeconds?: number }): Promise<PreviewLeaseMetadata | undefined> {
  const existing = await readPreviewLeaseOptional(leaseFile)
  if (!existing) {
    return undefined
  }

  return updatePreviewLease(leaseFile, {
    runId: update.runId,
    status: "available",
    preview: update.preview,
    expiresAt: update.preview?.expiresAt,
    holdSeconds: update.holdSeconds ?? update.preview?.holdSeconds,
  })
}

export async function markPreviewLeaseReleased(leaseFile: string | undefined, status: "released" | "expired" = "released"): Promise<void> {
  if (!leaseFile) {
    return
  }
  const existing = await readPreviewLeaseOptional(leaseFile)
  if (!existing) {
    return
  }
  await updatePreviewLease(leaseFile, { status })
}

export async function markPreviewLeaseFailed(leaseFile: string | undefined, error: unknown): Promise<void> {
  if (!leaseFile) {
    return
  }
  const existing = await readPreviewLeaseOptional(leaseFile)
  if (!existing) {
    return
  }
  await updatePreviewLease(leaseFile, { status: "failed", error: serializeLeaseError(error) })
}

export async function runPreviewLeaseStatusCommand(args: string[]): Promise<number> {
  const options = parsePreviewLeaseLookupOptions(args)
  const lease = await readPreviewLease(await resolvePreviewLeaseFileFromLookup(options))
  printPreviewLeaseOutput(await refreshPreviewLeaseStatus(lease), options.json)
  return 0
}

export async function runPreviewLeaseReleaseCommand(args: string[]): Promise<number> {
  const options = parsePreviewLeaseLookupOptions(args)
  const leaseFile = await resolvePreviewLeaseFileFromLookup(options)
  const lease = await readPreviewLease(leaseFile)
  if (lease.runId) {
    await new RuntimeRunRegistry(lease.registryDirectory).requestCancellation(lease.runId, { reason: `preview lease ${lease.leaseId} released` })
  }
  const released = await updatePreviewLease(leaseFile, { status: "release_requested" })
  printPreviewLeaseOutput(released, options.json)
  return 0
}

function withoutPreviewLeaseFlag(args: string[]): string[] {
  return args.filter((arg) => arg !== "--preview-lease")
}

async function waitForPreviewLease(leaseFile: string, pid: number | undefined): Promise<PreviewLeaseMetadata> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < PREVIEW_LEASE_READY_TIMEOUT_MS) {
    const lease = await readPreviewLease(leaseFile)
    if (lease.status !== "starting") {
      return refreshPreviewLeaseStatus(lease)
    }
    if (pid && !isProcessAlive(pid)) {
      return updatePreviewLease(leaseFile, { status: "failed", error: { name: "PreviewLeaseChildExited", message: "Preview lease child exited before publishing a preview URL." } })
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return updatePreviewLease(leaseFile, { status: "failed", error: { name: "PreviewLeaseTimeout", message: "Timed out waiting for preview lease child to publish a preview URL." } })
}

async function refreshPreviewLeaseStatus(lease: PreviewLeaseMetadata): Promise<PreviewLeaseMetadata> {
  if (lease.status !== "available" || !lease.expiresAt) {
    return lease
  }
  if (Date.parse(lease.expiresAt) <= Date.now()) {
    return updatePreviewLease(lease.leaseFile, { status: "expired" })
  }
  return lease
}

async function resolvePreviewLeaseRegistryDirectory(options: PreviewLeaseStartOptions): Promise<string> {
  if (options.runRegistryDirectory) {
    return resolve(options.runRegistryDirectory)
  }
  if (options.artifactsDirectory) {
    return defaultRunRegistryDirectory(options.artifactsDirectory)
  }
  const recipe = await loadWorkspaceRecipe(resolve(options.recipePath))
  return defaultRunRegistryDirectory(recipe.artifacts?.directory)
}

function previewLeaseFile(registryDirectory: string, leaseId: string): string {
  return join(resolve(registryDirectory), "preview-leases", `${leaseId}.json`)
}

async function resolvePreviewLeaseFileFromLookup(options: PreviewLeaseLookupOptions): Promise<string> {
  if (options.leaseFile) {
    return resolve(options.leaseFile)
  }
  if (!options.registryDirectory || !options.leaseId) {
    throw new Error("Missing required preview lease lookup options: pass --lease-file or both --registry and --lease-id")
  }
  return previewLeaseFile(options.registryDirectory, options.leaseId)
}

async function readPreviewLease(file: string): Promise<PreviewLeaseMetadata> {
  return JSON.parse(await readFile(file, "utf8")) as PreviewLeaseMetadata
}

async function readPreviewLeaseOptional(file: string): Promise<PreviewLeaseMetadata | undefined> {
  try {
    return await readPreviewLease(file)
  } catch {
    return undefined
  }
}

async function updatePreviewLease(file: string, update: Partial<PreviewLeaseMetadata>): Promise<PreviewLeaseMetadata> {
  const current = await readPreviewLease(file)
  return writePreviewLease({ ...current, ...stripUndefined(update), updatedAt: new Date().toISOString() })
}

async function writePreviewLease(lease: PreviewLeaseMetadata): Promise<PreviewLeaseMetadata> {
  await mkdir(dirname(lease.leaseFile), { recursive: true })
  const temp = join(dirname(lease.leaseFile), `.${lease.leaseId}.${process.pid}.tmp`)
  await writeFile(temp, `${JSON.stringify(lease, null, 2)}\n`)
  await rename(temp, lease.leaseFile)
  return lease
}

function parsePreviewLeaseLookupOptions(args: string[]): PreviewLeaseLookupOptions {
  const options: Partial<PreviewLeaseLookupOptions> = { json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--json") {
      options.json = true
      continue
    }
    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]
    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }
    switch (name) {
      case "--lease-id":
        options.leaseId = value
        break
      case "--lease-file":
        options.leaseFile = value
        break
      case "--registry":
      case "--run-registry":
        options.registryDirectory = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }
  return options as PreviewLeaseLookupOptions
}

function printPreviewLeaseOutput(lease: PreviewLeaseMetadata, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(lease, null, 2)}\n`)
    return
  }
  console.log(`WP Codebox preview lease: ${lease.leaseId}`)
  console.log(`Status: ${lease.status}`)
  if (lease.preview?.reviewerAccess?.openUrl) {
    console.log(`Preview URL: ${lease.preview.reviewerAccess.openUrl}`)
  } else if (lease.preview?.url) {
    console.log(`Preview URL: ${lease.preview.url}`)
  }
  if (lease.expiresAt) {
    console.log(`Expires at: ${lease.expiresAt}`)
  }
  console.log(`Status command: ${lease.statusCommand.join(" ")}`)
  console.log(`Release command: ${lease.releaseCommand.join(" ")}`)
}

function previewLeaseReleaseCommand(registryDirectory: string, leaseId: string): string[] {
  return ["wp-codebox", "preview-lease", "release", "--registry", registryDirectory, "--lease-id", leaseId]
}

function previewLeaseStatusCommand(registryDirectory: string, leaseId: string): string[] {
  return ["wp-codebox", "preview-lease", "status", "--registry", registryDirectory, "--lease-id", leaseId]
}

function createPreviewLeaseId(): string {
  return `lease_${randomUUID().replaceAll("-", "")}`
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function serializeLeaseError(error: unknown): PreviewLeaseMetadata["error"] {
  if (error instanceof Error) {
    return stripUndefined({ name: error.name, message: error.message, code: (error as Error & { code?: string }).code })
  }
  return { name: "Error", message: String(error) }
}
