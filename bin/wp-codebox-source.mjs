#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDirectory)
const distEntrypoint = join(repoRoot, "packages/cli/dist/index.js")
const nodeModules = join(repoRoot, "node_modules")
const packageLock = join(repoRoot, "package-lock.json")
const callerCwd = process.cwd()

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.delegate ? "inherit" : ["inherit", "pipe", "pipe"],
    encoding: options.delegate ? undefined : "utf8",
    env: process.env,
    shell: process.platform === "win32",
  })

  if (!options.delegate) {
    if (result.stdout) {
      process.stderr.write(result.stdout)
    }
    if (result.stderr) {
      process.stderr.write(result.stderr)
    }
  }

  if (result.error) {
    console.error(`WP Codebox source entrypoint failed to run ${command}: ${result.error.message}`)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

if (!existsSync(distEntrypoint)) {
  console.error("WP Codebox CLI dist entrypoint is absent; bootstrapping the source checkout before running the CLI.")

  if (!existsSync(nodeModules)) {
    run("npm", [existsSync(packageLock) ? "ci" : "install"])
  }

  run("npm", ["run", "build"])
}

run(process.execPath, [distEntrypoint, ...process.argv.slice(2)], { cwd: callerCwd, delegate: true })
