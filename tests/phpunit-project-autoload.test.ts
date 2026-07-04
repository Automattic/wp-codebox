import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"
import { corePhpunitRunCode, phpunitRunCode } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { recipePolicy } from "../packages/cli/src/recipe-validation.js"
import { recipeExtraPluginSourceSubpath } from "../packages/cli/src/recipe-sources.js"
import { recipeInputMountPathMap, rewriteInputMountPathArgs } from "../packages/cli/src/commands/recipe-runtime-setup.js"

const woocommerceAutoload = "/wordpress/wp-content/plugins/woocommerce/vendor/autoload_packages.php"

function extractPhpFunction(source: string, functionName: string): string {
  const start = source.indexOf(`function ${functionName}(`)
  assert.notEqual(start, -1)

  let depth = 0
  let sawBody = false
  for (let index = start; index < source.length; index++) {
    const character = source[index]
    if (character === "{") {
      depth++
      sawBody = true
    } else if (character === "}") {
      depth--
      if (sawBody && depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }

  throw new Error(`Could not extract PHP function ${functionName}`)
}

function phpString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}

function assertPhpunitParseConfigFallbacksReturnFiveTuple(source: string, functionName: string, logFunctionName: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-config-"))
  const malformedXml = join(tempDir, "phpunit.xml.dist")
  const scriptPath = join(tempDir, "assert-phpunit-config.php")
  writeFileSync(malformedXml, "<phpunit><testsuites>")

  const parseConfigFunction = extractPhpFunction(source, functionName)
  writeFileSync(scriptPath, `<?php
function ${logFunctionName}($message) {}
${parseConfigFunction}
function assert_phpunit_config_tuple($tuple, $label) {
    if (!is_array($tuple) || count($tuple) !== 5) {
        throw new RuntimeException($label . ' returned ' . gettype($tuple) . ' with ' . (is_array($tuple) ? count($tuple) : 'n/a') . ' values');
    }
    if (!is_array($tuple[4])) {
        throw new RuntimeException($label . ' returned non-array configured files');
    }
}
assert_phpunit_config_tuple(${functionName}(${phpString(join(tempDir, "missing.xml.dist"))}, ${phpString(join(tempDir, "tests"))}), 'missing config');
assert_phpunit_config_tuple(${functionName}(${phpString(malformedXml)}, ${phpString(join(tempDir, "tests"))}), 'parse failure');
echo "ok\n";
`)

  assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "ok\n")
}

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
  mounts: [
    { source: "/workspace/wp-codebox-vendor", target: "/wp-codebox-vendor", mode: "readonly" },
    { source: "/workspace/project-tests", target: "/home/example/public_html/bin/tests", mode: "readonly" },
  ],
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
assert.deepEqual(recipe.inputs.mounts?.filter((mount) => mount.target === "/wp-codebox-vendor" || mount.target === "/home/example/public_html/bin/tests"), [
  { source: "/workspace/wp-codebox-vendor", target: "/wp-codebox-vendor", mode: "readonly" },
  { source: "/workspace/project-tests", target: "/home/example/public_html/bin/tests", mode: "readonly" },
])

assert.deepEqual(recipe.workflow.steps[0].args.filter((arg) => arg.includes("autoload-file=")), [
  "autoload-file=/wp-codebox-vendor/autoload.php",
  `project-autoload-file=${woocommerceAutoload}`,
])
assert.deepEqual(rewriteInputMountPathArgs(recipe.workflow.steps[0].args, recipeInputMountPathMap(recipe)).filter((arg) => arg.includes("autoload-file=")), [
  "autoload-file=/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/autoload.php",
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
assert.ok(projectModeCode.includes("'autoload_required' => $bootstrap_mode !== 'project' || $harness_autoload_file !== ''"))
assert.ok(projectModeCode.includes("$legacy_project_autoload_file = $autoload_file"))
assert.ok(projectModeCode.includes("configured PHPUnit harness autoload file is not readable"))
assert.ok(projectModeCode.includes("NOTICE:project bootstrap mode continuing without configured PHPUnit harness autoload"))
assert.ok(projectModeCode.includes("$test_root = \"/home/example/public_html/bin/tests/phpunit\";"))
assert.ok(projectModeCode.includes("pg_resolve_test_root"))
assert.ok(projectModeCode.includes("function pg_project_bootstrap_real_path"))
assert.ok(projectModeCode.includes("$base_dir = dirname($xml_real);"))
assert.ok(projectModeCode.includes("$bootstrap_real = pg_project_bootstrap_real_path($bootstrap, $phpunit_xml, $from_config);"))
assert.ok(projectModeCode.includes("foreach ($xml->xpath('//testsuite/file') ?: array() as $file)"))
assert.ok(projectModeCode.includes("list($directories, $suffixes, $prefixes, $excludes, $configured_files) = wp_codebox_phpunit_parse_config"))
assert.ok(projectModeCode.includes("$test_files = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes, $configured_files);"))
assert.ok(projectModeCode.includes("' files=' . count($configured_files)"))
assert.equal(projectModeCode.match(/return array\(\$directories, \$suffixes, \$prefixes, \$excludes\);/g)?.length ?? 0, 0)
assert.equal(projectModeCode.match(/return \$return_values\(\);/g)?.length, 3)
assertPhpunitParseConfigFallbacksReturnFiveTuple(projectModeCode, "wp_codebox_phpunit_parse_config", "pg_log")

const coreModeCode = corePhpunitRunCode({
  coreRoot: "/wordpress",
  testsDir: "/wordpress/tests/phpunit",
  phpunitXml: "/wordpress/phpunit.xml.dist",
  selectedTestFile: "",
  changedTestFiles: [],
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  wpConfigDefines: {},
  multisite: false,
})

assert.ok(coreModeCode.includes("list($directories, $suffixes, $prefixes, $excludes, $configured_files) = core_pg_parse_phpunit_config"))
assert.ok(coreModeCode.includes("$test_files = core_pg_discover_tests($directories, $suffixes, $prefixes, $excludes, $configured_files);"))
assert.equal(coreModeCode.match(/return array\(\$directories, \$suffixes, \$prefixes, \$excludes\);/g)?.length ?? 0, 0)
assert.equal(coreModeCode.match(/return \$return_values\(\);/g)?.length, 3)
assertPhpunitParseConfigFallbacksReturnFiveTuple(coreModeCode, "core_pg_parse_phpunit_config", "core_pg_log")

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
