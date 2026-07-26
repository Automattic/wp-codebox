import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"
import { corePhpunitRunCode, phpunitMultisitePreinstallCode, phpunitRunCode } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { runPhpunitCommand } from "../packages/runtime-playground/src/wordpress-command-runners.js"
import { recipePolicy } from "../packages/cli/src/recipe-validation.js"
import { recipeExtraPluginSourceSubpath } from "../packages/cli/src/recipe-sources.js"
import { recipeInputMountPathMap, rewriteInputMountPathArgs } from "../packages/cli/src/commands/recipe-runtime-setup.js"

const woocommerceAutoload = "/wordpress/wp-content/plugins/woocommerce/vendor/autoload_packages.php"
const phpunitRuntimeSpec = {
  environment: { kind: "wordpress", name: "test", version: "latest" },
  runtimeEnv: { TC_MYSQL_PORT: "3306" },
} as never

function phpunitRecipeArgs(options: Omit<Parameters<typeof buildWordPressPhpunitRecipe>[0], "pluginSlug">): string[] {
  return buildWordPressPhpunitRecipe({ pluginSlug: "demo-plugin", ...options }).workflow.steps[0].args
}

const projectRecipeWithoutAutoload = phpunitRecipeArgs({ bootstrapMode: "project" })
assert.ok(projectRecipeWithoutAutoload.includes("autoload-file="))
assert.ok(!projectRecipeWithoutAutoload.some((arg) => arg === "autoload-file-role=harness"), "project mode without an autoload file must not require the harness")

const managedRecipe = phpunitRecipeArgs({})
assert.ok(managedRecipe.includes("autoload-file=/wp-codebox-vendor/autoload.php"))
assert.ok(managedRecipe.includes("autoload-file-role=harness"))
assert.ok(managedRecipe.includes("phpunit-xml-default=1"), "default recipe XML retains implicit fallback semantics")

const explicitAutoloadRecipe = phpunitRecipeArgs({
  bootstrapMode: "project",
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  projectAutoloadFile: "/workspace/project/vendor/autoload.php",
})
assert.ok(explicitAutoloadRecipe.includes("autoload-file=/wp-codebox-vendor/autoload.php"))
assert.ok(explicitAutoloadRecipe.includes("autoload-file-role=harness"))
assert.ok(explicitAutoloadRecipe.includes("project-autoload-file=/workspace/project/vendor/autoload.php"))
assert.ok(explicitAutoloadRecipe.includes("phpunit-xml-default=1"))

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

function assertDeferredHookReplayUsesWordPressLifecycle(source: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-deferred-hook-"))
  const scriptPath = join(tempDir, "assert-deferred-hook.php")
  writeFileSync(scriptPath, `<?php
class WP_Hook {
    public array $callbacks = array();
    public function add_filter($hook, $callback, $priority, $accepted_args): void {
        $id = is_string($callback) ? $callback : spl_object_hash($callback);
        $this->callbacks[$priority][$id] = array('function' => $callback, 'accepted_args' => $accepted_args);
    }
    public function do_action($args): void {
        $completed = array();
        while (true) {
            ksort($this->callbacks);
            $next = null;
            foreach ($this->callbacks as $priority => $callbacks) {
                foreach ($callbacks as $id => $callback) {
                    $key = $priority . ':' . $id;
                    if (!isset($completed[$key])) {
                        $next = array($key, $callback);
                        break 2;
                    }
                }
            }
            if ($next === null) return;
            $completed[$next[0]] = true;
            call_user_func_array($next[1]['function'], array_slice($args, 0, $next[1]['accepted_args']));
        }
    }
}
function add_filter($hook, $callback, $priority = 10, $accepted_args = 1): bool {
    global $wp_filter;
    if (!isset($wp_filter[$hook])) $wp_filter[$hook] = new WP_Hook();
    $wp_filter[$hook]->add_filter($hook, $callback, $priority, $accepted_args);
    return true;
}
function add_action($hook, $callback, $priority = 10, $accepted_args = 1): bool {
    return add_filter($hook, $callback, $priority, $accepted_args);
}
${extractPhpFunction(source, "pg_run_deferred_wordpress_hook_callbacks")}
$events = array();
$wp_current_filter = array();
$wp_filter = array('init' => new WP_Hook());
add_action('init', function() use (&$events) { $events[] = 'core-must-not-replay'; }, 5, 0);
$early = function() use (&$events) {
    $events[] = 'early';
    add_action('init', function() use (&$events) { $events[] = 'late'; }, 15, 0);
};
pg_run_deferred_wordpress_hook_callbacks(array(array('priority' => 0, 'callback' => array('function' => $early, 'accepted_args' => 0))), array(), 'init');
if ($events !== array('early', 'late')) throw new RuntimeException('deferred init order was not faithful: ' . json_encode($events));
if (count($wp_filter['init']->callbacks, COUNT_RECURSIVE) < 6) throw new RuntimeException('replayed callbacks were not retained');
if ($wp_current_filter !== array()) throw new RuntimeException('current filter stack leaked');
echo "ok\n";
`)
  assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "ok\n")
}

