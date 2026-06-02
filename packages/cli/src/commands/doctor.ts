import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { opendir, readFile, realpath, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

type HealthStatus = "ok" | "warning" | "error"

interface HealthCheck {
  id: string
  status: HealthStatus
  message: string
  details?: Record<string, unknown>
}

interface DoctorOptions {
  json: boolean
  cleanup: boolean
  staleAfterSeconds: number
  archiveRoots: string[]
}

interface DoctorOutput {
  schema: "wp-codebox/doctor/v1"
  status: HealthStatus
  cleanup: boolean
  staleAfterSeconds: number
  checks: HealthCheck[]
  summary: { ok: number; warning: number; error: number }
}

export async function runDoctorCommand(args: string[]): Promise<number> {
  const options = parseDoctorOptions(args, false)
  const output = await buildDoctorOutput(options)
  printDoctorOutput(output, options.json)
  return output.status === "error" ? 1 : 0
}

export async function runCleanupCommand(args: string[]): Promise<number> {
  const options = parseDoctorOptions(args, true)
  const output = await buildDoctorOutput(options)
  printDoctorOutput(output, options.json)
  return output.status === "error" ? 1 : 0
}

function parseDoctorOptions(args: string[], cleanup: boolean): DoctorOptions {
  let json = false
  let staleAfterSeconds = Number.parseInt(process.env.WP_CODEBOX_STALE_AFTER_SECONDS ?? process.env.HOMEBOY_WP_CODEBOX_STALE_AFTER_SECONDS ?? "3600", 10)
  const archiveRoots = archiveRootsFromEnv()

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--fix") {
      cleanup = true
      continue
    }
    if (arg === "--stale-after-seconds") {
      const value = args[++index]
      if (!value || !/^\d+$/.test(value)) {
        throw new Error("--stale-after-seconds requires an integer value")
      }
      staleAfterSeconds = Number.parseInt(value, 10)
      continue
    }
    if (arg === "--archive-root") {
      const value = args[++index]
      if (!value) {
        throw new Error("--archive-root requires a directory")
      }
      archiveRoots.push(value)
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  return {
    json,
    cleanup,
    staleAfterSeconds: Number.isFinite(staleAfterSeconds) ? staleAfterSeconds : 3600,
    archiveRoots,
  }
}

async function buildDoctorOutput(options: DoctorOptions): Promise<DoctorOutput> {
  const checks = [
    { id: "node", status: "ok" as const, message: "node is available", details: { path: process.execPath, version: process.version } },
    await commandToolCheck("npm", ["--version"]),
    await binaryCheck(),
    await sourceCheck(),
    await staleRecipeRunCheck(options),
    await archiveCheck(options),
  ]
  const summary = {
    ok: checks.filter((check) => check.status === "ok").length,
    warning: checks.filter((check) => check.status === "warning").length,
    error: checks.filter((check) => check.status === "error").length,
  }

  return {
    schema: "wp-codebox/doctor/v1",
    status: summary.error > 0 ? "error" : summary.warning > 0 ? "warning" : "ok",
    cleanup: options.cleanup,
    staleAfterSeconds: options.staleAfterSeconds,
    checks,
    summary,
  }
}

async function commandToolCheck(id: string, args: string[]): Promise<HealthCheck> {
  try {
    const { stdout } = await execFile(id, args)
    return { id, status: "ok", message: `${id} is available`, details: { version: stdout.trim() } }
  } catch (error) {
    return { id, status: id === "npm" ? "warning" : "error", message: `${id} is not available`, details: { error: errorMessage(error) } }
  }
}

async function binaryCheck(): Promise<HealthCheck> {
  const path = await realpath(process.argv[1] ?? "").catch(() => process.argv[1] ?? "")
  if (!path || !existsSync(path)) {
    return { id: "wp-codebox.binary", status: "error", message: "wp-codebox binary could not be resolved", details: { path } }
  }
  return { id: "wp-codebox.binary", status: "ok", message: "wp-codebox binary resolved", details: { path, sha256: await sha256File(path).catch(() => undefined) } }
}

async function sourceCheck(): Promise<HealthCheck> {
  const binaryPath = await realpath(process.argv[1] ?? "").catch(() => process.argv[1] ?? "")
  const root = await findPackageRoot(binaryPath)
  if (!root) {
    return { id: "wp-codebox.source", status: "warning", message: "package root not found for wp-codebox binary", details: { binaryPath } }
  }
  return {
    id: "wp-codebox.source",
    status: "ok",
    message: "wp-codebox source resolved",
    details: { packageRoot: root, packageJsonSha256: await sha256File(join(root, "package.json")).catch(() => undefined), gitHead: await gitHead(root) },
  }
}

async function staleRecipeRunCheck(options: DoctorOptions): Promise<HealthCheck> {
  const rows = await processRows()
  const recipeRuns = rows.filter((row) => isRecipeRunCommand(row.command))
  const stale = recipeRuns.filter((row) => row.pid !== process.pid && row.ageSeconds >= options.staleAfterSeconds)
  const terminated: Array<{ pid: number; signal: "SIGTERM"; ok: boolean; error?: string }> = []

  if (options.cleanup) {
    for (const row of stale) {
      try {
        process.kill(row.pid, "SIGTERM")
        terminated.push({ pid: row.pid, signal: "SIGTERM", ok: true })
      } catch (error) {
        terminated.push({ pid: row.pid, signal: "SIGTERM", ok: false, error: errorMessage(error) })
      }
    }
  }

  if (stale.length === 0) {
    return { id: "wp-codebox.processes", status: "ok", message: recipeRuns.length > 0 ? `recipe-run processes found, none older than ${options.staleAfterSeconds}s` : "no recipe-run processes found", details: { recipeRunCount: recipeRuns.length, staleCount: 0 } }
  }

  return {
    id: "wp-codebox.processes",
    status: options.cleanup && terminated.every((row) => row.ok) ? "ok" : "warning",
    message: options.cleanup ? `terminated ${terminated.filter((row) => row.ok).length}/${stale.length} stale recipe-run process(es)` : `${stale.length} stale recipe-run process(es) found`,
    details: { stale: stale.map((row) => ({ pid: row.pid, ageSeconds: row.ageSeconds, command: row.command })), terminated },
  }
}

async function archiveCheck(options: DoctorOptions): Promise<HealthCheck> {
  const roots = unique([...options.archiveRoots, ...defaultArchiveRoots()].map((root) => resolve(root)))
  const existingRoots = roots.filter((root) => existsSync(root))
  let checked = 0
  const invalid: Array<{ path: string; size: number; reason: string; deleted: boolean; error?: string }> = []

  for (const root of existingRoots) {
    for await (const archivePath of walkArchiveFiles(root)) {
      checked++
      const archiveStat = await stat(archivePath)
      const reason = await invalidZipReason(archivePath, archiveStat.size)
      if (!reason) {
        continue
      }

      const row = { path: archivePath, size: archiveStat.size, reason, deleted: false }
      if (options.cleanup) {
        try {
          await unlink(archivePath)
          row.deleted = true
        } catch (error) {
          invalid.push({ ...row, error: errorMessage(error) })
          continue
        }
      }
      invalid.push(row)
    }
  }

  if (existingRoots.length === 0) {
    return { id: "wp-codebox.archives", status: "ok", message: "no known WP Codebox/Playground archive roots found", details: { roots, existingRoots, checked: 0, invalid: [] } }
  }
  if (invalid.length === 0) {
    return { id: "wp-codebox.archives", status: "ok", message: `checked ${checked} archive(s); no invalid archives found`, details: { roots, existingRoots, checked, invalid } }
  }
  return {
    id: "wp-codebox.archives",
    status: options.cleanup && invalid.every((row) => row.deleted) ? "ok" : "warning",
    message: options.cleanup ? `removed ${invalid.filter((row) => row.deleted).length}/${invalid.length} invalid archive(s)` : `${invalid.length} invalid archive(s) found`,
    details: { roots, existingRoots, checked, invalid },
  }
}

function printDoctorOutput(output: DoctorOutput, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return
  }
  console.log(`WP Codebox ${output.cleanup ? "cleanup" : "doctor"}: ${output.status}`)
  for (const check of output.checks) {
    console.log(`[${check.status}] ${check.id}: ${check.message}`)
  }
}

