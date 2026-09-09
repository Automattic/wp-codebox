import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-mdi-native-phpunit-"))

try {
  const plugin = join(root, "mdi-native-phpunit-fixture")
  const harness = join(root, "harness")
  const recipePath = join(root, "recipe.json")
  const artifactsPath = join(root, "artifacts")
  await cp("tests/fixtures/phpunit-playground-harness", harness, { recursive: true })
  await execFileAsync("composer", ["install", "--no-interaction", "--prefer-dist"], { cwd: harness, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })
  await mkdir(join(plugin, "tests"), { recursive: true })
  await writeFile(join(plugin, "mdi-native-phpunit-fixture.php"), "<?php\n/** Plugin Name: MDI Native PHPUnit Fixture */\n")
  await writeFile(join(plugin, "phpunit.xml.dist"), "<?xml version=\"1.0\"?><phpunit><testsuites><testsuite name=\"mdi-native\"><directory>tests</directory></testsuite></testsuites></phpunit>\n")
  await writeFile(join(plugin, "tests", "NativeLifecycleTest.php"), `<?php
class NativeLifecycleTest extends WP_UnitTestCase {
    public function test_post_insert_read_update_and_transaction_reset(): void {
        $post_id = self::factory()->post->create(array('post_title' => 'first title'));
        $this->assertSame('first title', get_post($post_id)->post_title);
        wp_update_post(array('ID' => $post_id, 'post_title' => 'updated title'));
        $this->assertSame('updated title', get_post($post_id)->post_title);
    }
}
`)
  const recipe = buildWordPressPhpunitRecipe({
    pluginSlug: "mdi-native-phpunit-fixture",
    databaseType: "mdi-native",
    extra_plugins: [{ source: plugin, slug: "mdi-native-phpunit-fixture", activate: false }],
    dependencyMounts: ["/wordpress/wp-content/plugins/mdi-native-phpunit-fixture"],
    mounts: [{ source: join(harness, "vendor"), target: "/wp-codebox-vendor", mode: "readonly" }],
  })
  await writeFile(recipePath, `${JSON.stringify(recipe)}\n`)

  const result = await runRecipe(recipePath, artifactsPath)
  assert.equal(result.success, false, "the pinned MDI revision must expose, not bypass, its installer incompatibility")
  assert.match(result.error?.message ?? "", /mysqli_select_db\(\): Argument #1 \(\$mysql\) must be of type mysqli, null given/)
  assert.doesNotMatch(result.error?.message ?? "", /failureClassification=mdi_native_unsupported_query/)
} finally {
  await rm(root, { recursive: true, force: true })
}

async function runRecipe(recipePath: string, artifactsPath: string): Promise<{ success?: boolean, error?: { message?: string } }> {
  try {
    const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], {
      cwd: process.cwd(), timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
    })
    return JSON.parse(result.stdout)
  } catch (error) {
    assert(error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string")
    return JSON.parse(error.stdout)
  }
}

console.log("mdi-native PHPUnit installer regression evidence ok")
