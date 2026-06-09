import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-advisory-preview-"))
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
          args: ["code=<?php echo 'primary generation complete';"],
        },
        {
          command: "wordpress.run-php",
          args: ["code=<?php throw new Exception('optional evidence failed');"],
          allowFailure: true,
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
  const { stdout } = await execFileAsync(process.execPath, [
    "packages/cli/dist/index.js",
    "recipe-run",
    "--recipe",
    recipePath,
    "--artifacts",
    artifacts,
    "--preview-hold",
    "20s",
    "--json",
  ], { cwd: root, timeout: 60_000 })
  const elapsedMs = Date.now() - startedAt
  assert.ok(elapsedMs < 20_000, `preview-hold should not block recipe-run completion; elapsed ${elapsedMs}ms`)

  const output = JSON.parse(stdout)
  assert.equal(output.schema, "wp-codebox/recipe-run/v1")
  assert.equal(output.success, true)
  assert.equal(output.advisoryFailures?.length, 1)
  assert.equal(output.advisoryFailures[0].command, "wordpress.run-php")
  assert.match(output.advisoryFailures[0].error.message, /optional evidence failed/)
  assert.equal(output.artifacts?.preview?.holdSeconds, 20)
  assert.equal(output.artifacts.preview.lifecycle, "held-after-run")

  const latestRuntime = JSON.parse(await readFile(join(artifacts, "latest-runtime.json"), "utf8"))
  assert.equal(latestRuntime.commandStatus, "completed")
  assert.equal(latestRuntime.failure, undefined)

  console.log("Recipe advisory preview smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}