function archiveRootsFromEnv(): string[] {
  return (process.env.WP_CODEBOX_ARCHIVE_ROOTS ?? process.env.HOMEBOY_WP_CODEBOX_ARCHIVE_ROOTS ?? "").split(":").map((root) => root.trim()).filter(Boolean)
}

function defaultArchiveRoots(): string[] {
  return [join(homedir(), ".cache", "wp-codebox"), join(homedir(), ".wp-codebox"), join(homedir(), ".cache", "wordpress-playground"), join(homedir(), ".wordpress-playground")]
}

async function findPackageRoot(start: string): Promise<string | undefined> {
  let directory = dirname(start)
  while (directory && directory !== dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) {
      return directory
    }
    directory = dirname(directory)
  }
  return undefined
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  hash.update(await readFile(path))
  return hash.digest("hex")
}

async function gitHead(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

interface ProcessRow { pid: number; ageSeconds: number; command: string }

async function processRows(): Promise<ProcessRow[]> {
  try {
    const { stdout } = await execFile("ps", ["-axo", "pid=,etimes=,command="])
    return stdout.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      return match ? [{ pid: Number.parseInt(match[1] ?? "0", 10), ageSeconds: Number.parseInt(match[2] ?? "0", 10), command: match[3] ?? "" }] : []
    })
  } catch {
    return []
  }
}

function isRecipeRunCommand(command: string): boolean {
  return (/wp-codebox/.test(command) && /recipe-run/.test(command)) || /homeboy-wp-codebox-task-runner/.test(command)
}

async function* walkArchiveFiles(root: string): AsyncGenerator<string> {
  const entries = await opendir(root).catch(() => undefined)
  if (!entries) {
    return
  }
  for await (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      yield* walkArchiveFiles(path)
    } else if (entry.isFile() && (entry.name.endsWith(".zip") || entry.name.endsWith(".zip.tmp"))) {
      yield path
    }
  }
}

async function invalidZipReason(path: string, size: number): Promise<string | undefined> {
  if (size < 22) {
    return "too small to be a zip archive"
  }
  const header = (await readFile(path)).subarray(0, 4)
  if (header.length < 4) {
    return "missing zip header"
  }
  if (header[0] !== 0x50 || header[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(header[2] ?? 0)) {
    return `unexpected zip header ${header.toString("hex")}`
  }
  return undefined
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function execFile(command: string, args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveExec, rejectExec) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.once("error", rejectExec)
    child.once("close", (code) => {
      const output = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
      code === 0 ? resolveExec(output) : rejectExec(new Error(output.stderr.trim() || `${command} exited with status ${code}`))
    })
  })
}
