import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { phpunitRunCode, corePhpunitRunCode } from "../packages/runtime-playground/src/phpunit-command-handlers.js"

// Regression coverage for https://github.com/Automattic/wp-codebox/issues/2528.
//
// Root cause: `<directory>`/`<file>` entries in phpunit.xml are resolved against
// dirname($xml_path) (phpunitConfigDiscoveryPhp's basePathExpression), the component root.
// When the configured phpunit.xml path passed to the harness is a bare/relative filename
// (the real-world shape: `phpunitXml: "phpunit-managed.xml.dist"`), dirname() of that is
// the literal string ".", so `<directory>tests/Unit/Core</directory>` resolves to the
// relative string "./tests/Unit/Core" and discovered test files keep that shape, e.g.
// "./tests/Unit/Core/X.php". The changed-file scope arrives sandbox-absolute, e.g.
// "/wordpress/wp-content/plugins/<slug>/tests/Unit/Core/X.php". The old filter normalized
// both sides against $test_root (a different base than dirname($xml_path)), so the
// discovered and changed paths could never compare equal and a suite-owned changed test was
// always dropped, running zero tests while PHPUnit's "No tests executed!" exited 0 as a pass.
//
// These tests exercise the *generated* PHP (via phpunitRunCode/corePhpunitRunCode), not a
// hand-copied reimplementation, so they fail if the fix regresses.

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

function phpJsonArray(values: string[]): string {
  return phpString(JSON.stringify(values))
}

function minimalPluginOptions(overrides: Partial<Parameters<typeof phpunitRunCode>[0]>) {
  return {
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
    bootstrapMode: "managed" as const,
    projectBootstrap: "",
    multisite: false,
    databaseType: "sqlite" as const,
    ...overrides,
  }
}

test("changed-file filter normalization (issue #2528)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-2528-"))
  mkdirSync(join(tempDir, "tests", "Unit", "Core"), { recursive: true })
  writeFileSync(join(tempDir, "tests", "Unit", "Core", "DirDeclaredTest.php"), "<?php final class DirDeclaredTest extends TestCase {}\n")
  writeFileSync(join(tempDir, "tests", "FileDeclaredTest.php"), "<?php final class FileDeclaredTest extends TestCase {}\n")
  // Outside both the <directory> and <file> entries below -- never discovered, so it can
  // never be matched no matter what changed-file scope requests it.
  writeFileSync(join(tempDir, "tests", "NotInSuiteTest.php"), "<?php final class NotInSuiteTest extends TestCase {}\n")

  // Reproduces the exact reported shape: the configured phpunit.xml is a bare relative
  // filename (matching real production callers, e.g. `phpunitXml: "phpunit-managed.xml.dist"`),
  // so dirname($xml_path) is "." and <directory>/<file> entries resolve relative to the
  // process cwd, exactly like the harness's own chdir($runtime_cwd) before discovery.
  const relativeXmlName = "phpunit-managed.xml.dist"
  writeFileSync(
    join(tempDir, relativeXmlName),
    `<phpunit>
  <testsuites>
    <testsuite name="managed-wordpress">
      <directory>tests/Unit/Core</directory>
      <file>tests/FileDeclaredTest.php</file>
    </testsuite>
  </testsuites>
</phpunit>`,
  )

  const code = phpunitRunCode(minimalPluginOptions({ phpunitXml: relativeXmlName }))
  const parseConfigFn = extractPhpFunction(code, "wp_codebox_phpunit_parse_config")
  const discoverFn = extractPhpFunction(code, "wp_codebox_phpunit_discover")
  const filterFn = extractPhpFunction(code, "pg_filter_changed_test_files")
  const relativeFn = extractPhpFunction(code, "pg_component_relative_path")

  // The generated call site must anchor the filter on dirname($xml_path) ("." here, the same
  // base basePathExpression uses for <directory>/<file> resolution), not $test_dir.
  assert.match(code, /pg_filter_changed_test_files\(\$test_files, \$changed_test_files_raw, "\."\)/)

  function runScenario(name: string, changedFiles: string[]): { requested: number; matched: number; files: string[] } {
    const scriptPath = join(tempDir, `case-${name}.php`)
    writeFileSync(
      scriptPath,
      `<?php
chdir(${phpString(tempDir)});
function pg_log($message) { echo $message . "\\n"; }
${parseConfigFn}
${discoverFn}
${relativeFn}
${filterFn}
list($directories, $suffixes, $prefixes, $excludes, $files) = wp_codebox_phpunit_parse_config(${phpString(relativeXmlName)}, ${phpString(join(tempDir, "tests"))});
$discovered = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes, $files);
$filtered = pg_filter_changed_test_files($discovered, ${phpJsonArray(changedFiles)}, '.');
echo 'RESULT:' . json_encode(array_values($filtered)) . "\\n";
`,
    )
    const output = execFileSync("php", [scriptPath], { encoding: "utf8" })
    const requestedMatch = output.match(/SCOPED_TEST_FILES requested=(\d+) matched=(\d+)/)
    assert.ok(requestedMatch, `expected SCOPED_TEST_FILES marker in output:\n${output}`)
    const resultMatch = output.match(/RESULT:(\[.*\])/)
    assert.ok(resultMatch, `expected RESULT marker in output:\n${output}`)
    return {
      requested: Number(requestedMatch[1]),
      matched: Number(requestedMatch[2]),
      files: JSON.parse(resultMatch[1]),
    }
  }

  await t.test("case: <directory>-declared file, changed path sandbox-absolute", () => {
    const changed = [join(tempDir, "tests", "Unit", "Core", "DirDeclaredTest.php")]
    const result = runScenario("directory-declared", changed)
    assert.equal(result.requested, 1)
    assert.equal(result.matched, 1)
    assert.deepEqual(result.files, ["./tests/Unit/Core/DirDeclaredTest.php"])
  })

  await t.test("case: <file>-declared file, changed path sandbox-absolute", () => {
    const changed = [join(tempDir, "tests", "FileDeclaredTest.php")]
    const result = runScenario("file-declared", changed)
    assert.equal(result.requested, 1)
    assert.equal(result.matched, 1)
    // The returned entry is discovery's own path string (unchanged production behavior --
    // only the comparison *key* is canonicalized, not the value require_once eventually
    // loads), which here is the "./"-relative form <file> resolved to under dirname($xml_path).
    assert.deepEqual(result.files, ["./tests/FileDeclaredTest.php"])
  })

  await t.test("case: changed path itself is './'-prefixed (relative on both sides)", () => {
    const changed = ["./tests/Unit/Core/DirDeclaredTest.php"]
    const result = runScenario("dotslash-changed", changed)
    assert.equal(result.requested, 1)
    assert.equal(result.matched, 1)
    assert.deepEqual(result.files, ["./tests/Unit/Core/DirDeclaredTest.php"])
  })

  await t.test("case: absolute changed path matches './'-prefixed discovered path (the reported bug)", () => {
    // This is the exact shape from the issue: discovery finds "./tests/Unit/Core/X.php"
    // (relative, because dirname($xml_path) === "."), the changed-file scope arrives
    // sandbox-absolute. Before the fix these could never compare equal.
    const changed = [
      join(tempDir, "tests", "Unit", "Core", "DirDeclaredTest.php"),
      join(tempDir, "tests", "FileDeclaredTest.php"),
    ]
    const result = runScenario("absolute-vs-dotslash", changed)
    assert.equal(result.requested, 2)
    assert.equal(result.matched, 2)
    assert.deepEqual([...result.files].sort(), ["./tests/FileDeclaredTest.php", "./tests/Unit/Core/DirDeclaredTest.php"].sort())
  })

  await t.test("case: zero-match scope is reported honestly, not silently substituted (no duplicate policy layer)", () => {
    // A changed file that exists on disk but isn't declared by this suite at all (outside
    // both the <directory> and <file> entries, so discovery never finds it). The filter must
    // report requested=1 matched=0 and return an empty set -- it must NOT fall back to running
    // the full discovered suite. wp-codebox stays honest; failing the build on a zero-match
    // scoped run is the downstream caller's policy (see homeboy-extensions#2886), not
    // wp-codebox's.
    const changed = [join(tempDir, "tests", "NotInSuiteTest.php")]
    const result = runScenario("zero-match", changed)
    assert.equal(result.requested, 1)
    assert.equal(result.matched, 0)
    assert.deepEqual(result.files, [])
  })
})

