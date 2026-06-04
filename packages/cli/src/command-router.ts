import { spawn } from "node:child_process"

type CliCommandHandler = (args: string[]) => Promise<number>

interface CliCommandRouter {
  printHelp(): void
  boot: CliCommandHandler
  validateBlueprint: CliCommandHandler
  recipeValidate: CliCommandHandler
  recipeBuild: CliCommandHandler
  recipeRun: CliCommandHandler
  agentTaskRun: CliCommandHandler
  workspacePolicyCheck: CliCommandHandler
  artifactsVerify: CliCommandHandler
  artifactsBrowserMetrics: CliCommandHandler
  artifactsBenchmark: CliCommandHandler
  artifactsBenchResults: CliCommandHandler
  benchSummarize: CliCommandHandler
  runsStatus: CliCommandHandler
  runsArtifacts: CliCommandHandler
  commands: CliCommandHandler
  recipeSchema: CliCommandHandler
  doctor: CliCommandHandler
  cleanup: CliCommandHandler
  run: CliCommandHandler
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

  switch (command) {
    case "boot":
      return router.boot(args)
    case "validate-blueprint":
      return router.validateBlueprint(args)
    case "recipe-run":
      return router.recipeRun(args)
    case "agent-task-run":
      return router.agentTaskRun(args)
    case "recipe": {
      const subcommand = args.shift()
      if (subcommand === "validate") {
        return router.recipeValidate(args)
      }
      if (subcommand === "build") {
        return router.recipeBuild(args)
      }
      {
        console.error(`Unknown recipe command: ${subcommand ?? ""}`)
        router.printHelp()
        return 1
      }
    }
    case "workspace-policy": {
      const subcommand = args.shift()
      if (subcommand !== "check") {
        console.error(`Unknown workspace-policy command: ${subcommand ?? ""}`)
        router.printHelp()
        return 1
      }
      return router.workspacePolicyCheck(args)
    }
    case "artifacts": {
      const subcommand = args.shift()
      if (subcommand === "verify") {
        return router.artifactsVerify(args)
      }
      if (subcommand === "browser-metrics") {
        return router.artifactsBrowserMetrics(args)
      }
      if (subcommand === "benchmark") {
        return router.artifactsBenchmark(args)
      }
      if (subcommand === "bench-results") {
        return router.artifactsBenchResults(args)
      }
      console.error(`Unknown artifacts command: ${subcommand ?? ""}`)
      router.printHelp()
      return 1
    }
    case "bench": {
      const subcommand = args.shift()
      if (subcommand === "summarize") {
        return router.benchSummarize(args)
      }
      console.error(`Unknown bench command: ${subcommand ?? ""}`)
      router.printHelp()
      return 1
    }
    case "runs": {
      const subcommand = args.shift()
      if (subcommand === "status") {
        return router.runsStatus(args)
      }
      if (subcommand === "artifacts") {
        return router.runsArtifacts(args)
      }
      console.error(`Unknown runs command: ${subcommand ?? ""}`)
      router.printHelp()
      return 1
    }
    case "commands":
      return router.commands(args)
    case "doctor":
      return router.doctor(args)
    case "cleanup":
      return router.cleanup(args)
    case "schema": {
      const subcommand = args.shift()
      if (subcommand !== "recipe") {
        console.error(`Unknown schema command: ${subcommand ?? ""}`)
        router.printHelp()
        return 1
      }
      return router.recipeSchema(args)
    }
    case "run":
      return router.run(args)
    default:
      console.error(`Unknown command: ${command}`)
      router.printHelp()
      return 1
  }
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
