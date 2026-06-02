import assert from "node:assert/strict"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-run-timeout-"))
const execFileAsync = promisify(execFile)

try {
  const artifacts = join(workspace, "artifacts")
  const recipePath = join(workspace, "recipe.json")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    workflow: {
      steps: [
        {
          command: "wordpress.run-php",
          args: ["code=<?php sleep(10); echo 'unreachable';"],
        },
      ],
    },
    artifacts: {
      directory: artifacts,
      verify: true,
      workspacePolicy: { strict: false, writableRoots: ["."], gitBacked: false },
    },
  }, null, 2)}\n`)

  const startedAt = Date.now()
  const child = spawn(process.execPath, [
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    recipePath,
    "--artifacts",
    artifacts,
    "--timeout",
    "2s",
    "--json",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const watchdog = setTimeout(() => {
    child.kill("SIGKILL")
  }, 15_000)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }))
  })
  clearTimeout(watchdog)

  assert.notEqual(exit.signal, "SIGKILL", `recipe-run hung after timeout; stdout: ${stdout}; stderr: ${stderr}`)
  assert.equal(exit.code, 1, `recipe-run should fail on timeout; stdout: ${stdout}; stderr: ${stderr}`)
  assert.ok(Date.now() - startedAt < 15_000, "recipe-run should exit before the outer watchdog")

  const output = JSON.parse(stdout)
  assert.equal(output.schema, "wp-codebox/recipe-run/v1")
  assert.equal(output.success, false)
  assert.equal(output.error?.code, "recipe-run-timeout")
  assert.match(output.error?.activeOperation ?? "", /workflow\.steps\[0\]:wordpress\.run-php/)
  assert.ok(output.error?.elapsedMs >= 1_000, `Expected elapsedMs in timeout payload: ${stdout}`)
  assert.equal(output.error?.timeoutMs, 2000)
  assert.ok(output.artifacts?.directory, "Timed-out recipe should report artifact directory")

  const manifest = JSON.parse(await readFile(join(output.artifacts.directory, "manifest.json"), "utf8"))
  assert.ok(manifest.files.some((file: { path?: string }) => file.path === "logs/runtime.log"), "Timed-out recipe should write runtime.log")
  assert.ok(manifest.files.some((file: { path?: string }) => file.path === "logs/commands.log"), "Timed-out recipe should write commands.log")
  assert.equal(await recipeRunProcessCount(recipePath), 0, "Timed-out recipe should not leave recipe-run child processes behind")

  console.log("Recipe run timeout smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function recipeRunProcessCount(recipePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="])
  return stdout
    .split("\n")
    .filter((line) => line.includes("recipe-run") && line.includes(recipePath))
    .length
}
