import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { buildAgentTaskRecipe } from "../packages/runtime-core/src/agent-task-recipe.js"
import { normalizeTaskInput } from "../packages/runtime-core/src/task-input.js"

const execFile = promisify(execFileCallback)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-composer-overlay-projected-runtime-"))
const consumer = join(root, "consumer-plugin")
const overlay = join(root, "overlay-package")
const artifacts = join(root, "artifacts")
const reference = "0123456789abcdef0123456789abcdef01234567"

async function writePackage(source: string, marker: string): Promise<void> {
  await mkdir(join(source, "src"), { recursive: true })
  await mkdir(join(source, "website", "js"), { recursive: true })
  await writeFile(join(source, "composer.json"), JSON.stringify({
    name: "acme/asset",
    autoload: { "psr-4": { "Acme\\Asset\\": "src/" } },
  }))
  await writeFile(join(source, "src", "Asset.php"), `<?php
namespace Acme\\Asset;
final class Asset {
    public static function marker(): string {
        $html = file_get_contents(__DIR__ . '/../website/index.html');
        preg_match('/src="([^"]+)"/', $html, $matches);
        return trim(file_get_contents(__DIR__ . '/../website/' . $matches[1]));
    }
}
`)
  await writeFile(join(source, "website", "index.html"), '<script src="js/site.js"></script>\n')
  await writeFile(join(source, "website", "js", "site.js"), `${marker}\n`)
}

try {
  await writePackage(join(consumer, "vendor", "acme", "asset"), "base-package")
  await mkdir(join(consumer, "vendor", "composer"), { recursive: true })
  await writeFile(join(consumer, "composer.json"), JSON.stringify({ name: "acme/consumer-plugin" }))
  await writeFile(join(consumer, "vendor", "composer", "installed.json"), JSON.stringify({ packages: [{
    name: "acme/asset",
    "install-path": "../acme/asset",
    autoload: { "psr-4": { "Acme\\Asset\\": "src/" } },
  }] }))
  await writeFile(join(consumer, "vendor", "composer", "autoload_psr4.php"), `<?php
return array('Acme\\\\Asset\\\\' => array($vendorDir . '/acme/asset/src'));
`)
  await writeFile(join(consumer, "vendor", "autoload.php"), `<?php
$vendorDir = __DIR__;
$prefixes = require __DIR__ . '/composer/autoload_psr4.php';
spl_autoload_register(static function (string $class) use ($prefixes): void {
    foreach ($prefixes as $prefix => $directories) {
        if (!str_starts_with($class, $prefix)) continue;
        $relative = str_replace('\\\\', '/', substr($class, strlen($prefix))) . '.php';
        foreach ($directories as $directory) {
            $file = $directory . '/' . $relative;
            if (is_file($file)) { require_once $file; return; }
        }
    }
});
`)
  await writeFile(join(consumer, "consumer-plugin.php"), `<?php
/** Plugin Name: Projected Composer Consumer */
require_once __DIR__ . '/vendor/autoload.php';
file_put_contents(WP_CONTENT_DIR . '/projected-composer-overlay.txt', \\Acme\\Asset\\Asset::marker());
`)

  await writePackage(overlay, "selected-overlay")
  await mkdir(join(overlay, "vendor", "composer"), { recursive: true })
  await writeFile(join(overlay, "vendor", "composer", "installed.json"), JSON.stringify({ packages: [{
    name: "acme/asset",
    autoload: { "psr-4": { "Acme\\Asset\\": "src/" } },
  }] }))

  const recipe = buildAgentTaskRecipe({
    artifacts_path: artifacts,
    component_contracts: [{
      path: consumer,
      slug: "consumer-plugin",
      pluginFile: "consumer-plugin.php",
      loadAs: "plugin",
      activate: true,
    }],
    dependency_overlays: [{
      kind: "composer-package",
      package: "acme/asset",
      source: overlay,
      reference,
      consumer: "consumer-plugin",
    }],
  }, normalizeTaskInput({ goal: "Execute projected Composer overlay" }), "latest")
  recipe.workflow = {
    steps: [{ command: "wordpress.run-php", args: ["code=echo file_get_contents( WP_CONTENT_DIR . '/projected-composer-overlay.txt' );"] }],
  }
  assert.equal(recipe.inputs?.dependency_overlays?.[0]?.reference, reference, "the projected recipe retains the immutable overlay reference")
  const recipePath = join(root, "recipe.json")
  await writeFile(recipePath, `${JSON.stringify(recipe)}\n`)

  const { stdout } = await execFile(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], {
    cwd: process.cwd(),
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const output = JSON.parse(stdout) as { executions?: Array<{ command?: string; stdout?: string }> }
  const execution = output.executions?.filter((candidate) => candidate.command === "wordpress.run-php").at(-1)
  assert.equal(execution?.stdout?.trim(), "selected-overlay", "the projected Playground runtime must execute the selected dependency overlay")

  const projectedVendor = await readFile(join(artifacts, "prepared-plugins", "consumer-plugin", "vendor", "autoload.php"), "utf8")
  assert.match(projectedVendor, /autoload_psr4/, "component projection preserves the hydrated Composer implementation")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("composer overlay projected runtime: ok")
