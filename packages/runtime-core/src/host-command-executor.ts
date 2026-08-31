import { spawn } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, realpath, stat, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { assertRuntimeEnvName, normalizeRuntimeEnvRecord } from "./runtime-env.js"
import type { JsonObject, JsonValue } from "./host-tool-registry.js"

export interface HostCommandExecutorConfig {
  command: string
  args?: string[]
  cwd: string
  allowedCwdRoots?: string[]
  timeoutMs?: number
  maxOutputBytes?: number
  artifactsDirectory?: string
  memorySampleIntervalMs?: number
  terminationGraceMs?: number
  inheritedEnv?: string[]
  allowedInputEnv?: string[]
  env?: Record<string, string>
}

export interface HostCommandExecutorInput {
  args?: string[]
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export type HostCommandFailureClassification = "none" | "timeout" | "non_zero_exit" | "signal"

export type HostCommandMemorySample = JsonObject & {
  elapsedMs: number
  rssBytes: number
}

export type HostCommandArtifact = JsonObject & {
  path: string
  bytes: number
}

export type HostCommandArtifacts = JsonObject & {
  stdout?: HostCommandArtifact
  stderr?: HostCommandArtifact
  summary?: HostCommandArtifact
}

export type HostCommandExecutorResult = JsonObject & {
  command: string
  args: string[]
  cwd: string
  exitCode: number
  signal: string
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  outputTruncated: boolean
  failureClassification: HostCommandFailureClassification
  commandSummary: string
  memorySamples: HostCommandMemorySample[]
  peakRssBytes: number
  artifacts?: HostCommandArtifacts
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_MEMORY_SAMPLE_INTERVAL_MS = 1_000
const DEFAULT_TERMINATION_GRACE_MS = 5_000

export async function executeHostCommand(config: HostCommandExecutorConfig, input: HostCommandExecutorInput = {}): Promise<HostCommandExecutorResult> {
  const started = Date.now()
  const cwd = await resolveAllowedHostCommandCwd(config, input.cwd)
  const timeoutMs = boundedHostCommandPositiveInteger(input.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs")
  const maxOutputBytes = boundedHostCommandPositiveInteger(config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes")
  const memorySampleIntervalMs = boundedHostCommandPositiveInteger(config.memorySampleIntervalMs ?? DEFAULT_MEMORY_SAMPLE_INTERVAL_MS, "memorySampleIntervalMs")
  const terminationGraceMs = boundedHostCommandPositiveInteger(config.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS, "terminationGraceMs")
  const args = [...(config.args ?? []), ...(input.args ?? [])]
  const env = hostCommandEnv(config, input.env ?? {})
  const commandSummary = summarizeHostCommand(config.command, args)
  const artifactWriters = config.artifactsDirectory ? await createHostCommandArtifactWriters(config.artifactsDirectory) : undefined

  return new Promise<HostCommandExecutorResult>((resolveResult, reject) => {
    let stdout = ""
    let stderr = ""
    let outputTruncated = false
    let timedOut = false
    let settled = false
    const memorySamples: HostCommandMemorySample[] = []
    const memorySampleTasks = new Set<Promise<void>>()

    const child = spawn(config.command, args, {
      cwd,
      env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const timer = setTimeout(() => {
      timedOut = true
      terminateHostCommandProcessTree(child.pid, "SIGTERM")
      setTimeout(() => terminateHostCommandProcessTree(child.pid, "SIGKILL"), terminationGraceMs).unref()
    }, timeoutMs)

    const sampleMemory = () => {
      if (child.pid === undefined) {
        return
      }
      const task = sampleHostCommandProcessTreeRssBytes(child.pid).then((rssBytes) => {
        if (rssBytes !== undefined) {
          memorySamples.push({ elapsedMs: Date.now() - started, rssBytes })
        }
      }).catch(() => undefined)
      memorySampleTasks.add(task)
      void task.finally(() => memorySampleTasks.delete(task))
    }
    sampleMemory()
    const memoryTimer = setInterval(sampleMemory, memorySampleIntervalMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      artifactWriters?.stdout.write(chunk)
      const captured = appendBoundedHostCommandOutput(stdout, chunk, maxOutputBytes)
      stdout = captured.output
      outputTruncated ||= captured.truncated
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      artifactWriters?.stderr.write(chunk)
      const captured = appendBoundedHostCommandOutput(stderr, chunk, maxOutputBytes)
      stderr = captured.output
      outputTruncated ||= captured.truncated
    })

    child.on("error", (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearInterval(memoryTimer)
      void closeHostCommandArtifactWriters(artifactWriters).catch(() => undefined)
      reject(error)
    })

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearInterval(memoryTimer)
      void Promise.all([...memorySampleTasks]).then(async () => {
        const durationMs = Date.now() - started
        const result: HostCommandExecutorResult = {
          command: config.command,
          args,
          cwd,
          exitCode: exitCode ?? -1,
          signal: signal ?? "",
          stdout,
          stderr,
          durationMs,
          timedOut,
          outputTruncated,
          failureClassification: classifyHostCommandFailure(exitCode, signal, timedOut),
          commandSummary,
          memorySamples,
          peakRssBytes: memorySamples.reduce((peak, sample) => Math.max(peak, sample.rssBytes), 0),
        }
        const artifacts = await finalizeHostCommandArtifacts(artifactWriters, result)
        resolveResult(artifacts ? { ...result, artifacts } : result)
      }).catch(reject)
    })
  })
}

export async function resolveAllowedHostCommandCwd(config: Pick<HostCommandExecutorConfig, "cwd" | "allowedCwdRoots">, requestedCwd?: string): Promise<string> {
  const cwd = await realpath(resolve(requestedCwd ?? config.cwd))
  const allowedRoots = await Promise.all((config.allowedCwdRoots?.length ? config.allowedCwdRoots : [config.cwd]).map((root) => realpath(resolve(root))))
  if (!allowedRoots.some((root) => isSamePathOrChild(cwd, root))) {
    throw new Error(`host command cwd is outside allowed roots: ${cwd}`)
  }
  return cwd
}

export function hostCommandEnv(config: Pick<HostCommandExecutorConfig, "env" | "inheritedEnv" | "allowedInputEnv">, inputEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...normalizeRuntimeEnvRecord(config.env ?? {}, { field: "config.env" }),
  }
  for (const name of config.inheritedEnv ?? []) {
    const normalized = name.trim()
    assertRuntimeEnvName(normalized, "config.inheritedEnv")
    if (process.env[normalized] !== undefined) {
      env[normalized] = process.env[normalized]
    }
  }
  const allowedInputEnv = new Set(config.allowedInputEnv ?? [])
  for (const name of allowedInputEnv) {
    assertRuntimeEnvName(name, "config.allowedInputEnv")
  }
  for (const [name, value] of Object.entries(inputEnv)) {
    assertRuntimeEnvName(name, "input.env")
    if (!allowedInputEnv.has(name)) {
      throw new Error(`host command env is not allowed: ${name}`)
    }
    env[name] = value
  }
  return env
}

export function appendBoundedHostCommandOutput(current: string, chunk: Buffer, maxBytes: number): { output: string; truncated: boolean } {
  if (Buffer.byteLength(current) >= maxBytes) {
    return { output: current, truncated: true }
  }
  const next = current + chunk.toString("utf8")
  if (Buffer.byteLength(next) <= maxBytes) {
    return { output: next, truncated: false }
  }
  return { output: next.slice(0, maxBytes), truncated: true }
}

export function classifyHostCommandFailure(exitCode: number | null, signal: NodeJS.Signals | null, timedOut: boolean): HostCommandFailureClassification {
  if (timedOut) {
    return "timeout"
  }
  if (signal) {
    return "signal"
  }
  if ((exitCode ?? 0) !== 0) {
    return "non_zero_exit"
  }
  return "none"
}

export function summarizeHostCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ")
}

function terminateHostCommandProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // The process may already be gone by the time cleanup runs.
    }
  }
}

