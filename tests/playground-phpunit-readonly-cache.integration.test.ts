import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-phpunit-readonly-"))
const plugin = join(root, "plugin")
const dependency = join(root, "dependency")
const harness = join(root, "harness")
const recipePath = join(root, "recipe.json")
const artifactsPath = join(root, "artifacts")
const sentinel = Buffer.from([0, 255, 1, 2, 3, 127, 128])

try {
  await cp("tests/fixtures/phpunit-playground-harness", harness, { recursive: true })
  await execFileAsync("composer", ["install", "--no-interaction", "--prefer-dist"], { cwd: harness, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })
  await writeFixture()
  const sourceDigest = await digestTree(plugin)

  const recipe = buildWordPressPhpunitRecipe({
    pluginSlug: "readonly-phpunit-fixture",
    extra_plugins: [{
      source: plugin,
      slug: "readonly-phpunit-fixture",
      activate: false,
    }, {
      source: dependency,
      slug: "activation-dependency",
      activate: false,
    }],
    dependencyMounts: ["/wordpress/wp-content/plugins/readonly-phpunit-fixture", "/wordpress/wp-content/plugins/activation-dependency"],
    mounts: [
      { source: join(harness, "vendor"), target: "/wp-codebox-vendor", mode: "readonly" },
    ],
  })
  await writeFile(recipePath, `${JSON.stringify(recipe)}\n`)

  const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], {
    cwd: process.cwd(),
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const output = JSON.parse(result.stdout) as { success?: boolean }
  assert.equal(output.success, true, result.stdout)
  assert.equal(await digestTree(plugin), sourceDigest, "readonly plugin source tree must remain unchanged after actual PHPUnit execution")
  await assert.rejects(readFile(join(plugin, ".phpunit.result.cache")), /ENOENT/, "PHPUnit must not create a host-source result cache")
  const runtime = JSON.parse(await readFile(join(artifactsPath, "latest-runtime.json"), "utf8")) as { paths?: { runtimeDirectory?: string } }
  const diagnostic = await readFile(join(artifactsPath, runtime.paths?.runtimeDirectory ?? "", "files/phpunit/.pg-test-result.txt"), "utf8")
  assert.match(diagnostic, /^STAGE_BEGIN:run_tests/m, "actual PHPUnit runner must reach its test stage")
} finally {
  await rm(root, { recursive: true, force: true })
}

async function writeFixture(): Promise<void> {
  await mkdir(join(plugin, "tests"), { recursive: true })
  await mkdir(dependency, { recursive: true })
  await writeFile(join(plugin, "readonly-phpunit-fixture.php"), "<?php\n/**\n * Plugin Name: Readonly PHPUnit Fixture\n */\n")
  await writeFile(join(plugin, "source-sentinel.bin"), sentinel)
  await writeFile(join(plugin, "tests", "ReadonlyCacheTest.php"), "<?php\nclass ReadonlyCacheTest extends WP_UnitTestCase { public function test_sentinel_is_available(): void { $this->assertGreaterThan(0, filesize(dirname(__DIR__) . \'/source-sentinel.bin\')); } public function test_dependency_activation_runs_after_install(): void { $this->assertGreaterThanOrEqual(1, get_option(\'wp_codebox_dependency_activation_users\')); } public function test_dependency_plugins_loaded_runs_once(): void { $this->assertSame(1, (int) get_option(\'wp_codebox_dependency_plugins_loaded_count\')); } }\n")
  await writeFile(join(dependency, "activation-dependency.php"), "<?php\n/**\n * Plugin Name: Activation Dependency\n */\nadd_action('plugins_loaded', static function (): void { update_option('wp_codebox_dependency_plugins_loaded_count', (int) get_option('wp_codebox_dependency_plugins_loaded_count', 0) + 1); });\nregister_activation_hook(__FILE__, static function (): void { update_option('wp_codebox_dependency_activation_users', count(get_users(array('number' => 1)))); });\n")
}

async function digestTree(directory: string): Promise<string> {
  const files = ["readonly-phpunit-fixture.php", "source-sentinel.bin", "tests/ReadonlyCacheTest.php"]
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file)
    hash.update(await readFile(join(directory, file)))
  }
  return hash.digest("hex")
}

console.log("playground phpunit readonly cache integration ok")