function assertPhpunitConfigurationAndDiscoveryFailures(source: string, functionName: string, discoveryFunctionName: string, logFunctionName: string, supportsImplicitFallback: boolean): void {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-config-"))
  const malformedXml = join(tempDir, "phpunit.xml.dist")
  const malformedAdjacentXml = join(tempDir, "phpunit.xml")
  const explicitMissingXml = join(tempDir, "missing.xml.dist")
  const explicitAdjacentXml = join(tempDir, "missing.xml")
  const defaultXml = join(tempDir, "default", "phpunit.xml.dist")
  const adjacentXml = join(tempDir, "default", "phpunit.xml")
  const scriptPath = join(tempDir, "assert-phpunit-config.php")
  writeFileSync(malformedXml, "<phpunit><testsuites>")
  writeFileSync(malformedAdjacentXml, "<phpunit><testsuites><testsuite><directory>must-not-mask-malformed</directory></testsuite></testsuites></phpunit>")
  writeFileSync(explicitAdjacentXml, "<phpunit><testsuites><testsuite><directory>must-not-fallback</directory></testsuite></testsuites></phpunit>")
  mkdirSync(join(tempDir, "default"), { recursive: true })
  writeFileSync(adjacentXml, "<phpunit><testsuites><testsuite><directory>fallback-tests</directory></testsuite></testsuites></phpunit>")

  const parseConfigFunction = extractPhpFunction(source, functionName)
  const discoveryFunction = extractPhpFunction(source, discoveryFunctionName)
  writeFileSync(scriptPath, `<?php
function ${logFunctionName}($message) {}
${parseConfigFunction}
${discoveryFunction}
function assert_phpunit_error($callback, $expected, $label) {
    try {
        $callback();
    } catch (RuntimeException $error) {
        if (strpos($error->getMessage(), $expected) !== false) {
            return;
        }
        throw new RuntimeException($label . ' returned the wrong error: ' . $error->getMessage());
    }
    throw new RuntimeException($label . ' unexpectedly succeeded');
}

${!supportsImplicitFallback ? `assert_phpunit_error(function() { ${functionName}(${phpString(explicitMissingXml)}, ${phpString(join(tempDir, "tests"))}); }, 'PHPUnit config is not readable', 'explicit missing config');` : ""}
assert_phpunit_error(function() { ${functionName}(${phpString(malformedXml)}, ${phpString(join(tempDir, "tests"))}); }, 'PHPUnit config could not be parsed', 'malformed config');
assert_phpunit_error(function() { ${discoveryFunctionName}(array(${phpString(join(tempDir, "missing-tests"))}), array('Test.php'), array('test-'), array()); }, 'configured PHPUnit test directory is not a readable directory', 'missing configured directory');
assert_phpunit_error(function() { ${discoveryFunctionName}(array(), array('Test.php'), array('test-'), array(), array(${phpString(join(tempDir, "MissingTest.php"))})); }, 'configured PHPUnit test file is not a readable PHP file', 'missing configured file');
${supportsImplicitFallback ? `
$fallback = ${functionName}(${phpString(defaultXml)}, ${phpString(join(tempDir, "tests"))});
if ($fallback[0] !== array(${phpString(join(tempDir, "default", "fallback-tests"))})) {
    throw new RuntimeException('implicit phpunit.xml fallback did not load the adjacent config');
}
unlink(${phpString(adjacentXml)});
assert_phpunit_error(function() { ${functionName}(${phpString(defaultXml)}, ${phpString(join(tempDir, "tests"))}); }, 'PHPUnit config is not readable', 'both default configs missing');` : ""}
echo "ok\n";
`)

  assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "ok\n")
}

function assertConfiglessPluginUsesManagedDiscovery(source: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-configless-plugin-"))
  const testsDir = join(tempDir, "tests")
  const testFile = join(testsDir, "ExampleTest.php")
  const scriptPath = join(tempDir, "assert-configless-discovery.php")
  mkdirSync(testsDir)
  writeFileSync(testFile, "<?php final class ExampleTest extends WP_UnitTestCase {}\n")
  writeFileSync(scriptPath, `<?php
function pg_log($message) {}
${extractPhpFunction(source, "wp_codebox_phpunit_parse_config")}
${extractPhpFunction(source, "wp_codebox_phpunit_discover")}
list($directories, $suffixes, $prefixes, $excludes, $files) = wp_codebox_phpunit_parse_config(${phpString(join(tempDir, "phpunit.xml.dist"))}, ${phpString(testsDir)});
$discovered = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes, $files);
if ($discovered !== array(${phpString(testFile)})) {
    throw new RuntimeException('managed discovery did not find the configless plugin test: ' . json_encode($discovered));
}
echo "ok\n";
`)
  assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "ok\n")
}

