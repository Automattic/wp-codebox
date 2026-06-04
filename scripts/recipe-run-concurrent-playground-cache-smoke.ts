import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-cache-concurrency-"))
const cacheDirectory = join(workspace, "playground-cache")

try {
  await writeFile(join(workspace, "recipe.json"), `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    workflow: {
      steps: [{ command: "wordpress.run-php", args: ["code=<?php echo 'cache-safe';"] }],
    },
  }, null, 2)}\n`)

  await mkdir(cacheDirectory, { recursive: true })
  await writeFile(join(cacheDirectory, "7.0.zip"), "not a complete zip")

  const [first, second] = await Promise.all([
    runRecipe(join(workspace, "recipe.json"), cacheDirectory),
    runRecipe(join(workspace, "recipe.json"), cacheDirectory),
  ])

  assert.equal(first.exit.code, 0, `first recipe-run failed; stdout: ${first.stdout}; stderr: ${first.stderr}`)
  assert.equal(second.exit.code, 0, `second recipe-run failed; stdout: ${second.stdout}; stderr: ${second.stderr}`)

  const firstOutput = JSON.parse(first.stdout)
  const secondOutput = JSON.parse(second.stdout)
  assert.equal(firstOutput.success, true)
  assert.equal(secondOutput.success, true)
  assert.equal(firstOutput.schema, "wp-codebox/recipe-run/v1")
  assert.equal(secondOutput.schema, "wp-codebox/recipe-run/v1")
  assert.equal(firstOutput.executions[0]?.stdout, "cache-safe")
  assert.equal(secondOutput.executions[0]?.stdout, "cache-safe")
  assert.equal(existsSync(join(cacheDirectory, "7.0.zip")), true, "successful concurrent runs should leave a reusable archive")

  console.log("Recipe concurrent Playground cache smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function runRecipe(recipePath: string, cacheDirectory: string): Promise<{ exit: { code: number | null; signal: NodeJS.Signals | null }; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--experimental-wasm-jspi",
    "--experimental-wasm-stack-switching",
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    recipePath,
    "--json",
  ], {
    cwd: root,
    env: { ...process.env, WP_CODEBOX_PLAYGROUND_WORDPRESS_CACHE_DIR: cacheDirectory },
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

  const timeout = setTimeout(() => {
    child.kill("SIGKILL")
  }, 120_000)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }))
  })
  clearTimeout(timeout)

  assert.notEqual(exit.signal, "SIGKILL", `recipe-run hung; stdout: ${stdout}; stderr: ${stderr}`)
  return { exit, stdout, stderr }
}
