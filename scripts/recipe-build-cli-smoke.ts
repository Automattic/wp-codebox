import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "../packages/cli/src/cli-entry.js"

const directory = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-build-cli-"))
const optionsPath = join(directory, "phpunit-options.json")
const outputPath = join(directory, "phpunit-recipe.json")
const benchOptionsPath = join(directory, "bench-options.json")
const benchOutputPath = join(directory, "bench-recipe.json")

await writeFile(optionsPath, JSON.stringify({
  wordpressVersion: "6.10",
  mounts: [{ source: "/repo/plugin", target: "/wordpress/wp-content/plugins/demo" }],
  pluginSlug: "demo",
  selectedTestFile: "tests/DemoTest.php",
  changedTestFiles: ["tests/DemoTest.php"],
  env: { HOMEBOY_FLAG: "yes" },
  wpConfigDefines: { WP_DEBUG: true },
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  dependencyMounts: ["/wordpress/wp-content/plugins/dep"],
  bootstrapFiles: ["tests/managed-bootstrap.php"],
  phpunitArgs: ["--filter", "DemoTest::test_selected"],
  bootstrapMode: "project",
  projectBootstrap: "tests/bootstrap.php",
  multisite: true,
}, null, 2))

const exitCode = await runCli(["recipe", "build", "phpunit", "--options", optionsPath, "--output", outputPath])
assert.equal(exitCode, 0)

const recipe = JSON.parse(await readFile(outputPath, "utf8"))
assert.equal(recipe.schema, "wp-codebox/workspace-recipe/v1")
assert.equal(recipe.runtime.wp, "6.10")
assert.equal(recipe.workflow.steps[0].command, "wordpress.phpunit")
assert.deepEqual(recipe.inputs.mounts, [{ source: "/repo/plugin", target: "/wordpress/wp-content/plugins/demo", mode: "readwrite" }])
assert.deepEqual(recipe.workflow.steps[0].args, [
  "plugin-slug=demo",
  "cwd=/wordpress/wp-content/plugins/demo",
  "test-file=tests/DemoTest.php",
  'changed-tests-json=["tests/DemoTest.php"]',
  'env-json={"HOMEBOY_FLAG":"yes"}',
  'wp-config-defines-json={"WP_DEBUG":true}',
  "autoload-file=/wp-codebox-vendor/autoload.php",
  "tests-dir=/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  "dependency-mounts=/wordpress/wp-content/plugins/dep",
  'bootstrap-files-json=["tests/managed-bootstrap.php"]',
  'phpunit-args-json=["--filter","DemoTest::test_selected"]',
  "bootstrap-mode=project",
  "project-bootstrap=tests/bootstrap.php",
  "multisite=1",
])

await writeFile(benchOptionsPath, JSON.stringify({
  wordpressVersion: "6.10",
  blueprint: { steps: [{ step: "login", username: "admin", password: "password" }] },
  mounts: [{ source: "/repo/db.php", target: "/wordpress/wp-content/db.php", type: "file" }],
  extra_plugins: [{ source: "/repo/plugin", slug: "demo", pluginFile: "demo/demo.php", activate: true }],
  componentId: "demo-component",
  pluginSlug: "demo",
  iterations: 7,
  warmupIterations: 2,
  dependencySlugs: ["dependency-plugin"],
  env: { BENCH_FLAG: "yes" },
  wpConfigDefines: { SAVEQUERIES: true },
  bootstrapFiles: ["bench/bootstrap.php"],
  workloads: [{ id: "homepage", path: "/" }],
  scenarioIds: ["homepage", " ", "homepage"],
  lifecycle: { setup: [{ type: "php", code: "update_option('bench_setup', 'yes');" }] },
  resetPolicy: { betweenIterations: "object-cache" },
}, null, 2))

const benchExitCode = await runCli(["recipe", "build", "bench", "--options", benchOptionsPath, "--output", benchOutputPath])
assert.equal(benchExitCode, 0)

const benchRecipe = JSON.parse(await readFile(benchOutputPath, "utf8"))
assert.equal(benchRecipe.schema, "wp-codebox/workspace-recipe/v1")
assert.equal(benchRecipe.runtime.wp, "6.10")
assert.deepEqual(benchRecipe.runtime.blueprint, {
  steps: [
    { step: "login", username: "admin", password: "password" },
    { step: "defineWpConfigConsts", consts: { SAVEQUERIES: true } },
  ],
})
assert.equal(benchRecipe.workflow.steps[0].command, "wordpress.bench")
assert.deepEqual(benchRecipe.inputs.mounts, [{ source: "/repo/db.php", target: "/wordpress/wp-content/db.php", mode: "readonly", type: "file" }])
assert.deepEqual(benchRecipe.inputs.extra_plugins, [{ source: "/repo/plugin", slug: "demo", pluginFile: "demo/demo.php", activate: true }])
assert.deepEqual(benchRecipe.workflow.steps[0].args, [
  "component-id=demo-component",
  "plugin-slug=demo",
  "iterations=7",
  "warmup=2",
  "dependency-slugs=dependency-plugin",
  'env-json={"BENCH_FLAG":"yes"}',
  'bootstrap-files-json=["bench/bootstrap.php"]',
  'workloads-json=[{"id":"homepage","path":"/"}]',
  'scenario-ids-json=["homepage"]',
  'lifecycle-json={"setup":[{"type":"php","code":"update_option(\'bench_setup\', \'yes\');"}]}',
  'reset-policy-json={"betweenIterations":"object-cache"}',
])

console.log("recipe build cli smoke passed")