function assertChangedScopeNoOp(source: string, filterFunctionName: string, relativeFunctionName: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-changed-scope-"))
  const scriptPath = join(tempDir, "assert-changed-scope.php")
  const filterFunction = extractPhpFunction(source, filterFunctionName)
  const relativeFunction = extractPhpFunction(source, relativeFunctionName)
  writeFileSync(scriptPath, `<?php
function pg_log($message) {}
function core_pg_log($message) {}
${filterFunction}
${relativeFunction}
$selected = ${filterFunctionName}(array(${phpString(join(tempDir, "ExampleTest.php"))}), json_encode(array('ChangedButNotDiscoveredTest.php')), ${phpString(tempDir)});
if ($selected !== array()) {
    throw new RuntimeException('changed scope must permit a valid zero-match selection');
}
echo "ok\n";
`)
  assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "ok\n")
  assert.match(source, /if \(empty\(\$test_files\) && !\$changed_test_scope\) \{/, "only changed-scope empty discovery may succeed")
}

function assertProjectBootstrapConfigResolution(explicitSource: string, implicitSource: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-project-bootstrap-config-"))
  const marker = join(tempDir, "adjacent-bootstrap-ran.txt")
  const config = join(tempDir, "phpunit.xml")
  const missingDefault = join(tempDir, "phpunit.xml.dist")
  const bootstrap = join(tempDir, "adjacent-bootstrap.php")
  const explicitScript = join(tempDir, "explicit-missing.php")
  const implicitScript = join(tempDir, "implicit-default.php")
  const functionNames = ["pg_project_bootstrap_from_config", "pg_project_bootstrap_real_path", "pg_run_project_bootstrap_stage"]
  const stageStubs = `function pg_stage_begin($stage) {}
function pg_stage_ok($stage) {}
function pg_stage_fail($stage, Throwable $error) {}
function pg_log($message) {}`
  writeFileSync(bootstrap, `<?php file_put_contents(${phpString(marker)}, 'ran');\n`)
  writeFileSync(config, `<phpunit bootstrap="adjacent-bootstrap.php"/>`)

  writeFileSync(explicitScript, `<?php
${stageStubs}
${functionNames.map((name) => extractPhpFunction(explicitSource, name)).join("\n")}
pg_run_project_bootstrap_stage(array('project_bootstrap' => '', 'phpunit_xml' => ${phpString(missingDefault)}, 'phpunit_xml_is_default' => false));
`)
  assert.throws(() => execFileSync("php", [explicitScript], { encoding: "utf8" }), /Command failed/, "an explicit missing config must fail before an adjacent bootstrap can execute")
  assert.equal(existsSync(marker), false, "explicit missing config must not execute the adjacent phpunit.xml bootstrap")

  writeFileSync(implicitScript, `<?php
${stageStubs}
${functionNames.map((name) => extractPhpFunction(implicitSource, name)).join("\n")}
pg_run_project_bootstrap_stage(array('project_bootstrap' => '', 'phpunit_xml' => ${phpString(missingDefault)}, 'phpunit_xml_is_default' => true));
`)
  execFileSync("php", [implicitScript], { encoding: "utf8" })
  assert.equal(readFileSync(marker, "utf8"), "ran", "an implicit default config must execute the adjacent phpunit.xml bootstrap")
}

