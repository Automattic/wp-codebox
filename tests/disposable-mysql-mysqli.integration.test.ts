import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { runRecipe } from "../packages/cli/src/commands/recipe-run.ts"

const execFileAsync = promisify(execFile)

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

if (!await dockerAvailable()) {
  console.log("SKIP disposable MySQL mysqli E2E: docker info is unavailable")
} else {
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-mysql-e2e-"))
  try {
    const recipePath = join(directory, "recipe.json")
    const code = "if (!function_exists('mysqli_init')) { throw new RuntimeException('mysqli is unavailable'); } $db = mysqli_init(); if (!mysqli_real_connect($db, getenv('DB_HOST'), 'root', '', null, (int) getenv('DB_PORT'))) { throw new RuntimeException(mysqli_connect_error()); } $result = mysqli_query($db, 'SELECT 1 AS connected'); echo mysqli_fetch_assoc($result)['connected'];"
    await writeFile(recipePath, JSON.stringify({
      schema: "wp-codebox/workspace-recipe/v1",
      inputs: {
        services: [{ id: "mysql", kind: "mysql", configuration: { rootAuthentication: "empty-password" }, outputs: { host: "DB_HOST", port: "DB_PORT" } }],
      },
      workflow: { steps: [{ command: "wordpress.run-php", args: [`code=${code}`] }] },
    }))
    const result = await runRecipe({
      recipePath,
      previewHoldBlocking: false,
      previewLeaseRequested: false,
      previewLeaseChild: false,
      timeoutMs: 180_000,
      json: true,
      summary: false,
      dryRun: false,
    })
    assert.equal(result.success, true)
    assert.equal(result.executions.at(-1)?.stdout.trim(), "1")
    console.log("disposable MySQL mysqli E2E passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
