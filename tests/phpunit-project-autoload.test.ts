import assert from "node:assert/strict"

import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"
import { phpunitRunCode } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { recipePolicy } from "../packages/cli/src/recipe-validation.js"
import { recipeExtraPluginSourceSubpath } from "../packages/cli/src/recipe-sources.js"

const woocommerceAutoload = "/wordpress/wp-content/plugins/woocommerce/vendor/autoload_packages.php"

const recipe = buildWordPressPhpunitRecipe({
  pluginSlug: "woocommerce",
  extra_plugins: [{
    source: "/workspace/woocommerce",
    sourceRoot: "/workspace/woocommerce",
    sourceSubpath: "plugins/woocommerce",
    slug: "woocommerce",
    pluginFile: "woocommerce/woocommerce.php",
    activate: false,
  }],
  bootstrapMode: "project",
  projectBootstrap: "tests/legacy/bootstrap.php",
  projectAutoloadFile: woocommerceAutoload,
  cwd: "/home/example/public_html",
  testRoot: "/home/example/public_html/bin/tests/phpunit",
  phpunitXml: "/home/example/public_html/bin/tests/phpunit/phpunit.xml.dist",
  mounts: [{ source: "/workspace/project-tests", target: "/home/example/public_html/bin/tests", mode: "readonly" }],
})

assert.deepEqual(recipe.inputs.extra_plugins, [{
  source: "/workspace/woocommerce",
  sourceRoot: "/workspace/woocommerce",
  sourceSubpath: "plugins/woocommerce",
  slug: "woocommerce",
  pluginFile: "woocommerce/woocommerce.php",
  activate: false,
}])

assert.equal(recipeExtraPluginSourceSubpath(recipe.inputs.extra_plugins[0], "/tmp"), "plugins/woocommerce")
assert.equal(recipePolicy(recipe).commands.includes("wordpress.run-php"), true)
assert.deepEqual(recipe.inputs.mounts?.filter((mount) => mount.target === "/home/example/public_html/bin/tests"), [
  { source: "/workspace/project-tests", target: "/home/example/public_html/bin/tests", mode: "readonly" },
])

assert.deepEqual(recipe.workflow.steps[0].args.filter((arg) => arg.includes("autoload-file=")), [
  "autoload-file=/wp-codebox-vendor/autoload.php",
  `project-autoload-file=${woocommerceAutoload}`,
])
assert.ok(recipe.workflow.steps[0].args.includes("cwd=/home/example/public_html"))
assert.ok(recipe.workflow.steps[0].args.includes("test-root=/home/example/public_html/bin/tests/phpunit"))
assert.ok(recipe.workflow.steps[0].args.includes("phpunit-xml=/home/example/public_html/bin/tests/phpunit/phpunit.xml.dist"))

const projectModeCode = phpunitRunCode({
  pluginSlug: "woocommerce",
  cwd: "/wordpress/wp-content/plugins/woocommerce",
  autoloadFile: woocommerceAutoload,
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  testRoot: "/home/example/public_html/bin/tests/phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/woocommerce/phpunit.xml.dist",
  selectedTestFile: "",
  changedTestFiles: [],
  phpunitArgs: ["--list-tests"],
  env: {},
  wpConfigDefines: {},
  dependencyMounts: [],
  bootstrapFiles: [],
  bootstrapMode: "project",
  projectBootstrap: "tests/legacy/bootstrap.php",
  multisite: false,
})

const bootIndex = projectModeCode.indexOf("$config_path = pg_run_boot_stage")
const projectBootstrapIndex = projectModeCode.indexOf("pg_run_project_bootstrap_stage", bootIndex)
const projectAutoloadIndex = projectModeCode.indexOf("pg_run_project_autoload_stage", projectBootstrapIndex)
assert.ok(bootIndex > 0)
assert.ok(projectBootstrapIndex > bootIndex)
assert.ok(projectAutoloadIndex > projectBootstrapIndex)
assert.ok(projectModeCode.includes("'autoload_required' => $bootstrap_mode !== 'project'"))
assert.ok(projectModeCode.includes("$legacy_project_autoload_file = $autoload_file"))
assert.ok(projectModeCode.includes("NOTICE:project bootstrap mode continuing without readable PHPUnit harness autoload"))
assert.ok(projectModeCode.includes("$test_root = \"/home/example/public_html/bin/tests/phpunit\";"))
assert.ok(projectModeCode.includes("pg_resolve_test_root"))

const managedModeCode = phpunitRunCode({
  pluginSlug: "demo-plugin",
  cwd: "/wordpress/wp-content/plugins/demo-plugin",
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/demo-plugin/phpunit.xml.dist",
  selectedTestFile: "",
  changedTestFiles: [],
  phpunitArgs: [],
  env: {},
  wpConfigDefines: {},
  dependencyMounts: [],
  bootstrapFiles: [],
  bootstrapMode: "managed",
  projectBootstrap: "",
  multisite: false,
})

assert.ok(managedModeCode.includes("configured PHPUnit harness autoload file is not readable"))

console.log("phpunit project autoload ok")
