import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runCli } from "../packages/cli/src/cli-entry.js"

const cliPackage = JSON.parse(readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8")) as { version: string }

const originalStdoutWrite = process.stdout.write.bind(process.stdout)

async function runCaptureCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  let stdout = ""
  process.stdout.write = ((chunk: unknown, ..._args: unknown[]) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  const exitCode = await runCli(args)
  process.stdout.write = originalStdoutWrite
  return { exitCode, stdout }
}

for (const args of [["--version"], ["-v"], ["version"]] as const) {
  const { exitCode, stdout } = await runCaptureCli([...args])
  assert.equal(exitCode, 0, `expected exit 0 for ${args.join(" ")}, got ${exitCode}`)
  assert.equal(stdout.trim(), cliPackage.version, `expected version ${cliPackage.version} for ${args.join(" ")}, got ${stdout.trim()}`)
}

const { exitCode: unknownExitCode } = await runCaptureCli(["not-a-command"])
assert.equal(unknownExitCode, 1, "unknown command must still exit non-zero")

console.log("cli-version-smoke: ok")