test("core changed-file filter also anchors on dirname($phpunit_xml), not $core_root (issue #2528)", () => {
  const code = corePhpunitRunCode({
    coreRoot: "/wordpress",
    testsDir: "/wordpress/tests/phpunit",
    phpunitXml: "/wordpress/tests/phpunit/phpunit.xml.dist",
    phpunitXmlIsDefault: false,
    selectedTestFile: "",
    changedTestFiles: [],
    autoloadFile: "/wp-codebox-vendor/autoload.php",
    wpConfigDefines: {},
    multisite: false,
  })

  assert.match(code, /core_pg_filter_changed_test_files\(\$test_files, \$changed_test_files_raw, dirname\(\$phpunit_xml\)\)/)
  assert.doesNotMatch(code, /core_pg_filter_changed_test_files\(\$test_files, \$changed_test_files_raw, \$core_root\)/)

  const filterFn = extractPhpFunction(code, "core_pg_filter_changed_test_files")
  const relativeFn = extractPhpFunction(code, "core_pg_relative_path")

  const tempDir = mkdtempSync(join(tmpdir(), "wp-codebox-core-phpunit-2528-"))
  mkdirSync(join(tempDir, "tests", "phpunit", "tests"), { recursive: true })
  writeFileSync(join(tempDir, "tests", "phpunit", "tests", "CoreDeclaredTest.php"), "<?php final class CoreDeclaredTest extends TestCase {}\n")

  const scriptPath = join(tempDir, "case-core.php")
  writeFileSync(
    scriptPath,
    `<?php
function core_pg_log($message) { echo $message . "\\n"; }
${relativeFn}
${filterFn}
// Mirrors the generated call site: dirname($phpunit_xml) is the component root discovery
// actually used, resolved via the ordinary absolute phpunit.xml default (no relative-cwd
// dependency needed to prove the anchor is correct for the core path too).
$phpunit_xml = ${phpString(join(tempDir, "tests", "phpunit", "phpunit.xml.dist"))};
$discovered = array(${phpString(join(tempDir, "tests", "phpunit", "tests", "CoreDeclaredTest.php"))});
$changed = array(${phpString(join(tempDir, "tests", "phpunit", "tests", "CoreDeclaredTest.php"))});
$filtered = core_pg_filter_changed_test_files($discovered, json_encode($changed), dirname($phpunit_xml));
echo 'RESULT:' . json_encode(array_values($filtered)) . "\\n";
`,
  )
  const output = execFileSync("php", [scriptPath], { encoding: "utf8" })
  assert.match(output, /SCOPED_TEST_FILES requested=1 matched=1/)
  const resultMatch = output.match(/RESULT:(\[.*\])/)
  assert.ok(resultMatch, `expected RESULT marker in output:\n${output}`)
  assert.deepEqual(JSON.parse(resultMatch[1]), [join(tempDir, "tests", "phpunit", "tests", "CoreDeclaredTest.php")])
})
