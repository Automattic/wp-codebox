import { spawn } from "node:child_process"
import { wantsJsonOutput, writeJsonFailure } from "./output.js"

type CliCommandHandler = (args: string[]) => Promise<number>

const cliCommandRoutes = {
  boot: "boot",
  "validate-blueprint": "validateBlueprint",
  "materialize-replay-package": "materializeReplayPackage",
  "recipe-run": "recipeRun",
  "agent-task-run": "agentTaskRun",
  recipe: {
    validate: "recipeValidate",
    build: "recipeBuild",
  },
  "workspace-policy": {
    check: "workspacePolicyCheck",
  },
  artifacts: {
    verify: "artifactsVerify",
    "apply-preflight": "artifactsApplyPreflight",
    "browser-metrics": "artifactsBrowserMetrics",
    diagnostics: "artifactsDiagnostics",
    "transfer-verify": "artifactsTransferVerify",
    "transfer-probes": "artifactsTransferProbes",
    "export-links": "artifactsExportLinks",
    benchmark: "artifactsBenchmark",
    "discover-partial": "artifactsDiscoverPartial",
    "bench-results": "artifactsBenchResults",
    "bench-compare": "artifactsBenchCompare",
  },
  bench: {
    summarize: "benchSummarize",
    matrix: "benchMatrix",
    compare: "benchCompare",
  },
  runs: {
    status: "runsStatus",
    artifacts: "runsArtifacts",
  },
  target: {
    provision: "targetProvision",
  },
  mcp: {
    "render-client-configs": "mcpRenderClientConfigs",
  },
  commands: "commands",
  doctor: "doctor",
  cleanup: "cleanup",
  schema: {
    recipe: "recipeSchema",
  },
  run: "run",
} as const

type CliCommandRoutes = typeof cliCommandRoutes
type CliRoute = CliCommandRoutes[keyof CliCommandRoutes]
type RouteHandlerName<Route> = Route extends string ? Route : Route extends Record<string, infer HandlerName extends string> ? HandlerName : never
type CliCommandHandlerName = RouteHandlerName<CliRoute>

type CliCommandRouter = {
  printHelp(): void
} & Record<CliCommandHandlerName, CliCommandHandler>

function isCommandHandlerName(route: CliRoute): route is Extract<CliRoute, string> {
  return typeof route === "string"
}

function routeForCommand(command: string): CliRoute | undefined {
  return Object.prototype.hasOwnProperty.call(cliCommandRoutes, command) ? cliCommandRoutes[command as keyof CliCommandRoutes] : undefined
}

export async function routeCliCommand(argv: string[], router: CliCommandRouter): Promise<number> {
  const args = [...argv]
  const command = args.shift()

  const jspiRespawnExitCode = await maybeRespawnWithJspi(command, args)
  if (jspiRespawnExitCode !== undefined) {
    return jspiRespawnExitCode
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    router.printHelp()
    return command ? 0 : 1
  }

  const route = routeForCommand(command)
  if (!route) {
    if (wantsJsonOutput(argv)) {
      writeJsonFailure(command, `Unknown command: ${command}`, { code: "unknown-command" })
      return 1
    }
    console.error(`Unknown command: ${command}`)
    router.printHelp()
    return 1
  }

  if (isCommandHandlerName(route)) {
    return router[route](args)
  }

  const subcommand = args.shift()
  const handlerName = subcommand ? (route as Partial<Record<string, CliCommandHandlerName>>)[subcommand] : undefined
  if (!handlerName) {
    if (wantsJsonOutput(argv)) {
      writeJsonFailure(command, `Unknown ${command} command: ${subcommand ?? ""}`, { code: "unknown-subcommand", subcommand: subcommand ?? null })
      return 1
    }
    console.error(`Unknown ${command} command: ${subcommand ?? ""}`)
    router.printHelp()
    return 1
  }

  return router[handlerName](args)
}

async function maybeRespawnWithJspi(command: string | undefined, args: string[]): Promise<number | undefined> {
  if (!command || !["boot", "run", "recipe-run", "agent-task-run"].includes(command)) {
    return undefined
  }

  if (!shouldRespawnWithJspi()) {
    return undefined
  }

  const requiredFlags = ["--experimental-wasm-jspi", "--experimental-wasm-stack-switching"]
  const missingFlags = requiredFlags.filter((flag) => !process.execArgv.includes(flag))
  const child = spawn(process.execPath, [...missingFlags, ...process.execArgv, ...process.argv.slice(1, 2), command, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      WP_CODEBOX_JSPI_RESPAWNED: "1",
    },
  })

  let parentSignal: NodeJS.Signals | undefined
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  const forwardSignal = (signal: NodeJS.Signals): void => {
    parentSignal ??= signal
    child.kill(signal)
  }
  for (const signal of signals) {
    process.on(signal, forwardSignal)
  }

  try {
    const exit = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", reject)
      child.once("close", (status, signal) => resolveExit({ status, signal }))
    })

    const signal = exit.signal ?? parentSignal
    if (signal) {
      for (const forwardedSignal of signals) {
        process.off(forwardedSignal, forwardSignal)
      }
      process.kill(process.pid, signal)
      return 1
    }

    return exit.status ?? 1
  } catch {
    return undefined
  } finally {
    for (const signal of signals) {
      process.off(signal, forwardSignal)
    }
  }
}

function shouldRespawnWithJspi(): boolean {
  if (process.env.WP_CODEBOX_JSPI_RESPAWNED || process.env.WP_CODEBOX_NO_JSPI_RESPAWN || process.env.PLAYGROUND_NO_JSPI_RESPAWN) {
    return false
  }

  if ("Suspending" in WebAssembly) {
    return false
  }

  if (process.versions.bun || "Deno" in globalThis) {
    return false
  }

  if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 23) {
    return false
  }

  return !["--experimental-wasm-jspi", "--experimental-wasm-stack-switching"].every((flag) => process.execArgv.includes(flag))
}
