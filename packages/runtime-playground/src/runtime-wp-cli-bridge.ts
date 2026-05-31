import { randomBytes } from "node:crypto"
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
