import assert from "node:assert/strict"
import { buildWordPressBenchRecipe, buildWordPressPhpunitRecipe, createWorkspaceRecipeJsonSchema, recipeCommandDefinitions } from "@automattic/wp-codebox-core"
import Ajv2020 from "ajv/dist/2020.js"

const recipeCommandIds = recipeCommandDefinitions().filter((command) => command.recipe).map((command) => command.id)
const ajv = new Ajv2020({ strict: false })
const validate = ajv.compile(createWorkspaceRecipeJsonSchema({ recipeCommandIds }))

const phpunitRecipe = buildWordPressPhpunitRecipe({
  wordpressVersion: "6.9",
  pluginSlug: "demo-plugin",
  selectedTestFile: "tests/unit/DemoTest.php",
  changedTestFiles: ["tests/unit/DemoTest.php"],
  env: { DEMO_ENV: "yes" },
  wpConfigDefines: { DEMO_DEFINE: true },
  dependencyMounts: ["/wordpress/wp-content/plugins/demo-dependency"],
  multisite: true,
  mounts: [
    { source: "/repo/demo-plugin", target: "/wordpress/wp-content/plugins/demo-plugin" },
    { source: "/repo/vendor", target: "/wp-codebox-vendor", mode: "readonly" },
  ],
})

assert.equal(phpunitRecipe.inputs?.mounts?.[0]?.mode, "readwrite")
assert.deepEqual(phpunitRecipe.workflow.steps[0]?.args, [
  "plugin-slug=demo-plugin",
  "test-file=tests/unit/DemoTest.php",
  'changed-tests-json=["tests/unit/DemoTest.php"]',
  'env-json={"DEMO_ENV":"yes"}',
  'wp-config-defines-json={"DEMO_DEFINE":true}',
  "autoload-file=/wp-codebox-vendor/autoload.php",
  "tests-dir=/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  "dependency-mounts=/wordpress/wp-content/plugins/demo-dependency",
  "multisite=1",
])
assert.ok(validate(phpunitRecipe), ajv.errorsText(validate.errors))

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
  extraPlugins: [{ source: "/repo/demo-plugin", slug: "demo-plugin", pluginFile: "demo-plugin/demo.php", activate: false }],
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
])
assert.ok(validate(benchRecipe), ajv.errorsText(validate.errors))

assert.throws(() => buildWordPressPhpunitRecipe({ pluginSlug: "", mounts: [{ source: "/repo/plugin", target: "wordpress/wp-content/plugins/demo" }] }), /requires pluginSlug/)
assert.throws(() => buildWordPressBenchRecipe({ pluginSlug: "demo", mounts: [{ source: "/repo/plugin", target: "wordpress/wp-content/plugins/demo" }] }), /absolute target/)

console.log("wordpress recipe builders smoke passed")