function decodedBootstrapWrapper(source: string): string {
  const encoded = source.match(/base64_decode\("([A-Za-z0-9+/=]+)"\)/)?.[1]
  return encoded ? Buffer.from(encoded, "base64").toString("utf8") : source
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

function assertDiscoveredTestExecutes(source: string, stagePrefix: "pg" | "core_pg", privateConstructor: boolean): void {
  const tempDir = mkdtempSync(join(tmpdir(), `wp-codebox-${stagePrefix}-testsuite-`))
  const testFile = join(tempDir, "DiscoveredTest.php")
  const scriptPath = join(tempDir, "run-generated-harness.php")
  const executionMarker = join(tempDir, "executed.txt")
  const stageLog = join(tempDir, "stages.txt")
  const loadTestsStart = source.indexOf(`${stagePrefix}_stage_begin('load_tests');`)
  assert.notEqual(loadTestsStart, -1)
  const generatedHarnessTail = source.slice(loadTestsStart)
  const testSuiteFactory = privateConstructor
    ? `private function __construct($name) { $this->name = $name; }
    public static function empty($name) { return new self($name); }`
    : `public function __construct($name) { $this->name = $name; }`

  writeFileSync(testFile, `<?php
class DiscoveredTest extends PHPUnit\\Framework\\TestCase {
    public function run(): void {
        file_put_contents(getenv('EXECUTION_MARKER'), 'executed');
    }
}
`)

  writeFileSync(scriptPath, `<?php
namespace PHPUnit\\Framework {
abstract class TestCase {}
final class TestSuite {
    private $name;
    private $tests = array();
    ${testSuiteFactory}
    public function addTestSuite(\\ReflectionClass $class): void { $this->tests[] = $class->newInstance(); }
    public function tests(): array { return $this->tests; }
    public function count(): int { return count($this->tests); }
}
}
namespace PHPUnit\\TextUI {
final class TestResult {
    private $count;
    public function __construct($count) { $this->count = $count; }
    public function wasSuccessful(): bool { return true; }
    public function count(): int { return $this->count; }
    public function failures(): array { return array(); }
    public function errors(): array { return array(); }
}
final class TestRunner {
    public function run($suite, $args): TestResult {
        foreach ($suite->tests() as $test) { $test->run(); }
        return new TestResult($suite->count());
    }
}
}
namespace {
$test_files = array(${phpString(testFile)});
$phpunit_argv = array('phpunit');
$argv = array('phpunit');
function ${stagePrefix}_stage_begin($stage) { file_put_contents(getenv('STAGE_LOG'), 'STAGE_BEGIN:' . $stage . "\\n", FILE_APPEND); }
function ${stagePrefix}_stage_ok($stage) { file_put_contents(getenv('STAGE_LOG'), 'STAGE_OK:' . $stage . "\\n", FILE_APPEND); }
function ${stagePrefix}_stage_fail($stage, \\Throwable $e) {
    file_put_contents(getenv('STAGE_LOG'), 'STAGE_FAIL:' . $stage . ':' . $e->getMessage() . "\\n", FILE_APPEND);
    throw $e;
}
function ${stagePrefix}_log($message) {}
${stagePrefix === "core_pg" ? "function core_pg_phpunit_args($args) { return array(); }" : ""}
${generatedHarnessTail}
}
`)

  execFileSync("php", [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, EXECUTION_MARKER: executionMarker, STAGE_LOG: stageLog },
  })
  assert.equal(existsSync(executionMarker), true, `${stagePrefix} discovered test must reach execution`)
  const stages = readFileSync(stageLog, "utf8")
  assert.match(stages, /STAGE_OK:load_tests/)
  assert.match(stages, /STAGE_BEGIN:run_tests/)
  assert.match(stages, /STAGE_OK:run_tests/)
  assert.doesNotMatch(stages, /STAGE_FAIL:/)
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
  "autoload-file=",
  `project-autoload-file=${woocommerceAutoload}`,
])
assert.ok(!recipe.workflow.steps[0].args.includes("autoload-file-role=harness"), "project mode without an explicit autoload file preserves project-owned harness setup")
assert.deepEqual(rewriteInputMountPathArgs(recipe.workflow.steps[0].args, recipeInputMountPathMap(recipe)).filter((arg) => arg.includes("autoload-file=")), [
  "autoload-file=",
  `project-autoload-file=${woocommerceAutoload}`,
])
assert.ok(!rewriteInputMountPathArgs(recipe.workflow.steps[0].args, recipeInputMountPathMap(recipe)).includes("autoload-file-role=harness"), "CLI path canonicalization preserves absent harness autoload intent")
assert.ok(recipe.workflow.steps[0].args.includes("cwd=/home/example/public_html"))
assert.ok(recipe.workflow.steps[0].args.includes("test-root=/home/example/public_html/bin/tests/phpunit"))
assert.ok(recipe.workflow.steps[0].args.includes("phpunit-xml=/home/example/public_html/bin/tests/phpunit/phpunit.xml.dist"))
assert.ok(recipe.workflow.steps[0].args.includes("phpunit-xml-default="), "explicit phpunit-xml paths must not opt into adjacent-file fallback")

const projectModeCode = phpunitRunCode({
  pluginSlug: "woocommerce",
  cwd: "/wordpress/wp-content/plugins/woocommerce",
  autoloadFile: woocommerceAutoload,
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  testRoot: "/home/example/public_html/bin/tests/phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/woocommerce/phpunit.xml.dist",
  phpunitXmlIsDefault: false,
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
  databaseType: "sqlite",
})

