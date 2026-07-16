import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"
import { corePhpunitRunCode, phpunitRunCode } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { runPhpunitCommand } from "../packages/runtime-playground/src/wordpress-command-runners.js"
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

function assertSelectedTestFileResolution(source: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-selected-test-file-"))
  const pluginRoot = join(tempDir, "demo-plugin")
  const testRoot = join(pluginRoot, "tests")
  const nestedTestDir = join(testRoot, "Feature")
  const selectedTestFile = join(nestedTestDir, "ExampleTest.php")
  const scriptPath = join(tempDir, "assert-selected-test-file.php")
  mkdirSync(nestedTestDir, { recursive: true })
  writeFileSync(selectedTestFile, "<?php // test\n")
  const selectedTestFileReal = realpathSync(selectedTestFile)

  const resolverFunction = extractPhpFunction(source, "pg_resolve_selected_test_file")
  writeFileSync(scriptPath, `<?php
${resolverFunction}
$plugin_root = ${phpString(pluginRoot)};
$test_root = ${phpString(testRoot)};
$selected_test_file = ${phpString(selectedTestFile)};
$cases = array(
    'relative-to-test-root' => pg_resolve_selected_test_file('Feature/ExampleTest.php', $test_root, $plugin_root, $plugin_root),
    'relative-to-runtime-root' => pg_resolve_selected_test_file('tests/Feature/ExampleTest.php', $test_root, $plugin_root, $plugin_root),
    'absolute-runtime-path' => pg_resolve_selected_test_file($selected_test_file, $test_root, $plugin_root, $plugin_root),
);
echo json_encode($cases);
`)

  assert.deepEqual(JSON.parse(execFileSync("php", [scriptPath], { encoding: "utf8" })), {
    "relative-to-test-root": selectedTestFileReal,
    "relative-to-runtime-root": selectedTestFileReal,
    "absolute-runtime-path": selectedTestFile,
  })
}

function assertProjectBootstrapHarnessGuard(source: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-harness-guard-"))
  const stubFile = join(tempDir, "phpunit-testsuite-stub.php")
  const scriptPath = join(tempDir, "assert-harness-guard.php")

  writeFileSync(stubFile, `<?php
namespace PHPUnit\\Framework;
class TestSuite {}
`)

  const ensureFn = extractPhpFunction(source, "pg_ensure_phpunit_harness_loaded")

  writeFileSync(scriptPath, `<?php
function pg_log($msg) {}
function pg_stage_begin($stage) {}
function pg_stage_ok($stage) {}
function pg_stage_fail($stage, Throwable $e) {}
${ensureFn}

if (class_exists('PHPUnit\\Framework\\TestSuite', false)) {
    throw new RuntimeException('precondition failed: PHPUnit\\Framework\\TestSuite must not be preloaded in the test environment');
}

$reached_testsuite = false;
$boundary_message = '';
try {
    pg_ensure_phpunit_harness_loaded();
    $reached_testsuite = true;
} catch (RuntimeException $e) {
    $boundary_message = $e->getMessage();
} catch (Throwable $e) {
    throw new RuntimeException('REGRESSION: guard threw non-RuntimeException: ' . get_class($e) . ': ' . $e->getMessage());
}

if ($reached_testsuite) {
    throw new RuntimeException('REGRESSION: harness guard did not fail when PHPUnit was unavailable; TestSuite construction would be reached');
}
foreach (array('PHPUnit\\Framework\\TestSuite', 'bootstrap-mode=project', 'project-autoload-file', 'autoload-file=/wp-codebox-vendor/autoload.php') as $needle) {
    if (strpos($boundary_message, $needle) === false) {
        throw new RuntimeException('REGRESSION: boundary error missing actionable hint: ' . $needle . '; message=' . $boundary_message);
    }
}

spl_autoload_register(function ($class) {
    if ($class !== 'PHPUnit\\Framework\\TestSuite') {
        return;
    }
    require_once ${phpString(realpathSync(stubFile))};
});

try {
    pg_ensure_phpunit_harness_loaded();
} catch (Throwable $e) {
    throw new RuntimeException('REGRESSION: harness guard failed even though a project autoloader provides PHPUnit: ' . $e->getMessage());
}

echo "BOUNDARY_OK\n";
`)

  assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "BOUNDARY_OK\n")
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
assert.ok(recipe.workflow.steps[0].args.includes("autoload-file-role=harness"), "modern PHPUnit recipes explicitly preserve harness autoload intent")
assert.deepEqual(rewriteInputMountPathArgs(recipe.workflow.steps[0].args, recipeInputMountPathMap(recipe)).filter((arg) => arg.includes("autoload-file=")), [
  "autoload-file=/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/autoload.php",
  `project-autoload-file=${woocommerceAutoload}`,
])
assert.ok(rewriteInputMountPathArgs(recipe.workflow.steps[0].args, recipeInputMountPathMap(recipe)).includes("autoload-file-role=harness"), "CLI path canonicalization preserves autoload intent")
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
assert.ok(projectModeCode.includes('$autoload_file_role = "";'), "direct callers without an explicit role retain the legacy compatibility path")
assert.ok(projectModeCode.includes("if ($autoload_file_role === '' && $bootstrap_mode === 'project'"))
assert.ok(projectModeCode.includes("configured PHPUnit harness autoload file is not readable"))
assert.ok(projectModeCode.includes("NOTICE:project bootstrap mode continuing without configured PHPUnit harness autoload"))
assert.ok(projectModeCode.includes("$test_root = \"/home/example/public_html/bin/tests/phpunit\";"))
assert.ok(projectModeCode.includes("pg_resolve_test_root"))
assert.ok(projectModeCode.includes("pg_resolve_selected_test_file"))
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
assertSelectedTestFileResolution(projectModeCode)

