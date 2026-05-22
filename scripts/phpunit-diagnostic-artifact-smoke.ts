import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fixtureRoot = mkdtempSync(join(tmpdir(), "wp-codebox-phpunit-diagnostic-"))
const pluginRoot = join(fixtureRoot, "diagnostic-plugin")
mkdirSync(pluginRoot, { recursive: true })
writeFileSync(
  join(pluginRoot, "diagnostic-plugin.php"),
  `<?php
/**
 * Plugin Name: WP Codebox Diagnostic Fixture
 */
`,
)

const run = spawnSync(
  "node",
  [
    "packages/cli/dist/index.js",
    "run",
    "--mount",
    `${pluginRoot}:/wordpress/wp-content/plugins/diagnostic-plugin:readwrite`,
    "--command",
    "wordpress.phpunit",
    "--arg",
    "plugin-slug=diagnostic-plugin",
    "--json",
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
)

assert.equal(run.status, 1, run.stderr || run.stdout)

const diagnosticPath = join(pluginRoot, ".pg-test-result.txt")
assert.equal(existsSync(diagnosticPath), true, run.stderr || run.stdout)

const diagnostic = readFileSync(diagnosticPath, "utf8")
assert.match(diagnostic, /STAGE_BEGIN:boot/)
assert.match(diagnostic, /STAGE_FAIL:boot|NO_TEST_FILES/)

console.log("PHPUnit diagnostic artifact smoke passed")