async function sampleHostCommandProcessTreeRssBytes(pid: number): Promise<number | undefined> {
  const output = await readProcessOutput("ps", ["-o", "rss=", "-g", String(pid)])
  const rssKilobytes = output.split(/\s+/).filter(Boolean).reduce((total, value) => {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? total + parsed : total
  }, 0)
  return rssKilobytes > 0 ? rssKilobytes * 1024 : undefined
}

async function readProcessOutput(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] })
    let output = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", () => resolveOutput(output))
  })
}

interface HostCommandArtifactWriters {
  stdout: WriteStream
  stderr: WriteStream
  stdoutPath: string
  stderrPath: string
  summaryPath: string
}

async function createHostCommandArtifactWriters(directory: string): Promise<HostCommandArtifactWriters> {
  await mkdir(directory, { recursive: true })
  const stdoutPath = resolve(directory, "stdout.log")
  const stderrPath = resolve(directory, "stderr.log")
  return {
    stdout: createWriteStream(stdoutPath),
    stderr: createWriteStream(stderrPath),
    stdoutPath,
    stderrPath,
    summaryPath: resolve(directory, "command-summary.json"),
  }
}

async function finalizeHostCommandArtifacts(writers: HostCommandArtifactWriters | undefined, result: HostCommandExecutorResult): Promise<HostCommandArtifacts | undefined> {
  if (!writers) {
    return undefined
  }
  await closeHostCommandArtifactWriters(writers)
  const summary = {
    schema: "wp-codebox/host-command-summary/v1",
    command: result.command,
    args: result.args,
    cwd: result.cwd,
    commandSummary: result.commandSummary,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    failureClassification: result.failureClassification,
    outputTruncated: result.outputTruncated,
    peakRssBytes: result.peakRssBytes,
    memorySamples: result.memorySamples,
  }
  await writeFile(writers.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  const [stdoutStat, stderrStat, summaryStat] = await Promise.all([
    stat(writers.stdoutPath),
    stat(writers.stderrPath),
    stat(writers.summaryPath),
  ])
  return {
    stdout: { path: writers.stdoutPath, bytes: stdoutStat.size },
    stderr: { path: writers.stderrPath, bytes: stderrStat.size },
    summary: { path: writers.summaryPath, bytes: summaryStat.size },
  }
}

async function closeHostCommandArtifactWriters(writers: HostCommandArtifactWriters | undefined): Promise<void> {
  if (!writers) {
    return
  }
  await Promise.all([closeWriteStream(writers.stdout), closeWriteStream(writers.stderr)])
}

async function closeWriteStream(stream: WriteStream): Promise<void> {
  if (stream.closed) {
    return
  }
  await new Promise<void>((resolveClose, reject) => {
    stream.on("error", reject)
    stream.end(resolveClose)
  })
}

function boundedHostCommandPositiveInteger(value: JsonValue | number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

function isSamePathOrChild(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
}
