import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { smokeGroups, smokeManifest, type SmokeCommand } from "./smoke-manifest.ts"
import { discoveredParallelCommands, discoveredSerialCommands } from "./smoke-discovery.ts"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const DEFAULT_CONCURRENCY = 8

type ResolvedGroup = {
  name: string
  commands: SmokeCommand[]
}

function usage(): string {
  return [
    "Usage: npm run smoke -- [--group=<name> | --command=<name> | --all | --list]",
    "",
    "Groups:",
    ...Object.entries(smokeGroups).map(([name, group]) => `  ${name.padEnd(10)} ${group.description}`),
    "",
    "Aggregate groups:",
    ...Object.entries(smokeManifest.aggregateGroups).map(
      ([name, groups]) => `  ${name.padEnd(10)} ${groups.join(", ")}`,
    ),
  ].join("\n")
}

function parseArgs(args: string[]): { group?: string; command?: string; all: boolean; list: boolean; concurrency: number } {
  let group: string | undefined
  let command: string | undefined
  let all = false
  let list = false
  let concurrency = DEFAULT_CONCURRENCY

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith("--concurrency=")) {
      concurrency = Number(arg.slice("--concurrency=".length))
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error("--concurrency requires a positive integer")
      }
    } else if (arg === "--all") {
      all = true
    } else if (arg === "--list") {
      list = true
    } else if (arg === "--group") {
      group = args[index + 1]
      if (!group) {
        throw new Error("--group requires a value")
      }
      index += 1
    } else if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length)
    } else if (arg === "--command") {
      command = args[index + 1]
      if (!command) {
        throw new Error("--command requires a value")
      }
      index += 1
    } else if (arg.startsWith("--command=")) {
      command = arg.slice("--command=".length)
    } else if (arg === "--help" || arg === "-h") {
      list = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { group, command, all, list, concurrency }
}

function resolveGroup(groupName: string): ResolvedGroup {
  if (groupName in smokeGroups) {
    return { name: groupName, commands: smokeGroups[groupName as keyof typeof smokeGroups].commands }
  }

  if (groupName in smokeManifest.aggregateGroups) {
    const aggregateGroups = smokeManifest.aggregateGroups[groupName as keyof typeof smokeManifest.aggregateGroups]
    return {
      name: groupName,
      commands: aggregateGroups.flatMap((name) => smokeGroups[name].commands),
    }
  }

  throw new Error(`Unknown smoke group: ${groupName}\n\n${usage()}`)
}

function resolveCommand(commandName: string): ResolvedGroup {
  for (const group of Object.values(smokeGroups)) {
    const command = group.commands.find((entry) => entry.name === commandName)
    if (command) {
      return { name: commandName, commands: [command] }
    }
  }

  throw new Error(`Unknown smoke command: ${commandName}\n\n${usage()}`)
}

function runCommand(command: SmokeCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n[smoke] ${command.name}`)
    console.log(`[smoke] ${command.command} ${command.args.join(" ")}`)

    const child = spawn(command.command, command.args, {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
      shell: process.platform === "win32",
    })

    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command.name} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`))
    })
  })
}

type CommandOutcome = { command: SmokeCommand; error?: Error; output: string }

/*
 * Discovered files run as independent processes, so the parallel phase captures
 * output per command and reports every failure instead of stopping at the first.
 */
function runCapturedCommand(command: SmokeCommand): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let output = ""
    const child = spawn(command.command, command.args, {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    })

    child.stdout?.on("data", (chunk) => { output += String(chunk) })
    child.stderr?.on("data", (chunk) => { output += String(chunk) })
    child.on("error", (error) => resolve({ command, error, output }))
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({ command, output })
        return
      }
      resolve({
        command,
        error: new Error(`${command.name} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`),
        output,
      })
    })
  })
}

async function runInParallel(commands: SmokeCommand[], concurrency: number): Promise<Error[]> {
  const failures: Error[] = []
  let cursor = 0
  let finished = 0

  async function worker(): Promise<void> {
    while (cursor < commands.length) {
      const command = commands[cursor]
      cursor += 1
      const outcome = await runCapturedCommand(command)
      finished += 1
      if (outcome.error) {
        failures.push(outcome.error)
        console.log(`\n[smoke] FAIL (${finished}/${commands.length}) ${command.name}`)
        console.log(outcome.output.trimEnd())
      } else if (finished % 25 === 0) {
        console.log(`[smoke] ${finished}/${commands.length} complete`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return failures
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.list) {
    console.log(usage())
    return
  }

  const selectors = [options.all, Boolean(options.group), Boolean(options.command)].filter(Boolean).length
  if (selectors > 1) {
    throw new Error("Use only one of --all, --group, or --command.")
  }

  if (options.command) {
    const group = resolveCommand(options.command)
    for (const command of group.commands) await runCommand(command)
    return
  }

  const name = options.all ? "check" : options.group ?? "check"

  if (name !== "check") {
    const group = resolveGroup(name)
    console.log(`[smoke] Running ${group.commands.length} command(s) from ${group.name}`)
    for (const command of group.commands) await runCommand(command)
    return
  }

  // The aggregate: declared commands first (they build artifacts the discovered
  // files rely on), then discovered files in parallel, then the serial tail.
  const declared = resolveGroup("check")
  const parallel = discoveredParallelCommands(repositoryRoot)
  const serial = discoveredSerialCommands(repositoryRoot)

  console.log(
    `[smoke] check: ${declared.commands.length} declared, ${parallel.length} discovered (concurrency ${options.concurrency}), ${serial.length} serial`,
  )

  for (const command of declared.commands) await runCommand(command)

  console.log(`\n[smoke] discovered phase: ${parallel.length} files at concurrency ${options.concurrency}`)
  const failures = await runInParallel(parallel, options.concurrency)

  console.log(`\n[smoke] serial phase: ${serial.length} files`)
  for (const command of serial) {
    const outcome = await runCapturedCommand(command)
    if (outcome.error) {
      failures.push(outcome.error)
      console.log(`\n[smoke] FAIL ${command.name}`)
      console.log(outcome.output.trimEnd())
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} smoke command(s) failed:\n` + failures.map((f) => `  - ${f.message}`).join("\n"))
  }

  console.log(`\n[smoke] check passed: ${declared.commands.length + parallel.length + serial.length} command(s)`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