const implicitProjectConfigCode = phpunitRunCode({
  pluginSlug: "woocommerce",
  cwd: "/wordpress/wp-content/plugins/woocommerce",
  autoloadFile: woocommerceAutoload,
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  testRoot: "/home/example/public_html/bin/tests/phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/woocommerce/phpunit.xml.dist",
  phpunitXmlIsDefault: true,
  selectedTestFile: "",
  changedTestFiles: [],
  phpunitArgs: [],
  env: {},
  wpConfigDefines: {},
  dependencyMounts: [],
  bootstrapFiles: [],
  bootstrapMode: "project",
  projectBootstrap: "",
  multisite: false,
  databaseType: "sqlite",
})
assertConfiglessPluginUsesManagedDiscovery(implicitProjectConfigCode)

const bootIndex = projectModeCode.indexOf("$config_path = pg_run_boot_stage")
const projectBootstrapIndex = projectModeCode.indexOf("pg_run_project_bootstrap_stage", bootIndex)
const projectAutoloadIndex = projectModeCode.indexOf("pg_run_project_autoload_stage", projectBootstrapIndex)
const phpunitArgvIndex = projectModeCode.indexOf("$_SERVER['argv'] = $phpunit_argv;")
assert.ok(bootIndex > 0)
assert.ok(phpunitArgvIndex > 0 && phpunitArgvIndex < projectBootstrapIndex, "project bootstrap must receive forwarded PHPUnit arguments")
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
assert.ok(projectModeCode.includes("function pg_project_bootstrap_from_config(string &$xml_path, bool $xml_is_default): string"))
assertProjectBootstrapConfigResolution(projectModeCode, implicitProjectConfigCode)
assert.ok(projectModeCode.includes("foreach ($xml->xpath('//testsuite/file') ?: array() as $file)"))
assert.ok(projectModeCode.includes("list($directories, $suffixes, $prefixes, $excludes, $configured_files) = wp_codebox_phpunit_parse_config"))
assert.ok(projectModeCode.includes("$test_files = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes, $configured_files);"))
assert.ok(projectModeCode.includes("' files=' . count($configured_files)"))
assert.equal(projectModeCode.match(/return array\(\$directories, \$suffixes, \$prefixes, \$excludes\);/g)?.length ?? 0, 0)
assert.equal(projectModeCode.match(/return \$return_values\(\);/g)?.length, 1)
assert.match(projectModeCode, /configured PHPUnit test root is not a readable directory/)
assertPhpunitConfigurationAndDiscoveryFailures(projectModeCode, "wp_codebox_phpunit_parse_config", "wp_codebox_phpunit_discover", "pg_log", false)
assertChangedScopeNoOp(projectModeCode, "pg_filter_changed_test_files", "pg_component_relative_path")
assertSelectedTestFileResolution(projectModeCode)

assert.ok(projectModeCode.includes("function pg_ensure_phpunit_harness_loaded(): void"))
assert.ok(projectModeCode.includes("PHPUnit harness is not initialized"))
assert.ok(projectModeCode.includes("pg_stage_begin('verify_harness')"))
const verifyHarnessIndex = projectModeCode.indexOf("pg_stage_begin('verify_harness')")
const projectModeTestsuiteIndex = projectModeCode.indexOf("$suite = method_exists('PHPUnit\\Framework\\TestSuite', 'empty')")
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
  phpunitXmlIsDefault: false,
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
  databaseType: "sqlite",
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
  runtimeSpec: phpunitRuntimeSpec,
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
const decodedCanonicalHarnessCode = decodedBootstrapWrapper(capturedCanonicalHarnessCode)
assert.ok(decodedCanonicalHarnessCode.includes('$autoload_file = "/tmp/wp-codebox-inputs/0-wp-codebox-vendor-73845ca47d2f/autoload.php";'))
assert.ok(decodedCanonicalHarnessCode.includes('$autoload_file_role = "harness";'))
assert.ok(decodedCanonicalHarnessCode.includes('putenv("TC_MYSQL_PORT=3306");'), "runtime service environment is passed to the PHP executed by wordpress.phpunit")
assert.ok(!decodedCanonicalHarnessCode.includes("require_once '/wordpress/wp-load.php';"), "PHPUnit must own WordPress bootstrap so managed multisite constants are established first")

let capturedExplicitCode = ""
await runPhpunitCommand({
  artifactRoot: mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-artifacts-")),
  mounts: [],
  runPlaygroundCommand: async (_command, _server, input) => {
    capturedExplicitCode = input.code
    return { text: "ok", exitCode: 0 }
  },
  runtimeSpec: phpunitRuntimeSpec,
  server: { playground: {} } as never,
  spec: {
    command: "wordpress.phpunit",
    args: ["code=<?php declare(strict_types=1); echo getenv('TC_MYSQL_PORT');", "env-json={\"TC_MYSQL_PORT\":\"3307\"}"],
  },
})
const decodedExplicitCode = decodedBootstrapWrapper(capturedExplicitCode)
assert.equal((decodedExplicitCode.match(/declare\(strict_types=1\);/g) ?? []).length, 1, "explicit PHP is normalized once at the runtime bootstrap boundary")
assert.ok(decodedExplicitCode.includes("echo getenv('TC_MYSQL_PORT');"), "explicit PHPUnit code receives the same runtime bootstrap")
assert.ok(decodedExplicitCode.indexOf('putenv("TC_MYSQL_PORT=3306");') < decodedExplicitCode.lastIndexOf("TC_MYSQL_PORT"), "explicit env-json handling remains after runtime environment bootstrap")

