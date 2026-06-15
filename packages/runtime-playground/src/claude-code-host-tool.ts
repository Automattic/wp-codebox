import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { HostToolDefinition, JsonObject, JsonValue } from "@automattic/wp-codebox-core"

export interface ClaudeCodeHostToolConfig {
  command?: string
  args?: string[]
  cwd: string
  allowedCwdRoots?: string[]
  timeoutMs?: number
  maxOutputBytes?: number
  inheritedEnv?: string[]
  env?: Record<string, string>
}

interface ClaudeCodeRunInput {
  prompt: string
  cwd?: string
  model?: string
  maxTurns?: number
  timeoutMs?: number
}

const DEFAULT_CLAUDE_CODE_COMMAND = "claude"
const DEFAULT_CLAUDE_CODE_ARGS = ["--print", "--output-format", "json"]
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_SAFE_INHERITED_ENV = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]

export function createClaudeCodeHostTool(config: ClaudeCodeHostToolConfig): HostToolDefinition {
  return {
    declaration: {
      name: "claude_code/run",
      source: "claude_code",
      description: "Run Claude Code through the host-owned authenticated CLI without serializing auth material into the sandbox recipe.",
      parameters: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          cwd: { type: "string" },
          model: { type: "string" },
          maxTurns: { type: "integer" },
          timeoutMs: { type: "integer" },
        },
        additionalProperties: false,
      },
      executor: "client",
      scope: "run",
      runtime: {
        environment: "host",
        capability_scope: "host",
        auth: "host-owned",
        secrets: "none-in-recipe",
      },
    },
    name: "claude_code/run",
    description: "Run Claude Code through the host-owned authenticated CLI without serializing auth material into the sandbox recipe.",
    outputSchema: {
      type: "object",
      required: ["command", "cwd", "exitCode", "signal", "stdout", "stderr", "durationMs", "timedOut", "outputTruncated"],
      properties: {
        command: { type: "string" },
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
      capability: "claude_code/run",
      permissions: ["host-command", "host-authenticated-claude-code"],
      risk: "external",
      description: "Executes only the configured host Claude Code command. Auth/session state stays on the host and caller input cannot provide env vars.",
    },
    runtime: {
      environment: "host",
      capability_scope: "host",
      auth: "host-owned",
      secrets: "none-in-recipe",
    },
    handler: (input) => executeClaudeCode(config, normalizeClaudeCodeRunInput(input)),
  }
}

async function executeClaudeCode(config: ClaudeCodeHostToolConfig, input: ClaudeCodeRunInput): Promise<JsonObject> {
  const started = Date.now()
  const cwd = await resolveAllowedCwd(config, input.cwd)
  const command = config.command ?? DEFAULT_CLAUDE_CODE_COMMAND
  const args = claudeCodeArgs(config, input)
  const timeoutMs = boundedPositiveInteger(input.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs")
  const maxOutputBytes = boundedPositiveInteger(config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes")
  const env = claudeCodeEnv(config)

  return new Promise<JsonObject>((resolveResult, reject) => {
    let stdout = ""
    let stderr = ""
    let outputTruncated = false
    let timedOut = false
    let settled = false

    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)

    child.stdin.end(input.prompt)

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
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on("close", (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({
        command,
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

function claudeCodeArgs(config: ClaudeCodeHostToolConfig, input: ClaudeCodeRunInput): string[] {
  const args = [...(config.args ?? DEFAULT_CLAUDE_CODE_ARGS)]
  if (input.model) {
    args.push("--model", input.model)
  }
  if (input.maxTurns !== undefined) {
    args.push("--max-turns", String(input.maxTurns))
  }
  return args
}

function claudeCodeEnv(config: ClaudeCodeHostToolConfig): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...config.env,
  }
  for (const name of config.inheritedEnv ?? DEFAULT_SAFE_INHERITED_ENV) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name]
    }
  }
  return env
}

function normalizeClaudeCodeRunInput(input: JsonValue): ClaudeCodeRunInput {
  if (!isJsonObject(input)) {
    throw new Error("claude_code/run input must be an object")
  }
  return {
    prompt: stringValue(input.prompt, "prompt"),
    cwd: input.cwd === undefined ? undefined : stringValue(input.cwd, "cwd"),
    model: input.model === undefined ? undefined : stringValue(input.model, "model"),
    maxTurns: input.maxTurns === undefined ? undefined : boundedPositiveInteger(input.maxTurns, "maxTurns"),
    timeoutMs: input.timeoutMs === undefined ? undefined : boundedPositiveInteger(input.timeoutMs, "timeoutMs"),
  }
}

async function resolveAllowedCwd(config: ClaudeCodeHostToolConfig, requestedCwd?: string): Promise<string> {
  const cwd = await realpath(resolve(requestedCwd ?? config.cwd))
  const allowedRoots = await Promise.all((config.allowedCwdRoots?.length ? config.allowedCwdRoots : [config.cwd]).map((root) => realpath(resolve(root))))
  if (!allowedRoots.some((root) => cwd === root || cwd.startsWith(`${root}/`))) {
    throw new Error(`claude_code/run cwd is outside allowed roots: ${cwd}`)
  }
  return cwd
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
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
