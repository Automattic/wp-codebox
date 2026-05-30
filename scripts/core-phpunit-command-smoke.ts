import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { corePhpunitRunCode, phpunitRunCode } from "../packages/runtime-playground/src/commands.js"

const code = corePhpunitRunCode({
  coreRoot: "/wordpress",
  testsDir: "/wordpress/tests/phpunit",
  phpunitXml: "/wordpress/tests/phpunit/phpunit.xml.dist",
  selectedTestFile: "tests/phpunit/tests/basic.php",
  changedTestFiles: ["tests/phpunit/tests/basic.php"],
  autoloadFile: "/wordpress/vendor/autoload.php",
  wpConfigDefines: { WP_TESTS_FORCE_KNOWN_BUGS: false },
  multisite: true,
})

assert.match(code, /\$core_root = rtrim\("\/wordpress", '\/'\);/)
assert.match(code, /define\('WP_RUN_CORE_TESTS', true\)/)
assert.match(code, /define\('WP_TESTS_CONFIG_FILE_PATH', \$config_path\)/)
assert.match(code, /require_once \$tests_dir \. '\/includes\/bootstrap\.php'/)
assert.match(code, /core_pg_parse_phpunit_config\(\$phpunit_xml, \$tests_dir \. '\/tests'\)/)
assert.match(code, /new PHPUnit\\TextUI\\TestRunner\(\)/)
assert.match(code, /SCOPED_TEST_FILES requested=/)
assert.match(code, /putenv\('WP_MULTISITE=1'\)/)
assert.match(code, /'WP_TESTS_MULTISITE' => true/)
assert.doesNotMatch(code, /plugin-slug/)
assert.doesNotMatch(code, /wp-content\/plugins/)

// #314: the structured diagnostics log must default to a sandbox-internal /tmp path
// (not inside the possibly read-only core mount) so it survives read-only mounts and
// a mid-require die() in core's bootstrap.php.
assert.match(code, /\$result_file = "\/tmp\/wp-codebox-core-phpunit-result\.txt"/)
assert.doesNotMatch(code, /\$result_file = \$core_root \. '\/\.pg-test-result\.txt'/)

// #314: a custom resultFile option must be honored verbatim.
const customResultCode = corePhpunitRunCode({
  coreRoot: "/wordpress",
  testsDir: "/wordpress/tests/phpunit",
  phpunitXml: "/wordpress/tests/phpunit/phpunit.xml.dist",
  selectedTestFile: "",
  changedTestFiles: [],
  autoloadFile: "/wordpress/vendor/autoload.php",
  wpConfigDefines: {},
  multisite: false,
  resultFile: "/tmp/custom-result.txt",
})
assert.match(customResultCode, /\$result_file = "\/tmp\/custom-result\.txt"/)

// #314: pre-flight the Composer test toolchain before requiring core's bootstrap, and
// fail with a clear message naming PHPUnit + yoast/phpunit-polyfills.
assert.match(code, /function core_pg_preflight_core_toolchain/)
assert.match(code, /core_pg_preflight_core_toolchain\(\$core_root, \$tests_dir, \$autoload_file\)/)
assert.match(code, /vendor\/yoast\/phpunit-polyfills\/phpunitpolyfills-autoload\.php/)
assert.match(code, /core PHPUnit requires Composer dev dependencies/)

// #314: harden the bootstrap require so a die() mid-require still flushes diagnostics.
assert.match(code, /\$core_pg_bootstrap_buffering = true;/)
assert.match(code, /ob_start\(\);/)
assert.match(code, /STAGE_DIE:/)

const pluginCode = phpunitRunCode({
  pluginSlug: "network-plugin",
  autoloadFile: "/wp-codebox-vendor/autoload.php",
  testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
  phpunitXml: "/wordpress/wp-content/plugins/network-plugin/phpunit.xml.dist",
  selectedTestFile: "",
  changedTestFiles: [],
  env: {},
  wpConfigDefines: {},
  dependencyMounts: [],
  multisite: true,
})

assert.match(pluginCode, /\$ms_tests = !empty\(\$cfg\['multisite'\]\) \? 'run_ms_tests' : 'no_ms_tests'/)
assert.match(pluginCode, /pg_activate_plugin_file\(\$plugin_file, !empty\(\$cfg\['multisite'\]\)\)/)
assert.match(pluginCode, /do_action\('activate_' \. \$plugin_basename, \$network_wide\)/)
assert.match(pluginCode, /update_site_option\('active_sitewide_plugins', \$active_plugins\)/)
assert.match(pluginCode, /putenv\('WP_MULTISITE=1'\)/)

const fixtureRoot = mkdtempSync(join(tmpdir(), "wp-codebox-core-phpunit-"))
const coreRoot = join(fixtureRoot, "wordpress")
mkdirSync(join(coreRoot, "tests", "phpunit"), { recursive: true })
writeFileSync(join(coreRoot, "tests", "phpunit", "phpunit.xml.dist"), "<phpunit />\n")

const recipePath = join(fixtureRoot, "recipe.json")
writeFileSync(
  recipePath,
  JSON.stringify(
    {
      schema: "wp-codebox/workspace-recipe/v1",
      inputs: {
        mounts: [{ source: coreRoot, target: "/wordpress" }],
      },
      workflow: {
        steps: [
          {
            command: "wordpress.core-phpunit",
            args: ["core-root=/wordpress", "tests-dir=/wordpress/tests/phpunit", "phpunit-xml=/wordpress/tests/phpunit/phpunit.xml.dist", "multisite=1"],
          },
        ],
      },
    },
    null,
    2,
  ),
)

const validation = spawnSync("node", ["packages/cli/dist/index.js", "recipe", "validate", "--recipe", recipePath, "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
})
assert.equal(validation.status, 0, validation.stderr || validation.stdout)
const validationOutput = JSON.parse(validation.stdout)
assert.equal(validationOutput.valid, true)
assert.deepEqual(validationOutput.issues, [])
assert.equal(validationOutput.summary.steps, 1)

console.log("Core PHPUnit command smoke passed")
