import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
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
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024

export async function executeHostCommand(config: HostCommandExecutorConfig, input: HostCommandExecutorInput = {}): Promise<HostCommandExecutorResult> {
  const started = Date.now()
  const cwd = await resolveAllowedHostCommandCwd(config, input.cwd)
  const timeoutMs = boundedHostCommandPositiveInteger(input.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs")
  const maxOutputBytes = boundedHostCommandPositiveInteger(config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes")
  const args = [...(config.args ?? []), ...(input.args ?? [])]
  const env = hostCommandEnv(config, input.env ?? {})

  return new Promise<HostCommandExecutorResult>((resolveResult, reject) => {
    let stdout = ""
    let stderr = ""
    let outputTruncated = false
    let timedOut = false
    let settled = false

    const child = spawn(config.command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      const captured = appendBoundedHostCommandOutput(stdout, chunk, maxOutputBytes)
      stdout = captured.output
      outputTruncated ||= captured.truncated
    })

    child.stderr?.on("data", (chunk: Buffer) => {
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
      reject(error)
    })

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolveResult({
        command: config.command,
        args,
        cwd,
        exitCode: exitCode ?? -1,
        signal: signal ?? "",
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        outputTruncated,
      })
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
