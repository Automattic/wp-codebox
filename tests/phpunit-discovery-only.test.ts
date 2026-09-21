import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"
import { phpunitRunCode } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { runPhpunitCommand } from "../packages/runtime-playground/src/wordpress-command-runners.js"
import { recipeHasPhpunitDiscoveryOnly } from "../packages/cli/src/commands/recipe-runtime-setup.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

function extractPhpFunction(source: string, functionName: string): string {
  const start = source.indexOf(`function ${functionName}(`)
  assert.notEqual(start, -1, `expected generated PHP to declare ${functionName}`)

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

test("wordpress.phpunit discovery-only returns canonical files before execution", () => {
  const recipe = buildWordPressPhpunitRecipe({
    pluginSlug: "fixture",
    pluginSource: "/workspace/fixture",
    discoveryOnly: true,
  })
  assert.ok(recipe.workflow.steps[0].args.includes("discovery-only=1"))

  const code = phpunitRunCode({
    pluginSlug: "fixture",
    cwd: "/wordpress/wp-content/plugins/fixture",
    autoloadFile: "/wp-codebox-vendor/autoload.php",
    testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
    testRoot: "/wordpress/wp-content/plugins/fixture/tests",
    phpunitXml: "/wordpress/wp-content/plugins/fixture/phpunit.xml.dist",
    phpunitXmlIsDefault: false,
    selectedTestFile: "",
    changedTestFiles: [],
    discoveryOnly: true,
    phpunitArgs: [],
    env: {},
    wpConfigDefines: {},
    dependencyMounts: [],
    bootstrapFiles: [],
    bootstrapMode: "managed",
    projectBootstrap: "",
    multisite: false,
    databaseType: "sqlite",
  })

  const discover = code.indexOf("$test_files = wp_codebox_phpunit_discover(")
  const output = code.indexOf("DISCOVERY_RESULT_JSON:", discover)
  const boot = code.indexOf("$config_path = pg_run_boot_stage", output)
  assert.ok(discover >= 0 && output > discover)
  assert.ok(boot > output, "discovery output must terminate before WordPress, component, or test bootstrap")
  assert.match(code, /sort\(\$test_files, SORT_STRING\)/)
  assert.match(code, /'schema' => 'wp-codebox\/phpunit-discovery\/v1'/)
  assert.match(code, /DISCOVERY_RESULT_JSON:/)
  assert.match(code, /\$discovery_only = true;/)
})

test("discovery-only rejects selectors before starting a runtime", async () => {
  let invoked = false
  await assert.rejects(runPhpunitCommand({
    artifactRoot: "/tmp/artifacts",
    mounts: [],
    runPlaygroundCommand: async () => {
      invoked = true
      return { exitCode: 0, errors: "", text: "" }
    },
    runtimeSpec: wordpressRuntimeSpec({ commands: ["wordpress.phpunit"] }),
    server: {} as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=fixture", "discovery-only=1", "test-file=tests/FixtureTest.php"] },
  }), /discovery-only cannot be combined/)
  assert.equal(invoked, false)
})

test("discovery-only returns its schema-bound result directly", async () => {
  const payload = {
    schema: "wp-codebox/phpunit-discovery/v1",
    plugin_slug: "fixture",
    phpunit_xml: "/wordpress/wp-content/plugins/fixture/phpunit.xml.dist",
    test_root: "/wordpress/wp-content/plugins/fixture/tests",
    selected_testsuites: [],
    files: ["/wordpress/wp-content/plugins/fixture/tests/FixtureTest.php"],
  }
  const output = await runPhpunitCommand({
    artifactRoot: "/tmp/artifacts",
    mounts: [],
    runPlaygroundCommand: async () => ({ exitCode: 0, errors: "", text: "private runtime output" }),
    runtimeSpec: wordpressRuntimeSpec({ commands: ["wordpress.phpunit"] }),
    server: { playground: { readFileAsText: async () => `DISCOVERY_RESULT_JSON:${JSON.stringify(payload)}\n` } } as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=fixture", "discovery-only=1"] },
  })
  assert.deepEqual(JSON.parse(output), payload)
})

test("recipe setup uses canonical boolean parsing and rejects mixed workflows", () => {
  const recipe = buildWordPressPhpunitRecipe({ pluginSlug: "fixture", discoveryOnly: true })
  const args = recipe.workflow.steps[0].args
  const index = args.indexOf("discovery-only=1")
  args[index] = "discovery-only= true "
  assert.equal(recipeHasPhpunitDiscoveryOnly(recipe), true)

  recipe.workflow.after = [{ command: "wordpress.wp-cli", args: ["command=plugin list"] }]
  assert.throws(() => recipeHasPhpunitDiscoveryOnly(recipe), /must be the recipe's sole workflow step/)
})

// Regression coverage for https://github.com/Automattic/wp-codebox/issues/2516.
//
// This exercises the *default* discovery path (no --testsuite selection), which is the path
// PHPUnit discovery actually runs on and the path the production bug lived in. It is distinct
// from the `selected_testsuites` coverage in tests/phpunit-project-autoload.test.ts, where
// `$directories` is unconditionally reset to `array()` before config parsing and was never
// affected by this bug.
test("file-only testsuite discovery (issue #2516)", async (t) => {
  const code = phpunitRunCode({
    pluginSlug: "fixture",
    cwd: "/wordpress/wp-content/plugins/fixture",
    autoloadFile: "/wp-codebox-vendor/autoload.php",
    testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
    testRoot: "/wordpress/wp-content/plugins/fixture/tests",
    phpunitXml: "/wordpress/wp-content/plugins/fixture/phpunit.xml.dist",
    phpunitXmlIsDefault: false,
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
    databaseType: "sqlite",
  })

  const parseConfigFunction = extractPhpFunction(code, "wp_codebox_phpunit_parse_config")
  const discoverFunction = extractPhpFunction(code, "wp_codebox_phpunit_discover")

  // Tree shape mirrors the production report: a whole test root containing a file matching the
  // default `*Test.php` suffix that no suite declares, plus per-suite subdirectories.
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-2516-"))
  const testsDir = join(tempDir, "tests")
  mkdirSync(join(testsDir, "booking"), { recursive: true })
  mkdirSync(join(testsDir, "dir-suite"), { recursive: true })
  writeFileSync(join(testsDir, "UnrelatedTest.php"), "<?php final class UnrelatedTest extends TestCase {}\n")
  writeFileSync(join(testsDir, "booking", "DeclaredTest.php"), "<?php final class DeclaredTest extends TestCase {}\n")
  writeFileSync(join(testsDir, "dir-suite", "ScopedTest.php"), "<?php final class ScopedTest extends TestCase {}\n")

  const fileOnlyXml = join(tempDir, "file-only.xml")
  writeFileSync(
    fileOnlyXml,
    `<phpunit><testsuites><testsuite name="booking-alpha-concurrency"><file>tests/booking/DeclaredTest.php</file></testsuite></testsuites></phpunit>`,
  )

  const directoryXml = join(tempDir, "directory.xml")
  writeFileSync(
    directoryXml,
    `<phpunit><testsuites><testsuite name="managed-wordpress"><directory>tests/dir-suite</directory></testsuite></testsuites></phpunit>`,
  )

  const neitherXml = join(tempDir, "neither.xml")
  writeFileSync(neitherXml, `<phpunit><testsuites><testsuite name="empty"></testsuite></testsuites></phpunit>`)

  await t.test("case: only <file> declared runs exactly that file, no directory scan (the fix)", () => {
    const scriptPath = join(tempDir, "case-file-only.php")
    writeFileSync(
      scriptPath,
      `<?php
function pg_log($message) {}
${parseConfigFunction}
${discoverFunction}
list($directories, $suffixes, $prefixes, $excludes, $files) = wp_codebox_phpunit_parse_config(${phpString(fileOnlyXml)}, ${phpString(testsDir)});
if ($directories !== array()) {
    throw new RuntimeException('file-only testsuite must not fall back to the whole test root: ' . json_encode($directories));
}
$discovered = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes, $files);
if ($discovered !== array(${phpString(join(testsDir, "booking", "DeclaredTest.php"))})) {
    throw new RuntimeException('file-only testsuite swept in unrelated files: ' . json_encode($discovered));
}
echo "ok\\n";
`,
    )
    assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "ok\n")
  })

  await t.test("case: <directory> declared stays scoped to it (unchanged)", () => {
    const scriptPath = join(tempDir, "case-directory.php")
    writeFileSync(
      scriptPath,
      `<?php
function pg_log($message) {}
${parseConfigFunction}
${discoverFunction}
list($directories, $suffixes, $prefixes, $excludes, $files) = wp_codebox_phpunit_parse_config(${phpString(directoryXml)}, ${phpString(testsDir)});
if ($directories !== array(${phpString(join(testsDir, "dir-suite"))})) {
    throw new RuntimeException('directory-declaring testsuite must be unaffected by this fix: ' . json_encode($directories));
}
$discovered = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes, $files);
if ($discovered !== array(${phpString(join(testsDir, "dir-suite", "ScopedTest.php"))})) {
    throw new RuntimeException('directory-declaring testsuite discovery changed: ' . json_encode($discovered));
}
echo "ok\\n";
`,
    )
    assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "ok\n")
  })

  await t.test("case: neither <directory> nor <file> keeps the whole-test-root default (unchanged)", () => {
    const scriptPath = join(tempDir, "case-neither.php")
    writeFileSync(
      scriptPath,
      `<?php
function pg_log($message) {}
${parseConfigFunction}
${discoverFunction}
list($directories, $suffixes, $prefixes, $excludes, $files) = wp_codebox_phpunit_parse_config(${phpString(neitherXml)}, ${phpString(testsDir)});
if ($directories !== array(${phpString(testsDir)})) {
    throw new RuntimeException('config declaring neither <directory> nor <file> must keep the whole-test-root default: ' . json_encode($directories));
}
$discovered = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes, $files);
sort($discovered);
$expected = array(${phpString(join(testsDir, "UnrelatedTest.php"))}, ${phpString(join(testsDir, "booking", "DeclaredTest.php"))}, ${phpString(join(testsDir, "dir-suite", "ScopedTest.php"))});
sort($expected);
if ($discovered !== $expected) {
    throw new RuntimeException('whole-test-root discovery changed for a config declaring neither: ' . json_encode($discovered));
}
echo "ok\\n";
`,
    )
    assert.equal(execFileSync("php", [scriptPath], { encoding: "utf8" }), "ok\n")
  })
})
