import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-mdi-native-phpunit-"))
const codeboxCli = process.env.MDI_WP_CODEBOX_BIN ?? join(process.cwd(), "packages", "cli", "dist", "index.js")
const codeboxCommand = process.env.MDI_WP_CODEBOX_BIN ? codeboxCli : process.execPath
const codeboxCommandPrefix = process.env.MDI_WP_CODEBOX_BIN ? [] : [codeboxCli]

try {
  const plugin = join(root, "native-phpunit-lifecycle")
  const harness = join(root, "harness")
  await cp("tests/fixtures/phpunit-playground-harness", harness, { recursive: true })
  await execFileAsync("composer", ["install", "--no-interaction", "--prefer-dist"], { cwd: harness, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })
  await writeFixture(plugin)

  await runMode(false, { total: 3, passed: 2, failed: 0, skipped: 1, unknown: 0 })
  await runMode(true, { total: 3, passed: 3, failed: 0, skipped: 0, unknown: 0 })

  async function runMode(multisite: boolean, expected: { total: number, passed: number, failed: number, skipped: number, unknown: number }): Promise<void> {
    const suffix = multisite ? "multisite" : "single-site"
    const recipePath = join(root, `${suffix}.recipe.json`)
    const artifactsPath = join(root, `${suffix}.artifacts`)
    const recipe = buildWordPressPhpunitRecipe({
      pluginSlug: "native-phpunit-lifecycle",
      databaseType: "mdi-native",
      multisite,
      extra_plugins: [{ source: plugin, slug: "native-phpunit-lifecycle", activate: false }],
      dependencyMounts: ["/wordpress/wp-content/plugins/native-phpunit-lifecycle"],
      mounts: [{ source: join(harness, "vendor"), target: "/wp-codebox-vendor", mode: "readonly" }],
    })
    await writeFile(recipePath, `${JSON.stringify(recipe)}\n`)
    const result = await execFileAsync(codeboxCommand, [...codeboxCommandPrefix, "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--policy", JSON.stringify({ network: "deny", filesystem: "sandbox", commands: ["wordpress.phpunit", "wordpress.run-php"], secrets: "none", approvals: "never" }), "--json"], {
      cwd: process.cwd(), timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
    })
    assert.equal((JSON.parse(result.stdout) as { success?: boolean }).success, true, result.stdout)
    const runtime = JSON.parse(await readFile(join(artifactsPath, "latest-runtime.json"), "utf8")) as { paths?: { runtimeDirectory?: string } }
    assert.ok(runtime.paths?.runtimeDirectory)
    const evidence = JSON.parse(await readFile(join(artifactsPath, runtime.paths.runtimeDirectory, "files/test-results.json"), "utf8")) as { status?: string, summary?: unknown }
    assert.equal(evidence.status, "passed")
    assert.deepEqual(evidence.summary, expected)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

async function writeFixture(plugin: string): Promise<void> {
  await mkdir(join(plugin, "tests"), { recursive: true })
  await writeFile(join(plugin, "native-phpunit-lifecycle.php"), "<?php\n/**\n * Plugin Name: MDI Native PHPUnit Lifecycle Fixture\n * Description: Exercises the native drop-in through WP_UnitTestCase.\n */\n")
  await writeFile(join(plugin, "phpunit.xml.dist"), "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<phpunit><testsuites><testsuite name=\"mdi-native-lifecycle\"><directory>tests</directory></testsuite></testsuites></phpunit>\n")
  await writeFile(join(plugin, "tests", "NativeLifecycleTest.php"), `<?php
class NativeLifecycleTest extends WP_UnitTestCase {
    public function test_01_insert_read_and_update(): void {
        $post_id = self::factory()->post->create(array('post_title' => 'Native lifecycle title', 'post_content' => 'Native lifecycle content'));
        $this->assertSame('Native lifecycle title', get_post($post_id)->post_title, $GLOBALS['wpdb']->last_error);
        wp_update_post(array('ID' => $post_id, 'post_title' => 'Native lifecycle updated', 'post_content' => 'Native lifecycle updated content'));
        $post = get_post($post_id);
        $this->assertSame('Native lifecycle updated', $post->post_title);
        $this->assertSame('Native lifecycle updated content', $post->post_content);
    }
    public function test_02_reset_removes_the_previous_test_post(): void {
        $query = new WP_Query(array('post_type' => 'post', 'title' => 'Native lifecycle updated', 'posts_per_page' => 1, 'fields' => 'ids'));
        $this->assertSame(array(), $query->posts);
    }
    public function test_multisite_switch_keeps_site_posts_isolated(): void {
        if (!is_multisite()) $this->markTestSkipped('Requires a multisite PHPUnit run.');
        $site_id = self::factory()->blog->create();
        if (1 === $site_id) $site_id = self::factory()->blog->create();
        switch_to_blog($site_id);
        $this->assertSame($GLOBALS['wpdb']->base_prefix . $site_id . '_', $GLOBALS['wpdb']->prefix);
        $post_id = self::factory()->post->create(array('post_title' => 'Native switched site post'));
        $this->assertSame('Native switched site post', get_post($post_id)->post_title, $GLOBALS['wpdb']->last_error);
        restore_current_blog();
        $this->assertSame(array(), get_posts(array('post_type' => 'post', 'title' => 'Native switched site post', 'fields' => 'ids')));
    }
}
`)
}

console.log("mdi-native PHPUnit lifecycle integration ok")
