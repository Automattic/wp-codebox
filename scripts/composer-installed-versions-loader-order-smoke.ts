import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { installPluginComposerAutoloadersCode, type PreparedExtraPlugin } from "../packages/cli/src/recipe-sources.js"

const execFile = promisify(execFileCallback)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-composer-installed-versions-"))
const pluginDir = join(root, "plugins", "consumer")
const muPluginDir = join(root, "mu-plugins")
const packageName = "acme/package"

function installedVersionsSource(reference: string | null): string {
  const encodedReference = reference === null ? "null" : JSON.stringify(reference)
  return `<?php
namespace Composer;
class InstalledVersions {
    private static $data = array('versions' => array('${packageName}' => array('reference' => ${encodedReference})));
    public static function getReference($package) { return self::$data['versions'][$package]['reference'] ?? null; }
    public static function reload($data) { self::$data = $data; }
}
`
}

function installedDataSource(reference: string | null): string {
  return `<?php return array('versions' => array('${packageName}' => array('reference' => ${reference === null ? "null" : JSON.stringify(reference)})));\n`
}

async function run(reference: string | null): Promise<string> {
  await rm(root, { recursive: true, force: true })
  await mkdir(join(pluginDir, "vendor", "composer"), { recursive: true })
  await mkdir(join(pluginDir, "vendor", "acme", "package", "vendor", "composer"), { recursive: true })
  await mkdir(muPluginDir, { recursive: true })
  await writeFile(join(pluginDir, "vendor", "composer", "InstalledVersions.php"), installedVersionsSource(reference))
  await writeFile(join(pluginDir, "vendor", "composer", "installed.php"), installedDataSource(reference))
  await writeFile(join(pluginDir, "vendor", "autoload.php"), "<?php\n")
  await writeFile(join(pluginDir, "vendor", "acme", "package", "vendor", "composer", "InstalledVersions.php"), installedVersionsSource(reference))
  await writeFile(join(pluginDir, "vendor", "acme", "package", "vendor", "composer", "installed.php"), installedDataSource(reference))
  await writeFile(join(pluginDir, "vendor", "acme", "package", "vendor", "autoload.php"), "<?php if (!class_exists('Composer\\\\InstalledVersions', false)) { require_once __DIR__ . '/composer/InstalledVersions.php'; } Composer\\InstalledVersions::reload(require __DIR__ . '/composer/installed.php');\n")
  await writeFile(join(pluginDir, "vendor", "autoload_packages.php"), "<?php require_once __DIR__ . '/acme/package/vendor/autoload.php'; require_once __DIR__ . '/autoload.php';\n")

  const plugin: PreparedExtraPlugin = {
    source: pluginDir,
    slug: "consumer",
    target: "/wordpress/wp-content/plugins/consumer",
    pluginFile: "consumer/consumer.php",
    activate: true,
    loadAs: "plugin",
    cleanupPaths: [],
    provenance: { kind: "local", original: pluginDir },
  }
  const installCode = installPluginComposerAutoloadersCode([plugin])
  assert.ok(installCode)
  const { stdout } = await execFile("php", ["-r", `function wp_json_encode($value, $options = 0) { return json_encode($value, $options); } define('ABSPATH', ${JSON.stringify(`${root}/`)}); define('WP_PLUGIN_DIR', ${JSON.stringify(join(root, "plugins"))}); define('WPMU_PLUGIN_DIR', ${JSON.stringify(muPluginDir)}); ${installCode} require WPMU_PLUGIN_DIR . '/wp-codebox-composer-autoloaders.php'; echo Composer\\InstalledVersions::getReference('${packageName}');`])
  return stdout.slice(stdout.lastIndexOf("}") + 1).trim()
}

try {
  assert.equal(await run("overlay-reference"), "overlay-reference", "the nested Composer dataset exposes the overlay reference")
  assert.equal(await run(null), "", "a nested Composer dataset without a reference remains observable as null")
  console.log("composer-installed-versions-loader-order-smoke: ok")
} finally {
  await rm(root, { recursive: true, force: true })
}
