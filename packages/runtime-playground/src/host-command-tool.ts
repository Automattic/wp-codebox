import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { assertRuntimeEnvName, normalizeRuntimeEnvRecord, type HostToolDefinition, type JsonObject, type JsonValue } from "@automattic/wp-codebox-core"

export interface HostCommandToolConfig {
  name: string
  description: string
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

interface HostCommandInput {
  args?: string[]
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024

export function createHostCommandTool(config: HostCommandToolConfig): HostToolDefinition {
  return {
    name: config.name,
    description: config.description,
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "integer" },
        env: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["command", "args", "cwd", "exitCode", "signal", "stdout", "stderr", "durationMs", "timedOut", "outputTruncated"],
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        exitCode: { type: "integer" },
        signal: { type: "string" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        durationMs: { type: "integer" },
        timedOut: { type: "boolean" },
        outputTruncated: { type: "boolean" },
      },
      additionalProperties: false,
    },
    policy: {
      capability: config.name,
      permissions: ["host-command"],
      risk: "external",
      description: "Runs one explicitly registered host command without shell expansion.",
    },
    handler: (input) => executeHostCommandTool(config, normalizeHostCommandInput(input)),
  }
}

async function executeHostCommandTool(config: HostCommandToolConfig, input: HostCommandInput): Promise<JsonObject> {
  const started = Date.now()
  const cwd = await resolveAllowedCwd(config, input.cwd)
  const timeoutMs = boundedPositiveInteger(input.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs")
  const maxOutputBytes = boundedPositiveInteger(config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes")
  const args = [...(config.args ?? []), ...(input.args ?? [])]
  const env = commandEnv(config, input.env ?? {})

  return new Promise<JsonObject>((resolveResult, reject) => {
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
      const captured = appendBoundedOutput(stdout, chunk, maxOutputBytes)
      stdout = captured.output
      outputTruncated ||= captured.truncated
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      const captured = appendBoundedOutput(stderr, chunk, maxOutputBytes)
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

function normalizeHostCommandInput(input: JsonValue): HostCommandInput {
  if (!isJsonObject(input)) {
    throw new Error("host command input must be an object")
  }
  return {
    args: input.args === undefined ? undefined : stringArray(input.args, "args"),
    cwd: input.cwd === undefined ? undefined : stringValue(input.cwd, "cwd"),
    timeoutMs: input.timeoutMs === undefined ? undefined : boundedPositiveInteger(input.timeoutMs, "timeoutMs"),
    env: input.env === undefined ? undefined : normalizeRuntimeEnvRecord(stringRecord(input.env, "env"), { field: "env" }),
  }
}

async function resolveAllowedCwd(config: HostCommandToolConfig, requestedCwd?: string): Promise<string> {
  const cwd = await realpath(resolve(requestedCwd ?? config.cwd))
  const allowedRoots = await Promise.all((config.allowedCwdRoots?.length ? config.allowedCwdRoots : [config.cwd]).map((root) => realpath(resolve(root))))
  if (!allowedRoots.some((root) => cwd === root || cwd.startsWith(`${root}/`))) {
    throw new Error(`host command cwd is outside allowed roots: ${cwd}`)
  }
  return cwd
}

function commandEnv(config: HostCommandToolConfig, inputEnv: Record<string, string>): Record<string, string> {
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
  for (const [name, value] of Object.entries(inputEnv)) {
    if (!allowedInputEnv.has(name)) {
      throw new Error(`host command env is not allowed: ${name}`)
    }
    env[name] = value
  }
  return env
}

function appendBoundedOutput(current: string, chunk: Buffer, maxBytes: number): { output: string; truncated: boolean } {
  if (Buffer.byteLength(current) >= maxBytes) {
    return { output: current, truncated: true }
  }
  const next = current + chunk.toString("utf8")
  if (Buffer.byteLength(next) <= maxBytes) {
    return { output: next, truncated: false }
  }
  return { output: next.slice(0, maxBytes), truncated: true }
}

function boundedPositiveInteger(value: JsonValue | number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

function stringValue(value: JsonValue, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`)
  }
  return value
}

function stringArray(value: JsonValue, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value
}

function stringRecord(value: JsonValue, field: string): Record<string, string> {
  if (!isJsonObject(value)) {
    throw new Error(`${field} must be an object`)
  }
  const record: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`${field}.${key} must be a string`)
    }
    record[key] = item
  }
  return record
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
