import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_WORDPRESS_VERSION, createBenchmarkDefinitionJsonSchema, createBenchResultsJsonSchema, createWorkspaceRecipeJsonSchema } from "@automattic/wp-codebox-core"
import { recipeCommandDefinitions } from "@automattic/wp-codebox-core/contracts"
import { buildWordPressBenchRecipe, buildWordPressPhpunitRecipe } from "@automattic/wp-codebox-core/recipe-builders"
import Ajv2020 from "ajv/dist/2020.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")

const recipeCommandIds = recipeCommandDefinitions().filter((command) => command.recipe).map((command) => command.id)
const ajv = new Ajv2020({ strict: false })
const validate = ajv.compile(createWorkspaceRecipeJsonSchema({ recipeCommandIds }))
const validateBenchmarkDefinition = ajv.compile(createBenchmarkDefinitionJsonSchema())
const validateBenchResults = ajv.compile(createBenchResultsJsonSchema())

const phpunitRecipe = buildWordPressPhpunitRecipe({
  wordpressVersion: "6.9",
  pluginSlug: "demo-plugin",
  pluginSource: "/repo/demo-plugin-source",
  cwd: "tests/phpunit",
  selectedTestFile: "tests/unit/DemoTest.php",
  changedTestFiles: ["tests/unit/DemoTest.php"],
  env: { DEMO_ENV: "yes" },
  wpConfigDefines: { DEMO_DEFINE: true },
  dependencyMounts: ["/wordpress/wp-content/plugins/demo-dependency"],
  bootstrapFiles: ["tests/managed-bootstrap.php"],
  phpunitArgs: ["--filter", "DemoTest::test_selected"],
  bootstrapMode: "project",
  projectBootstrap: "tests/bootstrap.php",
  multisite: true,
  prepareSteps: [{
    command: "host/prepare-php",
    args: ['input-json={"args":["bin/generate-feature-config.php"],"cwd":"/repo/demo-plugin-source"}'],
  }],
  mounts: [
    { source: "/repo/vendor", target: "/wp-codebox-vendor", mode: "readonly" },
  ],
})

assert.equal(buildWordPressPhpunitRecipe({ pluginSlug: "demo-plugin" }).runtime?.wp, DEFAULT_WORDPRESS_VERSION)
assert.equal(buildWordPressBenchRecipe({ pluginSlug: "demo-plugin" }).runtime?.wp, DEFAULT_WORDPRESS_VERSION)

assert.equal(phpunitRecipe.inputs?.mounts?.[0]?.mode, "readwrite")
assert.deepEqual(phpunitRecipe.inputs?.mounts?.[0], { source: "/repo/demo-plugin-source", target: "/wordpress/wp-content/plugins/demo-plugin", mode: "readwrite" })
assert.deepEqual(phpunitRecipe.inputs?.mounts?.[1], { source: "/repo/vendor", target: "/wp-codebox-vendor", mode: "readonly" })
assert.deepEqual(phpunitRecipe.workflow.before, [{
  command: "host/prepare-php",
  args: ['input-json={"args":["bin/generate-feature-config.php"],"cwd":"/repo/demo-plugin-source"}'],
}])
assert.deepEqual(phpunitRecipe.workflow.steps[0]?.args, [
  "plugin-slug=demo-plugin",
  "cwd=tests/phpunit",
  "test-file=tests/unit/DemoTest.php",
  'changed-tests-json=["tests/unit/DemoTest.php"]',
  'env-json={"DEMO_ENV":"yes"}',
  'wp-config-defines-json={"DEMO_DEFINE":true}',
  "autoload-file=/wp-codebox-vendor/autoload.php",
  "tests-dir=/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  "dependency-mounts=/wordpress/wp-content/plugins/demo-dependency",
  'bootstrap-files-json=["tests/managed-bootstrap.php"]',
  'phpunit-args-json=["--filter","DemoTest::test_selected"]',
  "bootstrap-mode=project",
  "project-bootstrap=tests/bootstrap.php",
  "multisite=1",
])
assert.ok(validate(phpunitRecipe), ajv.errorsText(validate.errors))

