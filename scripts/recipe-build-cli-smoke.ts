import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "../packages/cli/src/cli-entry.js"

const directory = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-build-cli-"))
const optionsPath = join(directory, "phpunit-options.json")
const outputPath = join(directory, "phpunit-recipe.json")

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
  "test-file=tests/DemoTest.php",
  'changed-tests-json=["tests/DemoTest.php"]',
  'env-json={"HOMEBOY_FLAG":"yes"}',
  'wp-config-defines-json={"WP_DEBUG":true}',
  "autoload-file=/wp-codebox-vendor/autoload.php",
  "tests-dir=/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  "dependency-mounts=/wordpress/wp-content/plugins/dep",
  "multisite=1",
])

console.log("recipe build cli smoke passed")