assert.ok(projectModeCode.includes("function pg_ensure_phpunit_harness_loaded(): void"))
assert.ok(projectModeCode.includes("PHPUnit harness is not initialized"))
assert.ok(projectModeCode.includes("pg_stage_begin('verify_harness')"))
const verifyHarnessIndex = projectModeCode.indexOf("pg_stage_begin('verify_harness')")
const projectModeTestsuiteIndex = projectModeCode.indexOf("$suite = new PHPUnit\\Framework\\TestSuite(")
assert.ok(verifyHarnessIndex > 0, "verify_harness stage must be present")
assert.ok(projectModeTestsuiteIndex > verifyHarnessIndex, "harness verification must precede TestSuite construction")
assertProjectBootstrapHarnessGuard(projectModeCode)

const canonicalHarnessProjectModeCode = phpunitRunCode({
  pluginSlug: "woocommerce",
  cwd: "/wordpress/wp-content/plugins/woocommerce",
  autoloadFile: "/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/autoload.php",
  autoloadFileRole: "harness",
  projectAutoloadFile: woocommerceAutoload,
  testsDir: "/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/wp-phpunit/wp-phpunit",
  testRoot: "/home/example/public_html/bin/tests/phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/woocommerce/phpunit.xml.dist",
  selectedTestFile: "",
  changedTestFiles: [],
  phpunitArgs: [],
  env: {},
  wpConfigDefines: {},
  dependencyMounts: [],
  bootstrapFiles: [],
  bootstrapMode: "project",
  projectBootstrap: "tests/legacy/bootstrap.php",
  multisite: false,
})
assert.ok(canonicalHarnessProjectModeCode.includes('$autoload_file_role = "harness";'))
assert.ok(canonicalHarnessProjectModeCode.includes('$harness_autoload_file = $legacy_project_autoload_file !== \'\' ? \'/wp-codebox-vendor/autoload.php\' : $autoload_file;'))
const canonicalHarnessResolution = canonicalHarnessProjectModeCode.match(/\$legacy_project_autoload_file = '';[\s\S]*?\$harness_autoload_file = [^;]+;/)?.[0]
assert.ok(canonicalHarnessResolution, "generated project-mode code must resolve harness autoload intent")
const canonicalHarnessProbe = join(mkdtempSync(join(tmpdir(), "wp-codebox-canonical-harness-")), "probe.php")
writeFileSync(canonicalHarnessProbe, `<?php
$bootstrap_mode = 'project';
$autoload_file = '/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/autoload.php';
$autoload_file_role = 'harness';
$project_autoload_file = ${phpString(woocommerceAutoload)};
${canonicalHarnessResolution}
echo json_encode(array($legacy_project_autoload_file, $harness_autoload_file));
`)
assert.deepEqual(JSON.parse(execFileSync("php", [canonicalHarnessProbe], { encoding: "utf8" })), ["", "/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/autoload.php"], "a canonical staged harness path remains the harness in project mode")