const workspace = mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-prepare-builder-"))
const recipePath = join(workspace, "recipe.json")
writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    before: phpunitRecipe.workflow.before,
    steps: [{ command: "wordpress.run-php", args: ["code=echo 'ok';"] }],
  },
}, null, 2)}\n`)
const validateRecipe = spawnSync(process.execPath, [cli, "recipe", "validate", "--recipe", recipePath, "--json"], { cwd: root, encoding: "utf8" })
assert.equal(validateRecipe.status, 0, validateRecipe.stderr || validateRecipe.stdout)
assert.equal(JSON.parse(validateRecipe.stdout).valid, true)

const benchRecipe = buildWordPressBenchRecipe({
  wordpressVersion: "7.0",
  componentId: "demo-component",
  pluginSlug: "demo-plugin",
  iterations: 5,
  warmupIterations: 0,
  dependencySlugs: ["demo-dependency"],
  env: { BENCH_ENV: "yes" },
  wpConfigDefines: { BENCH_DEFINE: "defined" },
  bootstrapFiles: ["tests/bench/bootstrap.php"],
  workloads: [{ id: "noop", file: "tests/bench/noop.php" }],
  scenarioIds: ["noop", " ", "noop"],
  lifecycle: { setup: [{ type: "php", code: "update_option('bench_setup', 'yes');" }] },
  resetPolicy: { betweenIterations: "object-cache" },
  extra_plugins: [{ source: "/repo/demo-plugin", slug: "demo-plugin", pluginFile: "demo-plugin/demo.php", activate: false }],
  mounts: [{ source: "/repo/db.php", target: "/wordpress/wp-content/db.php" }],
})

assert.equal(benchRecipe.inputs?.mounts?.[0]?.mode, "readonly")
assert.deepEqual(benchRecipe.runtime?.blueprint, {
  steps: [{ step: "defineWpConfigConsts", consts: { BENCH_DEFINE: "defined" } }],
})
assert.deepEqual(benchRecipe.workflow.steps[0]?.args, [
  "component-id=demo-component",
  "plugin-slug=demo-plugin",
  "iterations=5",
  "warmup=0",
  "dependency-slugs=demo-dependency",
  'env-json={"BENCH_ENV":"yes"}',
  'bootstrap-files-json=["tests/bench/bootstrap.php"]',
  'workloads-json=[{"id":"noop","file":"tests/bench/noop.php"}]',
  'scenario-ids-json=["noop"]',
  'lifecycle-json={"setup":[{"type":"php","code":"update_option(\'bench_setup\', \'yes\');"}]}',
  'reset-policy-json={"betweenIterations":"object-cache"}',
])
assert.ok(validate(benchRecipe), ajv.errorsText(validate.errors))
const benchRecipePath = join(workspace, "bench-recipe.json")
writeFileSync(benchRecipePath, `${JSON.stringify(buildWordPressBenchRecipe({ pluginSlug: "demo-plugin", scenarioIds: ["noop"] }), null, 2)}\n`)
const validateBenchRecipe = spawnSync(process.execPath, [cli, "recipe", "validate", "--recipe", benchRecipePath, "--json"], { cwd: root, encoding: "utf8" })
assert.equal(validateBenchRecipe.status, 0, validateBenchRecipe.stderr || validateBenchRecipe.stdout)
assert.equal(JSON.parse(validateBenchRecipe.stdout).valid, true)
assert.ok(validateBenchmarkDefinition({
  schema: "wp-codebox/benchmark-definition/v1",
  component_id: "demo-component",
  plugin_slug: "demo-plugin",
  iterations: 5,
  warmup_iterations: 0,
  dependency_slugs: ["demo-dependency"],
  env: { BENCH_ENV: "yes" },
  bootstrap_files: ["tests/bench/bootstrap.php"],
  workloads: [{ id: "noop", file: "tests/bench/noop.php" }],
}), ajv.errorsText(validateBenchmarkDefinition.errors))
assert.deepEqual(buildWordPressBenchRecipe({ pluginSlug: "demo-plugin" }).workflow.steps[0]?.args, [
  "component-id=demo-plugin",
  "plugin-slug=demo-plugin",
  "iterations=3",
  "warmup=1",
  "dependency-slugs=",
  "env-json={}",
  "bootstrap-files-json=[]",
  "workloads-json=[]",
  "scenario-ids-json=[]",
  "lifecycle-json={}",
  "reset-policy-json={}",
])
assert.ok(validateBenchResults({
  schema: "wp-codebox/bench-results/v1",
  component_id: "demo-component",
  iterations: 5,
  warmup_iterations: 0,
  scenarios: [{
    id: "noop",
    source: "in_tree",
    file: "tests/bench/noop.php",
    iterations: 5,
    metrics: {
      duration: {
        unit: "ms",
        samples: { count: 5, mean: 1, p50: 1, p95: 1, p99: 1, min: 1, max: 1 },
      },
    },
    diagnostics: [],
  }],
  diagnostics: [],
  provenance: { command: "wordpress.bench", component: { id: "demo-component", plugin_slug: "demo-plugin" } },
}), ajv.errorsText(validateBenchResults.errors))

assert.throws(() => buildWordPressPhpunitRecipe({ pluginSlug: "", mounts: [{ source: "/repo/plugin", target: "wordpress/wp-content/plugins/demo" }] }), /requires pluginSlug/)
assert.throws(() => buildWordPressBenchRecipe({ pluginSlug: "demo", mounts: [{ source: "/repo/plugin", target: "wordpress/wp-content/plugins/demo" }] }), /absolute target/)

console.log("wordpress recipe builders smoke passed")
