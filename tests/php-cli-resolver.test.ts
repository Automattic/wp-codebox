import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Proves the WP Codebox CLI resolver (the single owner of CLI binary
// selection) picks the bundled CLI only when its packaged version and
// platform/arch provenance match the plugin and host, records a reason code
// for every rejection, falls back to wp-codebox on PATH otherwise, keeps an
// explicit wp_codebox_bin option or filter in charge, and applies the same
// bundled decision to the bundled Node.js runtime.
const PLUGIN_VERSION = "9.9.9"

interface BundleSpec {
  version?: string
  platform?: string
  arch?: string
  withBin?: boolean
  withNode?: boolean
}

interface ScenarioResult {
  bin: string
  default_bin: string
  reason: string
  bundled_version: string | null
  bundled_platform: string | null
  bundled_arch: string | null
  host_platform: string
  host_arch: string
  node: string
}

function stagePluginRoot(spec: BundleSpec): string {
  const root = mkdtempSync(join(tmpdir(), "wp-codebox-cli-resolver-"))
  const bundle = join(root, "vendor", "wp-codebox-cli")

  if (spec.withBin === false) {
    return root
  }

  mkdirSync(join(bundle, "bin"), { recursive: true })
  writeFileSync(join(bundle, "bin", "wp-codebox"), "#!/usr/bin/env bash\n")
  chmodSync(join(bundle, "bin", "wp-codebox"), 0o755)

  if (spec.version !== undefined) {
    writeFileSync(join(bundle, "package.json"), `${JSON.stringify({ name: "wp-codebox-cli", version: spec.version }, null, 2)}\n`)
  }
  if (spec.platform !== undefined && spec.arch !== undefined) {
    writeFileSync(
      join(bundle, "browser-provenance.json"),
      `${JSON.stringify({ schema: "wp-codebox/playwright-browser-provenance/v1", platform: spec.platform, arch: spec.arch }, null, 2)}\n`,
    )
  }
  if (spec.withNode) {
    mkdirSync(join(bundle, "vendor", "node", "bin"), { recursive: true })
    writeFileSync(join(bundle, "vendor", "node", "bin", "node"), "#!/usr/bin/env bash\n")
    chmodSync(join(bundle, "vendor", "node", "bin", "node"), 0o755)
  }

  return root
}

function runScenario(spec: { pluginRoot: string; option?: string; filter?: string }): ScenarioResult {
  const php = `
define('ABSPATH', '/srv/site/');
define('WP_CODEBOX_PLUGIN_VERSION', ${JSON.stringify(PLUGIN_VERSION)});
define('WP_CODEBOX_PLUGIN_PATH', ${JSON.stringify(`${spec.pluginRoot}/`)});

$GLOBALS['test_options'] = json_decode(${JSON.stringify(JSON.stringify(spec.option === undefined ? {} : { wp_codebox_bin: spec.option }))}, true);
function get_option($name, $default = false) { return array_key_exists($name, $GLOBALS['test_options']) ? $GLOBALS['test_options'][$name] : $default; }

$GLOBALS['test_filters'] = json_decode(${JSON.stringify(JSON.stringify(spec.filter === undefined ? {} : { wp_codebox_bin: spec.filter }))}, true);
function apply_filters($hook, $value) { return array_key_exists($hook, $GLOBALS['test_filters']) ? $GLOBALS['test_filters'][$hook] : $value; }

require __DIR__ . '/packages/wordpress-plugin/src/class-wp-codebox-cli-resolver.php';

$d = WP_Codebox_Cli_Resolver::resolve();
echo json_encode(array(
  'bin' => $d['bin'],
  'default_bin' => WP_Codebox_Cli_Resolver::default_bin(),
  'reason' => $d['reason'],
  'bundled_version' => $d['bundled_version'],
  'bundled_platform' => $d['bundled_platform'],
  'bundled_arch' => $d['bundled_arch'],
  'host_platform' => $d['host_platform'],
  'host_arch' => $d['host_arch'],
  'node' => WP_Codebox_Cli_Resolver::bundled_node_binary(),
), JSON_UNESCAPED_SLASHES);
`

  const output = execFileSync("php", ["-r", php], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  })

  return JSON.parse(output) as ScenarioResult
}

function foreignPlatform(hostPlatform: string): string {
  return hostPlatform === "macos" ? "linux" : "macos"
}

