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
const failingArtifactsPath = join(root, "failing-artifacts")
const sentinel = Buffer.from([0, 255, 1, 2, 3, 127, 128])

try {
  await cp("tests/fixtures/phpunit-playground-harness", harness, { recursive: true })
  await execFileAsync("composer", ["install", "--no-interaction", "--prefer-dist"], { cwd: harness, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })
  const autoloadReal = await readFile(join(harness, "vendor", "composer", "autoload_real.php"), "utf8")
  const staticClass = autoloadReal.match(/ComposerStaticInit[\da-f]+/i)?.[0]
  assert.ok(staticClass, "fixture uses Composer's optimized static autoloader")
  assert.match(await readFile(join(harness, "vendor", "composer", "autoload_static.php"), "utf8"), new RegExp(`class ${staticClass}`), "generated Composer autoload files define the same static initializer")
  await writeFixture()
  const sourceDigest = await digestTree(plugin)

  const recipe = buildWordPressPhpunitRecipe({
    pluginSlug: "readonly-phpunit-fixture",
    multisite: true,
    extra_plugins: [{
      source: plugin,
      slug: "readonly-phpunit-fixture",
      activate: false,
    }, {
      source: dependency,
      slug: "activation-dependency",
      activate: true,
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
  assert.match(diagnostic, /^DISCOVERY: .* found=1$/m, "actual PHPUnit runner must discover the fixture test file")
  assert.match(diagnostic, /^STAGE_BEGIN:run_tests/m, "actual PHPUnit runner must reach its test stage")
  const passingEvidence = await readTestResults(artifactsPath, runtime.paths?.runtimeDirectory)
  const completedResult = await readFile(join(artifactsPath, runtime.paths?.runtimeDirectory ?? "", "files/phpunit/.wp-codebox-result.txt"), "utf8").catch((error) => String(error))
  assert.match(completedResult, /"status":"passed","total":6/)
  assert.equal(passingEvidence.status, "passed")
  assert.deepEqual(passingEvidence.summary, { total: 6, passed: 6, failed: 0, skipped: 0, unknown: 0 })

  await writeFile(join(plugin, "tests", "ReadonlyCacheTest.php"), "<?php\nclass ReadonlyCacheTest extends WP_UnitTestCase { public function test_passes(): void { $this->assertTrue(true); } public function test_fails(): void { $this->assertTrue(false); } public function test_errors(): void { throw new RuntimeException('fixture error'); } public function test_skips(): void { $this->markTestSkipped('fixture skipped'); } }\n")
  const failedOutput = await runFailedRecipe()
  assert.equal(failedOutput.success, false)
  assert.match(failedOutput.error?.message ?? "", /failureClassification=runtime-command-failure/)
  assert.doesNotMatch(failedOutput.error?.message ?? "", /crashed before producing a structured response/)
  const failedRuntime = JSON.parse(await readFile(join(failingArtifactsPath, "latest-runtime.json"), "utf8")) as { paths?: { runtimeDirectory?: string } }
  const failingEvidence = await readTestResults(failingArtifactsPath, failedRuntime.paths?.runtimeDirectory)
  assert.equal(failingEvidence.status, "failed")
  assert.deepEqual(failingEvidence.summary, { total: 4, passed: 1, failed: 2, skipped: 1, unknown: 0 })
  assert(failingEvidence.rawLogReferences.some((reference) => reference.path === "files/phpunit/.pg-test-result.txt"))
} finally {
  await rm(root, { recursive: true, force: true })
}

async function runFailedRecipe(): Promise<{ success?: boolean, error?: { message?: string } }> {
  try {
    const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", failingArtifactsPath, "--json"], {
      cwd: process.cwd(), timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
    })
    return JSON.parse(result.stdout)
  } catch (error) {
    assert(error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string")
    return JSON.parse(error.stdout)
  }
}

async function readTestResults(artifactPath: string, runtimeDirectory?: string): Promise<{ status: string, summary: { total: number, passed: number, failed: number, skipped: number, unknown: number }, rawLogReferences: Array<{ path: string }> }> {
  assert.ok(runtimeDirectory, "recipe must retain a runtime artifact directory")
  return JSON.parse(await readFile(join(artifactPath, runtimeDirectory, "files/test-results.json"), "utf8"))
}

async function writeFixture(): Promise<void> {
  await mkdir(join(plugin, "tests"), { recursive: true })
  await mkdir(dependency, { recursive: true })
  await writeFile(join(plugin, "readonly-phpunit-fixture.php"), "<?php\n/**\n * Plugin Name: Readonly PHPUnit Fixture\n */\nadd_action('init', static function (): void { update_option('wp_codebox_parent_init_ran', 1); add_action('init', static function (): void { update_option('wp_codebox_nested_init_ran', 1); }, 15); }, 0);\n")
  await writeFile(join(plugin, "phpunit.xml.dist"), "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<phpunit><testsuites><testsuite name=\"readonly-cache\"><directory>tests</directory></testsuite></testsuites></phpunit>\n")
  await writeFile(join(plugin, "source-sentinel.bin"), sentinel)
  await writeFile(join(plugin, "tests", "ReadonlyCacheTest.php"), "<?php\nclass ReadonlyCacheTest extends WP_UnitTestCase { public function test_multisite_runtime_is_active(): void { $this->assertTrue(is_multisite()); } public function test_nested_init_callbacks_run_in_priority_order(): void { $this->assertSame(1, (int) get_option(\'wp_codebox_parent_init_ran\')); $this->assertSame(1, (int) get_option(\'wp_codebox_nested_init_ran\')); } public function test_sentinel_is_available(): void { $this->assertGreaterThan(0, filesize(dirname(__DIR__) . \'/source-sentinel.bin\')); } public function test_dependency_activation_runs_after_install(): void { $this->assertGreaterThanOrEqual(1, get_option(\'wp_codebox_dependency_activation_users\')); } public function test_dependency_plugins_loaded_runs_once(): void { $this->assertSame(1, (int) get_option(\'wp_codebox_dependency_plugins_loaded_count\')); } public function test_wp_cli_namespaced_stdout_is_available(): void { $this->assertTrue(eval(\'namespace cli; return is_resource(STDOUT);\')); } }\n")
  await writeFile(join(dependency, "activation-dependency.php"), "<?php\n/**\n * Plugin Name: Activation Dependency\n */\nadd_action('plugins_loaded', static function (): void { update_option('wp_codebox_dependency_plugins_loaded_count', (int) get_option('wp_codebox_dependency_plugins_loaded_count', 0) + 1); });\nregister_activation_hook(__FILE__, static function (): void { update_option('wp_codebox_dependency_activation_users', count(get_users(array('number' => 1)))); });\n")
}

async function digestTree(directory: string): Promise<string> {
  const files = ["readonly-phpunit-fixture.php", "phpunit.xml.dist", "source-sentinel.bin", "tests/ReadonlyCacheTest.php"]
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file)
    hash.update(await readFile(join(directory, file)))
  }
  return hash.digest("hex")
}

console.log("playground phpunit readonly cache integration ok")
