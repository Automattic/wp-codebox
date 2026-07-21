import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { runRecipe } from "../packages/cli/src/commands/recipe-run.ts"
import { provisionRuntimeServices } from "../packages/cli/src/runtime-services.ts"
import { executeBoundedRuntimePlan } from "../packages/runtime-core/src/index.js"

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
    const code = "if (!function_exists('mysqli_init')) { throw new RuntimeException('mysqli is unavailable'); } $db = mysqli_init(); if (!mysqli_real_connect($db, getenv('DB_HOST'), 'root', '', 'runtime', (int) getenv('DB_PORT'))) { throw new RuntimeException(mysqli_connect_error()); } mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT); mysqli_query($db, 'CREATE TABLE parent (id INT NOT NULL, KEY (id)) ENGINE=InnoDB'); mysqli_query($db, 'CREATE TABLE child (parent_id INT NOT NULL, FOREIGN KEY (parent_id) REFERENCES parent(id)) ENGINE=InnoDB'); $result = mysqli_query($db, 'SELECT 1 AS connected'); echo mysqli_fetch_assoc($result)['connected'];"
    await writeFile(recipePath, JSON.stringify({
      schema: "wp-codebox/workspace-recipe/v1",
      inputs: {
        services: [{ id: "mysql", kind: "mysql", configuration: { rootAuthentication: "empty-password", foreignKeyTargetPolicy: "indexed" }, outputs: { host: "DB_HOST", port: "DB_PORT" } }],
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

    const mariaDbRecipePath = join(directory, "mariadb-recipe.json")
    const mariaDbCode = "if (!function_exists('mysqli_init')) { throw new RuntimeException('mysqli is unavailable'); } $db = mysqli_init(); if (!mysqli_real_connect($db, getenv('DB_HOST'), 'root', '', 'runtime', (int) getenv('DB_PORT'))) { throw new RuntimeException(mysqli_connect_error()); } mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT); mysqli_query($db, 'CREATE TABLE parent (id INT NOT NULL, KEY (id)) ENGINE=InnoDB'); mysqli_query($db, 'CREATE TABLE child (parent_id INT NOT NULL, FOREIGN KEY (parent_id) REFERENCES parent(id)) ENGINE=InnoDB'); mysqli_query($db, \"CREATE TABLE settings (payload LONGTEXT NOT NULL DEFAULT '{}') ENGINE=InnoDB\"); $result = mysqli_query($db, 'SELECT 1 AS connected'); echo mysqli_fetch_assoc($result)['connected'];"
    await writeFile(mariaDbRecipePath, JSON.stringify({
      schema: "wp-codebox/workspace-recipe/v1",
      inputs: {
        services: [{ id: "mariadb", kind: "mysql", configuration: { engine: "mariadb", rootAuthentication: "empty-password" }, outputs: { host: "DB_HOST", port: "DB_PORT" } }],
      },
      workflow: { steps: [{ command: "wordpress.run-php", args: [`code=${mariaDbCode}`] }] },
    }))
    const mariaDbResult = await runRecipe({
      recipePath: mariaDbRecipePath,
      previewHoldBlocking: false,
      previewLeaseRequested: false,
      previewLeaseChild: false,
      timeoutMs: 180_000,
      json: true,
      summary: false,
      dryRun: false,
    })
    assert.equal(mariaDbResult.success, true)
    assert.equal(mariaDbResult.executions.at(-1)?.stdout.trim(), "1")

    // The aggregate adapter models two PHPUnit invocations. They share the one
    // MariaDB allocation but each receives its own database identity.
    const allocation = await provisionRuntimeServices([{
      id: "phpunit-mariadb",
      kind: "mysql",
      configuration: { engine: "mariadb", rootAuthentication: "empty-password" },
      outputs: { host: "DB_HOST", port: "DB_PORT" },
    }])
    try {
      const container = (await execFileAsync("docker", ["ps", "--filter", "name=wp-codebox-phpunit-mariadb", "--format", "{{.Names}}"], { timeout: 10_000 })).stdout.trim()
      assert.equal(container.split("\n").filter(Boolean).length, 1, "two entries use one disposable MariaDB allocation")
      const aggregate = await executeBoundedRuntimePlan({
        schema: "wp-codebox/bounded-runtime-plan/v1",
        concurrency: 2,
        entries: [
          { id: "phpunit-one", argv: ["phpunit", "--testsuite=one"], environment: { DB_NAME: "phpunit_one" }, processIdentity: "phpunit-one", artifactNamespace: "phpunit/one", inputIndex: 0 },
          { id: "phpunit-two", argv: ["phpunit", "--testsuite=two"], environment: { DB_NAME: "phpunit_two" }, processIdentity: "phpunit-two", artifactNamespace: "phpunit/two", inputIndex: 1 },
        ],
      }, {
        async materialize() { return { workspace: undefined, runtime: undefined } },
        async startServices() { return allocation },
        async execute({ entry }) {
          const database = entry.environment?.DB_NAME
          await execFileAsync("docker", ["exec", container, "mariadb", "-uroot", "-e", `CREATE DATABASE \`${database}\`; CREATE TABLE \`${database}\`.entry_identity (id INT);`], { timeout: 30_000 })
          return { success: true, exitCode: 0 }
        },
        async stopServices() {},
        async dispose() {},
      })
      assert.equal(aggregate.success, true)
      assert.deepEqual(aggregate.entries.map((entry) => entry.artifactNamespace), ["phpunit/one", "phpunit/two"])
      assert.deepEqual(aggregate.entries.map((entry) => entry.inputIndex), [0, 1])
    } finally {
      await allocation.release()
    }
    console.log("disposable MySQL and MariaDB mysqli E2E passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