let capturedMysqlCode = ""
await runPhpunitCommand({
  artifactRoot: mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-mysql-artifacts-")),
  mounts: [],
  runPlaygroundCommand: async (_command, _server, input) => {
    capturedMysqlCode = input.code
    return { text: "ok", exitCode: 0 }
  },
  runtimeSpec: {
    environment: { kind: "wordpress", name: "test", version: "latest", databaseSetup: "external" },
    runtimeEnv: { DB_HOST: "127.0.0.1", DB_PORT: "3307", DB_NAME: "runtime", DB_USER: "runtime", DB_PASSWORD: "secret" },
    policy: { commands: ["wordpress.phpunit"] },
  } as never,
  server: { playground: {} } as never,
  spec: { command: "wordpress.phpunit", args: ["plugin-slug=demo-plugin", "database-type=mysql"] },
})
const decodedMysqlCode = decodedBootstrapWrapper(capturedMysqlCode)
assert.ok(decodedMysqlCode.includes('$database_type = "mysql";'))
assert.ok(decodedMysqlCode.includes("'DB_HOST' => $db_host"), "managed PHPUnit writes the provisioned MySQL host into wp-tests-config.php")
assert.ok(decodedMysqlCode.includes("getenv('DB_PASSWORD')"), "managed PHPUnit consumes the provisioned MySQL credentials")

const preinstallCode = phpunitMultisitePreinstallCode({
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  env: {},
  wpConfigDefines: { MULTISITE: true, DOMAIN_CURRENT_SITE: "example.org" },
  databaseType: "mysql",
  resultFile: "/tmp/preinstall-result.txt",
})
assert.ok(preinstallCode.includes("'run_ms_tests'"), "multisite preinstall selects wp-phpunit's network installer")
assert.ok(preinstallCode.includes("define('WP_TESTS_MULTISITE', true)"), "multisite preinstall enables wp-phpunit network installation")
assert.ok(preinstallCode.includes("require $tests_dir . '/includes/install.php'"), "multisite preinstall uses wp-phpunit's installer")
assert.ok(preinstallCode.includes("pg_write_managed_test_config($wp_config_defines, 'wptests_', $database_type)"), "multisite preinstall uses the managed runner's database config and prefix")
assert.equal(preinstallCode.includes("define('MULTISITE'"), false, "multisite preinstall must not bootstrap WordPress as an installed network")
assert.equal(preinstallCode.includes("DOMAIN_CURRENT_SITE"), false, "multisite preinstall must not define current-network constants")
assert.ok(preinstallCode.includes("@file_put_contents($result_file, '');"), "multisite preinstall clears stale diagnostics")
assert.ok(preinstallCode.includes("STAGE_FAIL:preinstall:"), "multisite preinstall records throwable diagnostics")
assert.ok(preinstallCode.includes("STAGE_FATAL:preinstall:"), "multisite preinstall records fatal diagnostics")

const mysqlMultisiteInvocations: string[] = []
await runPhpunitCommand({
  artifactRoot: mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-mysql-multisite-")),
  mounts: [],
  runPlaygroundCommand: async (_command, _server, input) => {
    mysqlMultisiteInvocations.push(decodedBootstrapWrapper(input.code))
    return { text: "ok", exitCode: 0 }
  },
  runtimeSpec: {
    environment: { kind: "wordpress", name: "test", version: "latest", databaseSetup: "external" },
    runtimeEnv: { DB_HOST: "127.0.0.1", DB_PORT: "3307", DB_NAME: "runtime", DB_USER: "runtime", DB_PASSWORD: "secret" },
    policy: { commands: ["wordpress.phpunit"] },
  } as never,
  server: { playground: {} } as never,
  spec: { command: "wordpress.phpunit", args: ["plugin-slug=demo-plugin", "database-type=mysql", "multisite=1"] },
})
assert.equal(mysqlMultisiteInvocations.length, 2, "managed MySQL multisite runs a separate preinstall before PHPUnit")
assert.ok(mysqlMultisiteInvocations[0].includes("'run_ms_tests'"))
assert.ok(mysqlMultisiteInvocations[1].includes("$phpunit_argv = pg_build_phpunit_argv"), "normal managed PHPUnit behavior follows preinstall")
assert.ok(mysqlMultisiteInvocations[1].includes("$preinstalled_multisite = true"), "normal managed PHPUnit preserves the preinstalled network")
assert.ok(mysqlMultisiteInvocations[1].includes("pg_run_preinstalled_multisite_stage"), "normal managed PHPUnit boots without destructively reinstalling multisite")

