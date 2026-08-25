import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.executions.at(-1)?.stdout.trim(), "1")

    const mariaDbRecipePath = join(directory, "mariadb-recipe.json")
    const mariaDbCode = "if (!function_exists('mysqli_init')) { throw new RuntimeException('mysqli is unavailable'); } mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT); $connect = static function (string $port): mysqli { $db = mysqli_init(); if (!mysqli_real_connect($db, getenv('DB_HOST'), getenv('DB_USER'), getenv('DB_PASSWORD'), getenv('DB_NAME'), (int) $port)) { throw new RuntimeException(mysqli_connect_error()); } return $db; }; $db = $connect((string) getenv('DB_PORT')); $compatibility = $connect((string) getenv('TC_MYSQL_PORT')); mysqli_query($db, 'CREATE TABLE mariadb_bridge (id INT PRIMARY KEY, value VARCHAR(32) NOT NULL) ENGINE=InnoDB'); mysqli_query($db, \"INSERT INTO mariadb_bridge (id, value) VALUES (1, 'reachable')\"); $row = mysqli_fetch_assoc(mysqli_query($compatibility, 'SELECT value FROM mariadb_bridge WHERE id = 1')); if (($row['value'] ?? null) !== 'reachable') { throw new RuntimeException('MariaDB read failed'); } mysqli_query($db, 'DROP TABLE mariadb_bridge'); echo getenv('DB_PORT') . ':' . getenv('TC_MYSQL_PORT');"
    await writeFile(mariaDbRecipePath, JSON.stringify({
      schema: "wp-codebox/workspace-recipe/v1",
      runtime: { phpVersion: "8.4" },
      inputs: {
        services: [{ id: "mariadb", kind: "mysql", configuration: { engine: "mariadb", rootAuthentication: "empty-password" }, outputs: { host: "DB_HOST", port: ["DB_PORT", "TC_MYSQL_PORT"], username: "DB_USER", password: "DB_PASSWORD", database: "DB_NAME" } }],
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
    assert.equal(mariaDbResult.success, true, JSON.stringify(mariaDbResult))
    const [canonicalPort, compatibilityPort] = (mariaDbResult.executions.at(-1)?.stdout.trim() ?? "").split(":")
    assert.match(canonicalPort, /^\d+$/)
    assert.equal(compatibilityPort, canonicalPort)

    const harness = join(directory, "phpunit-harness")
    const plugin = join(directory, "bounded-phpunit-fixture")
    const wpConfig = join(directory, "wp-config.php")
    const boundedRecipePath = join(directory, "bounded-phpunit-recipe.json")
    const boundedArtifacts = join(directory, "bounded-phpunit-artifacts")
    await cp("tests/fixtures/phpunit-playground-harness", harness, { recursive: true })
    await execFileAsync("composer", ["install", "--no-interaction", "--prefer-dist"], { cwd: harness, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })
    await mkdir(join(plugin, "tests"), { recursive: true })
    await writeFile(join(plugin, "bounded-phpunit-fixture.php"), "<?php\n/** Plugin Name: Bounded PHPUnit Fixture */\n")
    await writeFile(join(plugin, "phpunit.xml"), "<?xml version=\"1.0\"?><phpunit bootstrap=\"tests/bootstrap.php\"><testsuites><testsuite name=\"bounded\"><directory>tests</directory></testsuite></testsuites></phpunit>\n")
    await writeFile(join(plugin, "tests", "bootstrap.php"), "<?php\n")
    await writeFile(join(plugin, "tests", "BoundedMariaDbTest.php"), `<?php
final class BoundedMariaDbTest extends PHPUnit\\Framework\\TestCase {
    public function test_database_identity(): void {
        $index = (string) getenv('TC_DB_INDEX');
        $this->assertMatchesRegularExpression('/^[12]$/', $index);
        $this->assertNotSame('', (string) getenv('DB_PASSWORD'));
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
      services: [{ id: "phpunit-mariadb", kind: "mysql", configuration: { engine: "mariadb", rootAuthentication: "empty-password" }, outputs: { port: "TC_MYSQL_PORT", password: "DB_PASSWORD" } }],
      mounts: [
        { source: wpConfig, target: "/wordpress/wp-config.php", mode: "readonly", phase: "pre-install" },
        { source: join(harness, "vendor"), target: "/wp-codebox-vendor", mode: "readonly" },
      ],
      autoloadFile: "/wp-codebox-vendor/autoload.php",
      testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
      testRoot: "/wordpress/wp-content/plugins/bounded-phpunit-fixture/tests",
      phpunitXml: "/wordpress/wp-content/plugins/bounded-phpunit-fixture/phpunit.xml",
      bootstrapMode: "project",
    })
    assert.equal(boundedRecipe.inputs.mounts?.find((mount) => mount.target === "/wordpress/wp-config.php")?.phase, "pre-install")
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
    const boundedDiagnostics = await Promise.all(["one", "two"].flatMap((identity) => ["stdout.txt", "stderr.txt", "result.json"].map(async (file) => {
      const path = join(boundedArtifacts, "phpunit", identity, file)
      try { return `${path}:\n${await readFile(path, "utf8")}` } catch { return `${path}: unavailable` }
    })))
    assert.equal(boundedResult.success, true, `${JSON.stringify(boundedResult)}\n${boundedDiagnostics.join("\n")}`)
    const boundedExecution = boundedResult.executions.find((execution) => execution.command === "wp-codebox.bounded-runtime-plan")
    const aggregate = JSON.parse(boundedExecution?.stdout ?? "{}")
    assert.deepEqual(aggregate.counts, { total: 2, succeeded: 2, failed: 0, timedOut: 0, cancelled: 0 })
    assert.deepEqual(aggregate.entries.map((entry: { artifactNamespace: string }) => entry.artifactNamespace), ["phpunit/one", "phpunit/two"])
    assert.deepEqual(aggregate.entries.map((entry: { inputIndex: number }) => entry.inputIndex), [0, 1])

    const multisitePlugin = join(directory, "managed-multisite-fixture")
    const multisiteDependency = join(directory, "managed-multisite-dependency")
    const multisiteMuDependency = join(directory, "managed-multisite-mu-dependency")
    const multisiteRecipePath = join(directory, "managed-multisite-recipe.json")
    const multisiteArtifacts = join(directory, "managed-multisite-artifacts")
    await mkdir(join(multisitePlugin, "tests"), { recursive: true })
    await mkdir(join(multisiteDependency, "vendor"), { recursive: true })
    await mkdir(multisiteMuDependency, { recursive: true })
    await writeFile(join(multisiteDependency, "decoy.php"), "<?php\n/** Plugin Name: Managed Multisite Decoy */\nthrow new RuntimeException('dependency entrypoint scan loaded the decoy');\n")
    await writeFile(join(multisiteDependency, "bootstrap.php"), "<?php\n/** Plugin Name: Managed Multisite Dependency */\nregister_activation_hook(__FILE__, static function (): void { update_network_option(1, 'wp_codebox_dependency_activated', 1); });\n")
    await writeFile(join(multisiteDependency, "vendor", "autoload.php"), `<?php
global $wpdb;
$network_table = $wpdb->blogs;
if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($network_table))) !== $network_table) {
    throw new RuntimeException('Composer autoloader ran before multisite network tables existed');
}
get_network_option(1, 'site_name', '');
file_put_contents('/tmp/wp-codebox-composer-loaded-after-network', 'yes');
`)
    await writeFile(join(multisiteMuDependency, "mu-bootstrap.php"), `<?php
/** Plugin Name: Managed Multisite MU Dependency */
global $wpdb;
$network_table = $wpdb->blogs;
if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($network_table))) !== $network_table) {
    throw new RuntimeException('MU dependency ran before multisite network tables existed');
}
get_network_option(1, 'site_name', '');
file_put_contents('/tmp/wp-codebox-mu-loaded-after-network', 'yes');
`)
    await writeFile(join(multisitePlugin, "managed-multisite-fixture.php"), `<?php