let capturedCanonicalHarnessCode = ""
await runPhpunitCommand({
  artifactRoot: mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-artifacts-")),
  mounts: [],
  runPlaygroundCommand: async (_command, _server, input) => {
    capturedCanonicalHarnessCode = input.code
    return { text: "ok", exitCode: 0 }
  },
  server: { playground: {} } as never,
  spec: {
    command: "wordpress.phpunit",
    args: [
      "plugin-slug=ai-provider-for-openai",
      "bootstrap-mode=project",
      "autoload-file=/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/autoload.php",
      "autoload-file-role=harness",
      "phpunit-xml=phpunit.xml.dist",
      "test-file=tests/unit/Models/OpenAiEmbeddingGenerationModelTest.php",
    ],
  },
})
assert.ok(capturedCanonicalHarnessCode.includes('$autoload_file = "/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/autoload.php";'))
assert.ok(capturedCanonicalHarnessCode.includes('$autoload_file_role = "harness";'))

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
assert.ok(managedModeCode.includes("'cacheResult' => false"))

const phpunitCacheAllocator = extractPhpFunction(managedModeCode, "wp_codebox_phpunit_args_private_cache_result_file")
const phpunitArgsFunction = extractPhpFunction(managedModeCode, "wp_codebox_phpunit_args")
const phpunitArgsProbe = join(mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-cache-args-")), "probe.php")
writeFileSync(phpunitArgsProbe, `<?php
function pg_log($message) {}
${phpunitCacheAllocator}
${phpunitArgsFunction}
echo json_encode(array(
  'first' => wp_codebox_phpunit_args(array('phpunit', '--filter', 'OnlyTest', '--cache-result-file=/wordpress/ignored.cache')),
  'second' => wp_codebox_phpunit_args(array('phpunit', '--cache-result-file', 'ignored.cache')),
  'firstMode' => fileperms(wp_codebox_phpunit_args(array('phpunit'))['cacheResultFile']) & 0777,
));
`)
const phpunitArgs = JSON.parse(execFileSync("php", [phpunitArgsProbe], { encoding: "utf8" })) as {
  first: Record<string, unknown>
  second: Record<string, unknown>
  firstMode: number
}
for (const argumentSet of [phpunitArgs.first, phpunitArgs.second]) {
  assert.equal(argumentSet.cacheResult, false, "PHPUnit result caching must start disabled")
  assert.match(String(argumentSet.cacheResultFile), /^\/tmp\/wp-codebox-phpunit-[a-f0-9]{48}\.cache$/, "cache file must be privately allocated under /tmp")
}
assert.equal(phpunitArgs.first.filter, "OnlyTest", "unrecognized caller cache options must not affect supported PHPUnit options")
assert.notEqual(phpunitArgs.first.cacheResultFile, phpunitArgs.second.cacheResultFile, "each PHPUnit invocation must receive an unpredictable cache path")
assert.equal(phpunitArgs.firstMode, 0o600, "the internal cache file must be private to the sandbox process")
assert.equal(existsSync(String(phpunitArgs.first.cacheResultFile)), false, "the internal cache must be removed at PHP shutdown")
assert.equal(existsSync(String(phpunitArgs.second.cacheResultFile)), false, "each allocated cache file must be cleaned up")

console.log("phpunit project autoload ok")
