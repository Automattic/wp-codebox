import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareRecipeDependencyOverlays, prepareRecipeRuntimeOverlays } from "../packages/cli/src/recipe-sources.js"
import type { PreparedExtraPlugin } from "../packages/cli/src/recipe-sources.js"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/runtime-contracts.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-overlay-hydration-"))
const overlaySource = join(root, "php-ai-client")
const dependencySource = join(root, "generic-composer-package")
const binDir = join(root, "bin")
const scoperPath = join(root, "php-scoper.phar")
const originalPath = process.env.PATH
const originalScoper = process.env.WP_CODEBOX_PHP_SCOPER_PHAR

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

await rm(overlaySource, { recursive: true, force: true })
await mkdir(join(overlaySource, "src"), { recursive: true })
await writeFile(join(overlaySource, "src", "Client.php"), String.raw`<?php
namespace WordPress\AiClient;

use Psr\Log\LoggerInterface;

final class Client {
	public function __construct( private LoggerInterface $logger ) {}
}
`)
await writeFile(join(overlaySource, "composer.json"), JSON.stringify({
  name: "wordpress/php-ai-client",
  autoload: { "psr-4": { "WordPress\\AiClient\\": "src/" } },
  require: { "psr/log": "^3.0" },
}, null, 2))

await mkdir(join(dependencySource, "src"), { recursive: true })
await writeFile(join(dependencySource, "src", "Package.php"), String.raw`<?php
namespace Acme\Package;

final class Package {}
`)
await writeFile(join(dependencySource, "composer.json"), JSON.stringify({
  name: "acme/package",
  autoload: { "psr-4": { "Acme\\Package\\": "src/" } },
  require: { "psr/log": "^3.0" },
}, null, 2))

await writeFile(scoperPath, `<?php
$workingDir = '';
$outputDir = '';
foreach ($argv as $index => $arg) {
	if ('--working-dir' === $arg) { $workingDir = $argv[$index + 1] ?? ''; }
	if ('--output-dir' === $arg) { $outputDir = $argv[$index + 1] ?? ''; }
}
if ('' === $workingDir || '' === $outputDir) { fwrite(STDERR, 'missing scoper args'); exit(1); }
function copy_tree(string $source, string $target): void {
	if (is_dir($source)) {
		@mkdir($target, 0777, true);
		foreach (scandir($source) ?: array() as $entry) {
			if ('.' === $entry || '..' === $entry) { continue; }
			copy_tree($source . DIRECTORY_SEPARATOR . $entry, $target . DIRECTORY_SEPARATOR . $entry);
		}
		return;
	}
	@mkdir(dirname($target), 0777, true);
	copy($source, $target);
}
copy_tree($workingDir, $outputDir);
`)

await rm(binDir, { recursive: true, force: true })
await mkdir(binDir, { recursive: true })
await writeFile(join(binDir, "composer"), String.raw`#!/bin/sh
set -eu
working_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --working-dir) working_dir="$2"; shift 2 ;;
    --working-dir=*) working_dir="\${1#--working-dir=}"; shift ;;
    *) shift ;;
  esac
done
if [ -z "$working_dir" ]; then working_dir="$PWD"; fi
mkdir -p "$working_dir/vendor/composer" "$working_dir/vendor/psr/log/src"
cat > "$working_dir/vendor/composer/installed.json" <<'JSON'
{"packages":[{"name":"wordpress/php-ai-client","autoload":{"psr-4":{"WordPress\\AiClient\\":"src/"}}},{"name":"psr/log","autoload":{"psr-4":{"Psr\\Log\\":"src/"}}}]}
JSON
cat > "$working_dir/vendor/psr/log/src/LoggerInterface.php" <<'PHP'
<?php
namespace Psr\Log;
interface LoggerInterface {}
PHP
`)
await chmod(join(binDir, "composer"), 0o755)

process.env.PATH = `${binDir}:${originalPath ?? ""}`
process.env.WP_CODEBOX_PHP_SCOPER_PHAR = scoperPath

const recipe: WorkspaceRecipe = {
  runtime: {
    wp: "latest",
    overlays: [{
      kind: "bundled-library",
      library: "php-ai-client",
      source: overlaySource,
      strategy: "wordpress-scoped-bundle",
    }],
  },
}

const overlays = await prepareRecipeRuntimeOverlays(recipe, root)
const dependencyOverlays = await prepareRecipeDependencyOverlays({
  inputs: {
    dependency_overlays: [{
      kind: "composer-package",
      package: "acme/package",
      source: dependencySource,
      consumer: "consumer-plugin",
    }],
  },
}, root, [{
  source: join(root, "consumer-plugin"),
  slug: "consumer-plugin",
  target: "/wordpress/wp-content/plugins/consumer-plugin",
  pluginFile: "consumer-plugin.php",
  activate: true,
  loadAs: "plugin",
  cleanupPaths: [],
  provenance: { kind: "local", original: join(root, "consumer-plugin") },
}] satisfies PreparedExtraPlugin[])
try {
  assert.equal(overlays.length, 1)
  assert.equal(dependencyOverlays.length, 1)
  assert.equal(await exists(join(overlaySource, "vendor")), false, "overlay source checkout must not be mutated")
  assert.equal(await exists(join(dependencySource, "vendor")), false, "dependency overlay source checkout must not be mutated")
  assert.equal(await exists(join(overlays[0].source, "autoload.php")), true)
  assert.equal(await exists(join(overlays[0].source, "src", "Client.php")), true)
  assert.equal(await exists(join(overlays[0].source, "third-party", "Psr", "Log", "LoggerInterface.php")), true)
  assert.equal(await exists(join(dependencyOverlays[0].source, "vendor", "composer", "installed.json")), true)
  assert.equal(dependencyOverlays[0].target, "/wordpress/wp-content/plugins/consumer-plugin/vendor/acme/package")
  assert.match(await readFile(join(overlays[0].source, "src", "Client.php"), "utf8"), /WordPress\\AiClientDependencies\\Psr\\Log\\LoggerInterface/)
} finally {
  await Promise.all([...overlays, ...dependencyOverlays].flatMap((overlay) => overlay.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })))
  process.env.PATH = originalPath
  if (originalScoper === undefined) {
    delete process.env.WP_CODEBOX_PHP_SCOPER_PHAR
  } else {
    process.env.WP_CODEBOX_PHP_SCOPER_PHAR = originalScoper
  }
  await rm(root, { recursive: true, force: true })
}

console.log("composer-backed-source-hydration-smoke: ok")