const failedPreinstallInvocations: string[] = []
await assert.rejects(
  runPhpunitCommand({
    artifactRoot: mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-mysql-multisite-failure-")),
    mounts: [],
    runPlaygroundCommand: async (_command, _server, input) => {
      failedPreinstallInvocations.push(decodedBootstrapWrapper(input.code))
      return { text: "preinstall failed", exitCode: 1 }
    },
    runtimeSpec: {
      environment: { kind: "wordpress", name: "test", version: "latest", databaseSetup: "external" },
      runtimeEnv: { DB_HOST: "127.0.0.1", DB_PORT: "3307", DB_NAME: "runtime", DB_USER: "runtime", DB_PASSWORD: "secret" },
      policy: { commands: ["wordpress.phpunit"] },
    } as never,
    server: {
      playground: {
        readFileAsText: async () => "STAGE_FAIL:preinstall:RuntimeException: network install failed",
      },
    } as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=demo-plugin", "database-type=mysql", "multisite=1"] },
  }),
  (error: Error) => {
    assert.match(error.message, /wordpress\.phpunit multisite preinstall failed with exit code 1/)
    assert.match(error.message, /wordpress\.phpunit structured diagnostics/)
    assert.match(error.message, /network install failed/)
    return true
  },
)
assert.equal(failedPreinstallInvocations.length, 1, "failed multisite preinstall prevents the main PHPUnit invocation")
await assert.rejects(runPhpunitCommand({
  artifactRoot: mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-mysql-reject-")),
  mounts: [],
  runPlaygroundCommand: async () => { throw new Error("workload must not execute") },
  runtimeSpec: { environment: { kind: "wordpress", name: "test", version: "latest" }, policy: { commands: ["wordpress.phpunit"] } } as never,
  server: { playground: {} } as never,
  spec: { command: "wordpress.phpunit", args: ["plugin-slug=demo-plugin", "database-type=mysql"] },
}), /requires a managed external database service.*refusing to substitute SQLite/)

const coreModeCode = corePhpunitRunCode({
  coreRoot: "/wordpress",
  testsDir: "/wordpress/tests/phpunit",
  phpunitXml: "/wordpress/phpunit.xml.dist",
  phpunitXmlIsDefault: true,
  selectedTestFile: "",
  changedTestFiles: [],
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  wpConfigDefines: {},
  multisite: false,
})

assert.ok(coreModeCode.includes("list($directories, $suffixes, $prefixes, $excludes, $configured_files) = core_pg_parse_phpunit_config"))
assert.ok(coreModeCode.includes("$test_files = core_pg_discover_tests($directories, $suffixes, $prefixes, $excludes, $configured_files);"))
assert.equal(coreModeCode.match(/return array\(\$directories, \$suffixes, \$prefixes, \$excludes\);/g)?.length ?? 0, 0)
assert.equal(coreModeCode.match(/return \$return_values\(\);/g)?.length, 1)
assert.match(coreModeCode, /core tests directory is not a directory/)
assertPhpunitConfigurationAndDiscoveryFailures(coreModeCode, "core_pg_parse_phpunit_config", "core_pg_discover_tests", "core_pg_log", true)
assertChangedScopeNoOp(coreModeCode, "core_pg_filter_changed_test_files", "core_pg_relative_path")
for (const privateConstructor of [true, false]) {
  assertDiscoveredTestExecutes(projectModeCode, "pg", privateConstructor)
  assertDiscoveredTestExecutes(coreModeCode, "core_pg", privateConstructor)
}

const managedModeCode = phpunitRunCode({
  pluginSlug: "demo-plugin",
  cwd: "/wordpress/wp-content/plugins/demo-plugin",
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/demo-plugin/phpunit.xml.dist",
  phpunitXmlIsDefault: false,
  selectedTestFile: "",
  changedTestFiles: [],
  phpunitArgs: [],
  env: {},
  wpConfigDefines: {},
  dependencyMounts: ["/wordpress/wp-content/plugins/demo-plugin", "/wordpress/wp-content/plugins/dependency"],
  bootstrapFiles: [],
  bootstrapMode: "managed",
  projectBootstrap: "",
  multisite: false,
  databaseType: "sqlite",
})

assertDeferredHookReplayUsesWordPressLifecycle(managedModeCode)