/** Plugin Name: Managed Multisite Fixture */
add_action('init', static function (): void {
    update_option('wp_codebox_parent_init_ran', 1);
    add_action('init', static function (): void {
        update_option('wp_codebox_nested_init_ran', 1);
        do_action('wp_codebox_nested_init_replayed');
    }, 15);
}, 0);
`)
    await writeFile(join(multisitePlugin, "phpunit.xml.dist"), "<?xml version=\"1.0\"?><phpunit><testsuites><testsuite name=\"managed-multisite\"><directory>tests</directory></testsuite></testsuites></phpunit>\n")
    await writeFile(join(multisitePlugin, "tests", "ManagedMultisiteTest.php"), `<?php
final class ManagedMultisiteTest extends WP_UnitTestCase {
    public function test_external_mysql_preserves_multisite_blog_switching(): void {
        $this->assertTrue(is_multisite());
        $original = get_current_blog_id();
        $blog_id = self::factory()->blog->create();
        switch_to_blog($blog_id);
        $this->assertSame($blog_id, get_current_blog_id());
        $this->assertTrue(ms_is_switched());
        restore_current_blog();
        $this->assertSame($original, get_current_blog_id());
        $this->assertFalse(ms_is_switched());
    }

    public function test_external_mysql_replays_wordpress_lifecycle_in_order(): void {
        $this->assertGreaterThan(0, did_action('init'));
        $this->assertSame(1, (int) get_option('wp_codebox_parent_init_ran'));
        $this->assertSame(1, (int) get_option('wp_codebox_nested_init_ran'));
        $this->assertSame(1, did_action('wp_codebox_nested_init_replayed'));
    }

