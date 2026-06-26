import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { cleanWpCliOutput, shellArgv } from "./commands.js"
import { closeHttpServer, listenLocalHttpServer, readBridgeJson, writeBridgeJson, type PlaygroundServerRunResponse } from "./preview-server.js"

export interface RuntimeWpCliBridge {
  url: string
  token: string
  close: () => Promise<void>
}

interface RuntimeWpCliCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface RuntimeHostNodeCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  error: string
}

type RuntimeWpCliRunner = (argv: string[]) => Promise<PlaygroundServerRunResponse>

export async function createRuntimeWpCliBridge(runWpCliCommand: RuntimeWpCliRunner): Promise<RuntimeWpCliBridge> {
  const token = randomBytes(24).toString("base64url")
  const bridge = createHttpServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/execute") {
        writeBridgeJson(response, 404, { success: false, error: "not_found" })
        return
      }

      if (request.headers.authorization !== `Bearer ${token}`) {
        writeBridgeJson(response, 403, { success: false, error: "forbidden" })
        return
      }

      const action = await readBridgeJson(request)
      const type = typeof action.type === "string" ? action.type.trim() : ""
      const command = typeof action.command === "string" ? action.command.trim() : ""
      if (type === "host_node") {
        const started = Date.now()
        const args = Array.isArray(action.args) ? action.args.filter((arg): arg is string => typeof arg === "string") : []
        const env = action.env && typeof action.env === "object" && !Array.isArray(action.env) ? normalizeHostNodeEnv(action.env as Record<string, unknown>) : {}
        const cwd = typeof action.cwd === "string" && action.cwd.trim() !== "" ? action.cwd.trim() : undefined
        const result = await runRuntimeHostNodeBridgeCommand(args, env, cwd)
        const exitCode = result.exitCode
        writeBridgeJson(response, 200, {
          type,
          command: "node",
          args,
          exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          success: exitCode === 0,
          timedOut: false,
          durationMs: Date.now() - started,
          error: exitCode === 0 ? "" : (result.error || result.stderr.trim() || result.stdout.trim() || "host node command failed"),
        })
        return
      }

      if (type !== "wp_cli" || command === "") {
        writeBridgeJson(response, 400, { success: false, error: "wp_cli command is required" })
        return
      }

      const started = Date.now()
      const result = await runRuntimeWpCliBridgeCommand(runWpCliCommand, command)
      const exitCode = result.exitCode
      writeBridgeJson(response, 200, {
        type,
        command: command.startsWith("wp ") ? command : `wp ${command}`,
        exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        success: exitCode === 0,
        timedOut: false,
        durationMs: Date.now() - started,
        error: exitCode === 0 ? "" : (result.stderr.trim() || result.stdout.trim() || "WP-CLI command failed"),
      })
    } catch (error) {
      writeBridgeJson(response, 500, { success: false, error: errorMessage(error) })
    }
  })

  const url = await listenLocalHttpServer(bridge)
  return {
    url,
    token,
    close: () => closeHttpServer(bridge),
  }
}

async function runRuntimeHostNodeBridgeCommand(args: string[], env: Record<string, string>, cwd?: string): Promise<RuntimeHostNodeCommandResult> {
  if (args.length === 0) {
    throw new Error("host_node args are required")
  }

  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    const execPath = process.execPath
    const nodeCommand = existsSync(execPath) ? execPath : "node"
    const child = spawn(nodeCommand, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error: NodeJS.ErrnoException) => {
      const diagnostic = nodeCommand === "node"
        ? `Host Node executable was unavailable: process.execPath (${execPath}) does not exist and node was not found on PATH. Update the WP Codebox runner PATH or restart the runner with a valid Node installation. ${error.message}`
        : `Host Node executable could not be started from process.execPath (${nodeCommand}). Restart the WP Codebox runner with a valid Node installation. ${error.message}`
      resolve({ exitCode: 127, stdout, stderr, error: diagnostic })
    })
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, error: "" })
    })
  })
}

function normalizeHostNodeEnv(env: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      normalized[name] = typeof value === "string" ? value : String(value)
    }
  }
  return normalized
}

async function runRuntimeWpCliBridgeCommand(runWpCliCommand: RuntimeWpCliRunner, command: string): Promise<RuntimeWpCliCommandResult> {
  const commands = runtimeWpCliCommandArgv(command)
  if (commands.length === 0) {
    throw new Error("wp_cli command is required")
  }

  let stdout = ""
  let stderr = ""
  let exitCode = 0
  for (const argv of commands) {
    const result = await runWpCliCommand(argv)
    exitCode = result.exitCode ?? 0
    stdout += cleanWpCliOutput(result.text)
    stderr += result.errors ?? ""
    if (exitCode !== 0) {
      break
    }
  }

  return { exitCode, stdout, stderr }
}

function runtimeWpCliCommandArgv(command: string): string[][] {
  const tokens = shellArgv(command)
  const commands: string[][] = []
  let current: string[] = []

  for (const token of tokens) {
    if (token === "&&" || token === ";" || token === "||") {
      if (current.length > 0) {
        commands.push(runtimeWpCliNormalizeArgv(current))
        current = []
      }
      if (token === "||") {
        break
      }
      continue
    }

    if (token === "|") {
      break
    }

    current.push(token)
  }

  if (current.length > 0) {
    commands.push(runtimeWpCliNormalizeArgv(current))
  }

  return commands.filter((argv) => argv.length > 0)
}

function runtimeWpCliNormalizeArgv(argv: string[]): string[] {
  return argv[0] === "wp" ? argv.slice(1) : argv
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