assert.ok(managedModeCode.includes("configured PHPUnit harness autoload file is not readable"))
assert.ok(managedModeCode.includes("define('DB_NAME', ':memory:');"), "default managed PHPUnit remains on SQLite")
assert.ok(managedModeCode.includes("'cacheResult' => false"))
assert.ok(managedModeCode.includes("global $argv, $pg_stage_output_buffering, $wp_rewrite;"), "managed WordPress installation must expose the rewrite global required by multisite setup")
assert.ok(managedModeCode.includes("foreach ($multisite_defines as $name => $value)"), "managed multisite must establish network constants before the WordPress test installer runs")
assert.ok(managedModeCode.includes('$dep_mounts = "/wordpress/wp-content/plugins/demo-plugin\\n/wordpress/wp-content/plugins/dependency";'), "dependency mounts must be newline-delimited for the generated PHP runner")
const installStageIndex = managedModeCode.indexOf("pg_run_install_stage(array(")
const dependencyLoadStageIndex = managedModeCode.indexOf("$loaded_dep_files = pg_run_load_deps_stage", installStageIndex)
const activationStageIndex = managedModeCode.indexOf("pg_run_activation_stage", dependencyLoadStageIndex)
const dependencyPluginsLoadedSnapshotIndex = managedModeCode.indexOf("$pre_dependency_plugins_loaded_callbacks = pg_snapshot_wordpress_hook_callbacks('plugins_loaded');", installStageIndex)
const dependencyPluginsLoadedDeferIndex = managedModeCode.indexOf("$deferred_dependency_plugins_loaded_callbacks = pg_defer_new_wordpress_hook_callbacks('plugins_loaded', $pre_dependency_plugins_loaded_callbacks);", dependencyLoadStageIndex)
const dependencyPluginsLoadedReplayIndex = managedModeCode.indexOf("pg_run_deferred_wordpress_hook_callbacks($deferred_dependency_plugins_loaded_callbacks, array(), 'plugins_loaded');", activationStageIndex)
assert.ok(installStageIndex > 0)
assert.ok(dependencyPluginsLoadedSnapshotIndex > installStageIndex && dependencyPluginsLoadedSnapshotIndex < dependencyLoadStageIndex, "dependency plugins_loaded callbacks must be scoped to dependency loading")
assert.ok(dependencyLoadStageIndex > installStageIndex, "dependency plugins must load after managed PHPUnit installation")
assert.ok(dependencyPluginsLoadedDeferIndex > dependencyLoadStageIndex && dependencyPluginsLoadedDeferIndex < activationStageIndex, "dependency plugins_loaded callbacks must defer until activation completes")
assert.ok(activationStageIndex > dependencyLoadStageIndex, "dependency plugins must activate after loading and before tests execute")
assert.ok(dependencyPluginsLoadedReplayIndex > activationStageIndex, "dependency plugins_loaded callbacks must run once after activation")

const dependencyRecipe = buildWordPressPhpunitRecipe({
  pluginSlug: "demo-plugin",
  extra_plugins: [{
    source: "/workspace/dependency",
    slug: "dependency",
    pluginFile: "dependency/dependency.php",
    activate: false,
  }],
  dependencyMounts: ["/wordpress/wp-content/plugins/dependency"],
})
assert.deepEqual(dependencyRecipe.inputs.extra_plugins, [{
  source: "/workspace/dependency",
  slug: "dependency",
  pluginFile: "dependency/dependency.php",
  activate: false,
}])
assert.ok(dependencyRecipe.workflow.steps[0].args.includes("dependency-mounts=/wordpress/wp-content/plugins/dependency"))

const multisiteRecipe = buildWordPressPhpunitRecipe({
  pluginSlug: "network-plugin",
  multisite: true,
  blueprint: { steps: [{ step: "setSiteOptions", options: { blogname: "Network tests" } }] },
})
assert.deepEqual((multisiteRecipe.runtime.blueprint as { steps: unknown[] }).steps, [
  { step: "enableMultisite" },
  { step: "setSiteOptions", options: { blogname: "Network tests" } },
], "multisite PHPUnit recipes must boot Playground as multisite before running tests")
assert.equal(multisiteRecipe.runtime.preview?.siteUrl, "http://localhost", "multisite PHPUnit recipes need a canonical site URL without the dynamic Playground port")
assert.ok(multisiteRecipe.workflow.steps[0].args.includes("multisite=1"))

const externalMysqlMultisiteRecipe = buildWordPressPhpunitRecipe({
  pluginSlug: "network-plugin",
  databaseType: "mysql",
  multisite: true,
})
assert.deepEqual((externalMysqlMultisiteRecipe.runtime.blueprint as { steps: unknown[] }).steps, [], "external MySQL must boot single-site until the managed PHPUnit installer creates network tables")
assert.ok(externalMysqlMultisiteRecipe.workflow.steps[0].args.includes("multisite=1"), "managed PHPUnit still receives the declared multisite contract")

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
