import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { runRecipe } from "../packages/cli/src/commands/recipe-run.ts"
import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"

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

    const harness = join(directory, "phpunit-harness")
    const plugin = join(directory, "bounded-phpunit-fixture")
    const wpConfig = join(directory, "wp-config.php")
    const boundedRecipePath = join(directory, "bounded-phpunit-recipe.json")
    const boundedArtifacts = join(directory, "bounded-phpunit-artifacts")
    await cp("tests/fixtures/phpunit-playground-harness", harness, { recursive: true })
    await execFileAsync("composer", ["install", "--no-interaction", "--prefer-dist"], { cwd: harness, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })
    await mkdir(join(plugin, "tests"), { recursive: true })
    await writeFile(join(plugin, "bounded-phpunit-fixture.php"), "<?php\n/** Plugin Name: Bounded PHPUnit Fixture */\n")
    await writeFile(join(plugin, "phpunit.xml"), "<?xml version=\"1.0\"?><phpunit><testsuites><testsuite name=\"bounded\"><directory>tests</directory></testsuite></testsuites></phpunit>\n")
    await writeFile(join(plugin, "tests", "BoundedMariaDbTest.php"), `<?php
final class BoundedMariaDbTest extends PHPUnit\\Framework\\TestCase {
    public function test_database_identity(): void {
        $index = (string) getenv('TC_DB_INDEX');
        $this->assertMatchesRegularExpression('/^[12]$/', $index);
        $db = mysqli_init();
        $this->assertTrue(mysqli_real_connect($db, '127.0.0.1', 'root', '', 'runtime', (int) getenv('TC_MYSQL_PORT')));
        mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
        $database = 'bounded_phpunit_' . $index;
        mysqli_query($db, 'CREATE DATABASE ' . $database);
        mysqli_query($db, 'CREATE TABLE ' . $database . '.entry_identity (value VARCHAR(8) NOT NULL) ENGINE=InnoDB');
        mysqli_query($db, "INSERT INTO " . $database . ".entry_identity VALUES ('" . $index . "')");
        $row = mysqli_fetch_assoc(mysqli_query($db, 'SELECT value FROM ' . $database . '.entry_identity'));
        $this->assertSame($index, $row['value']);
    }
}
`)
    await writeFile(wpConfig, `<?php
define('DB_NAME', 'runtime');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', '127.0.0.1:' . getenv('TC_MYSQL_PORT'));
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
$table_prefix = 'wp_';
define('WP_DEBUG', true);
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
`)
    const boundedRecipe = buildWordPressPhpunitRecipe({
      pluginSlug: "bounded-phpunit-fixture",
      phpVersion: "8.3",
      pluginSource: plugin,
      services: [{ id: "phpunit-mariadb", kind: "mysql", configuration: { engine: "mariadb", rootAuthentication: "empty-password" }, outputs: { port: "TC_MYSQL_PORT" } }],
      mounts: [
        { source: wpConfig, target: "/wordpress/wp-config.php", mode: "readonly" },
        { source: join(harness, "vendor"), target: "/wp-codebox-vendor", mode: "readonly" },
      ],
      autoloadFile: "/wp-codebox-vendor/autoload.php",
      testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
      testRoot: "/wordpress/wp-content/plugins/bounded-phpunit-fixture/tests",
      phpunitXml: "/wordpress/wp-content/plugins/bounded-phpunit-fixture/phpunit.xml",
      bootstrapMode: "project",
    })
    const phpunitArgv = ["wordpress.phpunit", ...(boundedRecipe.workflow.steps[0]?.args ?? [])]
    boundedRecipe.workflow.steps = [{
      command: "wp-codebox.bounded-runtime-plan",
      args: [`plan-json=${JSON.stringify({
        schema: "wp-codebox/bounded-runtime-plan/v1",
        concurrency: 2,
        entries: [
          { id: "phpunit-one", argv: phpunitArgv, environment: { TC_DB_INDEX: "1" }, timeoutMs: 120_000, processIdentity: "phpunit-one", artifactNamespace: "phpunit/one", inputIndex: 0 },
          { id: "phpunit-two", argv: phpunitArgv, environment: { TC_DB_INDEX: "2" }, timeoutMs: 120_000, processIdentity: "phpunit-two", artifactNamespace: "phpunit/two", inputIndex: 1 },
        ],
      })}`],
    }]
    await writeFile(boundedRecipePath, `${JSON.stringify(boundedRecipe)}\n`)
    const boundedResult = await runRecipe({ recipePath: boundedRecipePath, artifactsDirectory: boundedArtifacts, previewHoldBlocking: false, previewLeaseRequested: false, previewLeaseChild: false, timeoutMs: 300_000, json: true, summary: false, dryRun: false })
    assert.equal(boundedResult.success, true, JSON.stringify(boundedResult))
    const boundedExecution = boundedResult.executions.find((execution) => execution.command === "wp-codebox.bounded-runtime-plan")
    const aggregate = JSON.parse(boundedExecution?.stdout ?? "{}")
    assert.deepEqual(aggregate.counts, { total: 2, succeeded: 2, failed: 0, timedOut: 0, cancelled: 0 })
    assert.deepEqual(aggregate.entries.map((entry: { artifactNamespace: string }) => entry.artifactNamespace), ["phpunit/one", "phpunit/two"])
    assert.deepEqual(aggregate.entries.map((entry: { inputIndex: number }) => entry.inputIndex), [0, 1])
    console.log("disposable MySQL and MariaDB mysqli E2E passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