    public function test_runtime_uses_real_mysql(): void {
        global $wpdb;
        $this->assertInstanceOf(mysqli::class, $wpdb->dbh);
        $this->assertSame('1', (string) $wpdb->get_var("SELECT JSON_VALID('{\\"valid\\":true}')"));
    }

    public function test_network_schema_seed_and_dependency_are_materialized(): void {
        global $wpdb;
        foreach (array($wpdb->blogs, $wpdb->blogmeta, $wpdb->site, $wpdb->sitemeta, $wpdb->registration_log, $wpdb->signups) as $table) {
            $this->assertSame($table, $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))));
        }
        $this->assertGreaterThanOrEqual(1, (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->blogs} WHERE blog_id = 1"));
        $this->assertGreaterThan(0, (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->sitemeta} WHERE site_id = 1"));
        $this->assertTrue(update_network_option(1, 'wp_codebox_network_write', 'round-trip'));
        $this->assertSame('round-trip', get_network_option(1, 'wp_codebox_network_write'));
        $dependency = WP_PLUGIN_DIR . '/managed-multisite-dependency/bootstrap.php';
        $this->assertDirectoryExists(dirname($dependency));
        $this->assertFileExists($dependency);
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        $this->assertTrue(is_plugin_active_for_network('managed-multisite-dependency/bootstrap.php'));
        $this->assertSame(1, (int) get_network_option(1, 'wp_codebox_dependency_activated'));
        $this->assertFileExists('/tmp/wp-codebox-composer-loaded-after-network');
        $this->assertFileExists('/tmp/wp-codebox-mu-loaded-after-network');
    }
}
`)
    const multisiteRecipe = buildWordPressPhpunitRecipe({
      pluginSlug: "managed-multisite-fixture",
      phpVersion: "8.3",
      databaseType: "mysql",
      multisite: true,
      pluginSource: multisitePlugin,
      extra_plugins: [
        { source: multisiteDependency, slug: "managed-multisite-dependency", pluginFile: "managed-multisite-dependency/bootstrap.php", activate: true },
        { source: multisiteMuDependency, slug: "managed-multisite-mu-dependency", pluginFile: "managed-multisite-mu-dependency/mu-bootstrap.php", activate: true, loadAs: "mu-plugin" },
      ],
      dependencyMounts: ["/wordpress/wp-content/plugins/managed-multisite-dependency", "/wordpress/wp-content/plugins/managed-multisite-mu-dependency"],
      mounts: [{ source: join(harness, "vendor"), target: "/wp-codebox-vendor", mode: "readonly" }],
    })
    await writeFile(multisiteRecipePath, `${JSON.stringify(multisiteRecipe)}\n`)
    const multisiteResult = await runRecipe({ recipePath: multisiteRecipePath, artifactsDirectory: multisiteArtifacts, previewHoldBlocking: false, previewLeaseRequested: false, previewLeaseChild: false, timeoutMs: 300_000, json: true, summary: false, dryRun: false })
    const multisiteFailure = multisiteResult as typeof multisiteResult & { error?: unknown }
    assert.equal(multisiteResult.success, true, JSON.stringify({ error: multisiteFailure.error, executions: multisiteResult.executions }))
    const latest = JSON.parse(await readFile(join(multisiteArtifacts, "latest-runtime.json"), "utf8")) as { paths?: { runtimeDirectory?: string } }
    const diagnostic = await readFile(join(multisiteArtifacts, latest.paths?.runtimeDirectory ?? "", "files/phpunit/.pg-test-result.txt"), "utf8")
    assert.match(diagnostic, /STAGE_BEGIN:run_tests[\s\S]*RUNNING [1-9][0-9]* TEST FILES/, "managed multisite diagnostics must prove test execution started")
    const phpunitOutput = multisiteResult.executions.filter((execution) => execution.command === "wordpress.phpunit").map((execution) => execution.stdout).join("\n")
    assert.match(phpunitOutput, /OK \([1-9][0-9]* tests?, [1-9][0-9]* assertions?\)/, "managed multisite regression must execute nonzero tests and assertions")
    console.log("disposable MySQL and MariaDB mysqli E2E passed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