const roots: string[] = []
try {
  // Probe the host mapping the resolver will compare provenance against.
  const probeRoot = stagePluginRoot({ withBin: false })
  roots.push(probeRoot)
  const probe = runScenario({ pluginRoot: probeRoot })
  assert.equal(probe.reason, "bundled_cli_missing")
  assert.equal(probe.bin, "wp-codebox")
  assert.match(probe.host_platform, /^(macos|linux|windows|freebsd|sunos)$/)
  assert.match(probe.host_arch, /^(x64|arm64|ia32|[a-z0-9]+)$/)

  // 1. A matching bundle is selected, and the bundled node runtime follows it.
  const matchingRoot = stagePluginRoot({ version: PLUGIN_VERSION, platform: probe.host_platform, arch: probe.host_arch, withNode: true })
  roots.push(matchingRoot)
  const matching = runScenario({ pluginRoot: matchingRoot })
  const bundledBin = `${matchingRoot}/vendor/wp-codebox-cli/bin/wp-codebox`
  assert.equal(matching.bin, bundledBin, "matching bundle is selected")
  assert.equal(matching.default_bin, bundledBin)
  assert.equal(matching.reason, "bundled_cli_selected")
  assert.equal(matching.bundled_version, PLUGIN_VERSION)
  assert.equal(matching.bundled_platform, probe.host_platform)
  assert.equal(matching.bundled_arch, probe.host_arch)
  assert.equal(matching.node, `${matchingRoot}/vendor/wp-codebox-cli/vendor/node/bin/node`, "bundled node follows the selected bundle")

  // 2. A version mismatch falls back to PATH with a diagnostic reason.
  const staleRoot = stagePluginRoot({ version: "0.21.2", platform: probe.host_platform, arch: probe.host_arch, withNode: true })
  roots.push(staleRoot)
  const stale = runScenario({ pluginRoot: staleRoot })
  assert.equal(stale.bin, "wp-codebox")
  assert.equal(stale.reason, "bundled_cli_version_mismatch")
  assert.equal(stale.bundled_version, "0.21.2")
  assert.equal(stale.node, "", "a rejected bundle never provides the node runtime")

  // 3. A platform mismatch falls back to PATH with a diagnostic reason.
  const foreignRoot = stagePluginRoot({ version: PLUGIN_VERSION, platform: foreignPlatform(probe.host_platform), arch: probe.host_arch, withNode: true })
  roots.push(foreignRoot)
  const foreign = runScenario({ pluginRoot: foreignRoot })
  assert.equal(foreign.bin, "wp-codebox")
  assert.equal(foreign.reason, "bundled_cli_platform_mismatch")
  assert.equal(foreign.node, "")

  // 3b. An arch mismatch is a platform mismatch too.
  const wrongArchRoot = stagePluginRoot({ version: PLUGIN_VERSION, platform: probe.host_platform, arch: probe.host_arch === "x64" ? "arm64" : "x64" })
  roots.push(wrongArchRoot)
  const wrongArch = runScenario({ pluginRoot: wrongArchRoot })
  assert.equal(wrongArch.reason, "bundled_cli_platform_mismatch")
  assert.equal(wrongArch.bin, "wp-codebox")

  // 4. A missing bundle falls back to PATH.
  const missingRoot = stagePluginRoot({ withBin: false })
  roots.push(missingRoot)
  const missing = runScenario({ pluginRoot: missingRoot })
  assert.equal(missing.bin, "wp-codebox")
  assert.equal(missing.reason, "bundled_cli_missing")
  assert.equal(missing.bundled_version, null)

  // 5. An explicit wp_codebox_bin option wins over a matching bundle.
  const overriddenRoot = stagePluginRoot({ version: PLUGIN_VERSION, platform: probe.host_platform, arch: probe.host_arch })
  roots.push(overriddenRoot)
  const optionOverride = runScenario({ pluginRoot: overriddenRoot, option: "/opt/custom/wp-codebox" })
  assert.equal(optionOverride.bin, "/opt/custom/wp-codebox")
  assert.equal(optionOverride.reason, "configured")

  // 5b. The wp_codebox_bin filter wins the same way.
  const filterOverride = runScenario({ pluginRoot: overriddenRoot, filter: "/opt/filtered/wp-codebox" })
  assert.equal(filterOverride.bin, "/opt/filtered/wp-codebox")
  assert.equal(filterOverride.reason, "configured")

  // Contract wiring: every former duplication site delegates to the resolver,
  // and the readiness output surfaces its decision.
  const resolverPhp = readFileSync("packages/wordpress-plugin/src/class-wp-codebox-cli-resolver.php", "utf8")
  const sandboxRunnerPhp = readFileSync("packages/wordpress-plugin/src/class-wp-codebox-agent-sandbox-runner.php", "utf8")
  const artifactsPhp = readFileSync("packages/wordpress-plugin/src/class-wp-codebox-artifacts.php", "utf8")
  const viewportReplayPhp = readFileSync("packages/wordpress-plugin/src/class-wp-codebox-browser-viewport-replay.php", "utf8")
  const registryPhp = readFileSync("packages/wordpress-plugin/src/class-wp-codebox-runtime-provider-registry.php", "utf8")
  const pluginPhp = readFileSync("packages/wordpress-plugin/wp-codebox.php", "utf8")

  for (const [name, source] of [
    ["agent-sandbox-runner", sandboxRunnerPhp],
    ["artifacts", artifactsPhp],
    ["browser-viewport-replay", viewportReplayPhp],
  ] as const) {
    assert.match(source, /WP_Codebox_Cli_Resolver::default_bin\(\)/, `${name} resolves the CLI through the resolver`)
    assert.doesNotMatch(source, /vendor\/wp-codebox-cli\/bin\/wp-codebox/, `${name} no longer hardcodes the bundled CLI path`)
  }
  assert.match(sandboxRunnerPhp, /WP_Codebox_Cli_Resolver::bundled_node_binary\(\)/, "node binary resolution follows the resolver decision")
  assert.match(sandboxRunnerPhp, /WP_Codebox_Cli_Resolver::is_bundled_cli\(/, "bundled wrapper detection goes through the resolver")
  assert.match(registryPhp, /WP_Codebox_Cli_Resolver::readiness\(\)/, "readiness output surfaces the CLI decision")
  assert.match(pluginPhp, /class-wp-codebox-cli-resolver\.php/, "plugin bootstrap loads the resolver")
  for (const reason of ["bundled_cli_selected", "bundled_cli_version_mismatch", "bundled_cli_platform_mismatch", "bundled_cli_missing", "configured"]) {
    assert.ok(resolverPhp.includes(reason), `resolver defines the ${reason} reason code`)
  }
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log("php-cli-resolver: OK")
