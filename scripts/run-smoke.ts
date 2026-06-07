import { spawn } from "node:child_process"
import { smokeGroups, smokeManifest, type SmokeCommand } from "./smoke-manifest.ts"

type ResolvedGroup = {
  name: string
  commands: SmokeCommand[]
}

function usage(): string {
  return [
    "Usage: npm run smoke -- [--group=<name> | --all | --list]",
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

function parseArgs(args: string[]): { group?: string; all: boolean; list: boolean } {
  let group: string | undefined
  let all = false
  let list = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--all") {
      all = true
    } else if (arg === "--list") {
      list = true
    } else if (arg === "--group") {
      group = args[index + 1]
      index += 1
    } else if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length)
    } else if (arg === "--help" || arg === "-h") {
      list = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { group, all, list }
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.list) {
    console.log(usage())
    return
  }

  if (options.all && options.group) {
    throw new Error("Use either --all or --group, not both.")
  }

  const group = resolveGroup(options.all ? "check" : options.group ?? "check")
  console.log(`[smoke] Running ${group.commands.length} command(s) from ${group.name}`)

  for (const command of group.commands) {
    await runCommand(command)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
