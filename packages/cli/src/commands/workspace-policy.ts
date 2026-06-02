import { resolve } from "node:path"
import { checkWorkspacePolicy, type WorkspacePolicyResult } from "@automattic/wp-codebox-core"

interface WorkspacePolicyOptions {
  workspaceRoot: string
  writableRoots: string[]
  hiddenPaths: string[]
  gitBacked: boolean
  json: boolean
}

export async function runWorkspacePolicyCheckCommand(args: string[]): Promise<number> {
  const options = parseWorkspacePolicyOptions(args)
  const output = await checkWorkspacePolicy({
    workspaceRoot: options.workspaceRoot,
    writableRoots: options.writableRoots,
    hiddenPaths: options.hiddenPaths,
    gitBacked: options.gitBacked,
  })
  if (!options.json) {
    printWorkspacePolicyHumanOutput(output)
    return output.passed ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  return output.passed ? 0 : 1
}

function parseWorkspacePolicyOptions(args: string[]): WorkspacePolicyOptions {
  const options: WorkspacePolicyOptions = {
    workspaceRoot: process.cwd(),
    writableRoots: [],
    hiddenPaths: [],
    gitBacked: false,
    json: false,
  }

  while (args.length > 0) {
    const arg = args.shift()
    if (!arg) {
      continue
    }

    if (arg === "--json") {
      options.json = true
      continue
    }
    if (arg === "--git") {
      options.gitBacked = true
      continue
    }

    const value = args.shift()
    if (!value) {
      throw new Error(`Missing value for ${arg}`)
    }

    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        options.workspaceRoot = resolve(value)
        break
      case "--writable-root":
      case "--writable":
        options.writableRoots.push(value)
        break
      case "--hidden-path":
      case "--hidden":
        options.hiddenPaths.push(value)
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (options.writableRoots.length === 0) {
    throw new Error("At least one --writable-root is required")
  }

  return options
}

function printWorkspacePolicyHumanOutput(output: WorkspacePolicyResult): void {
  console.log(output.passed ? "Workspace policy passed" : "Workspace policy failed")
  console.log(`Policy: ${output.policy_sha256}`)
  if (output.violations.length === 0) {
    return
  }

  console.log("Violations:")
  for (const violation of output.violations) {
    console.log(`- ${violation.code}: ${violation.path}`)
    console.log(`  ${violation.message}`)
  }
}
