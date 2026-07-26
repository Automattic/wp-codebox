import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { installPluginComposerAutoloadersCode, type PreparedExtraPlugin } from "../packages/cli/src/recipe-sources.js"

const execFile = promisify(execFileCallback)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-extra-plugin-autoloaders-"))
const pluginsDir = join(root, "plugins")
const muPluginsDir = join(root, "mu-plugins")

function plugin(slug: string, activate: boolean): PreparedExtraPlugin {
  return {
    source: join(pluginsDir, slug),
    slug,
    target: `/wordpress/wp-content/plugins/${slug}`,
    pluginFile: `${slug}/${slug}.php`,
    activate,
    loadAs: "plugin",
    cleanupPaths: [],
    provenance: { kind: "local", original: join(pluginsDir, slug) },
  }
}

try {
  await mkdir(join(pluginsDir, "active-provider", "vendor"), { recursive: true })
  await mkdir(join(pluginsDir, "inactive-plugin", "vendor"), { recursive: true })
  await mkdir(join(pluginsDir, "inactive-plugin", "tests"), { recursive: true })
  await mkdir(muPluginsDir, { recursive: true })

  await writeFile(join(pluginsDir, "active-provider", "vendor", "autoload.php"), "<?php function wp_codebox_active_provider_loaded() { return true; }\n")
  await writeFile(join(pluginsDir, "inactive-plugin", "composer.json"), JSON.stringify({
    autoload: { "psr-4": { "InactivePlugin\\\\": "src/" } },
    "autoload-dev": { files: ["tests/autoload-dev.php"] },
  }))
  await writeFile(join(pluginsDir, "inactive-plugin", "tests", "autoload-dev.php"), "<?php function wp_codebox_inactive_plugin_dev_sentinel() { return true; }\n")
  await writeFile(join(pluginsDir, "inactive-plugin", "vendor", "autoload.php"), "<?php require_once dirname(__DIR__) . '/tests/autoload-dev.php';\n")

  const installCode = installPluginComposerAutoloadersCode([
    plugin("active-provider", true),
    plugin("inactive-plugin", false),
  ])
  assert.ok(installCode)
  assert.doesNotMatch(installCode, /inactive-plugin/, "inactive plugin inputs are absent from the generated preload contract")

  const php = `
function wp_json_encode($value, $options = 0) { return json_encode($value, $options); }
define('ABSPATH', ${JSON.stringify(`${root}/`)});
define('WP_PLUGIN_DIR', ${JSON.stringify(pluginsDir)});
define('WPMU_PLUGIN_DIR', ${JSON.stringify(muPluginsDir)});
${installCode}
echo "\n---RESULT---\n";
require WPMU_PLUGIN_DIR . '/wp-codebox-composer-autoloaders.php';
echo json_encode(array(
    'active_provider_loaded' => function_exists('wp_codebox_active_provider_loaded'),
    'inactive_dev_sentinel_loaded' => function_exists('wp_codebox_inactive_plugin_dev_sentinel'),
));
`
  const { stdout } = await execFile("php", ["-r", php])
  const [evidenceJson, resultJson] = stdout.split("\n---RESULT---\n")
  assert.deepEqual(JSON.parse(evidenceJson), {
    command: "install-composer-autoloaders",
    plugins: ["active-provider/active-provider.php"],
    autoloaders: ["active-provider/vendor/autoload.php"],
    loader: join(muPluginsDir, "wp-codebox-composer-autoloaders.php"),
  }, "setup evidence names each intentionally preloaded autoloader")
  assert.deepEqual(JSON.parse(resultJson), {
    active_provider_loaded: true,
    inactive_dev_sentinel_loaded: false,
  })

  console.log("recipe extra plugin composer autoloaders ok")
} finally {
  await rm(root, { recursive: true, force: true })
}
