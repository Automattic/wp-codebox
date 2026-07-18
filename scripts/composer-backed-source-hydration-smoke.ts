import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { recipeRunDependencyOverlay } from "../packages/cli/src/commands/recipe-runtime-setup.js"
import { prepareRecipeDependencyOverlays, prepareRecipeRuntimeOverlays } from "../packages/cli/src/recipe-sources.js"
import type { PreparedExtraPlugin } from "../packages/cli/src/recipe-sources.js"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/runtime-contracts.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-overlay-hydration-"))
const overlaySource = join(root, "php-ai-client")
const dependencySource = join(root, "generic-composer-package")
const nonGitDependencySource = join(root, "non-git-composer-package")
const binDir = join(root, "bin")
const scoperPath = join(root, "php-scoper.phar")
const originalPath = process.env.PATH
const originalScoper = process.env.WP_CODEBOX_PHP_SCOPER_PHAR
const execFile = promisify(execFileCallback)

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
await execFile("git", ["init", "--quiet"], { cwd: dependencySource })
await execFile("git", ["add", "."], { cwd: dependencySource })
await execFile("git", ["-c", "user.name=WP Codebox", "-c", "user.email=wp-codebox@example.test", "commit", "--quiet", "-m", "fixture"], { cwd: dependencySource })
const { stdout: dependencyReference } = await execFile("git", ["rev-parse", "HEAD"], { cwd: dependencySource })

await mkdir(join(nonGitDependencySource, "src"), { recursive: true })
await writeFile(join(nonGitDependencySource, "src", "Package.php"), "<?php\n")
await writeFile(join(nonGitDependencySource, "composer.json"), JSON.stringify({ name: "acme/non-git-package" }, null, 2))

const consumerSource = join(root, "consumer-plugin")
await mkdir(join(consumerSource, "vendor", "composer"), { recursive: true })
await writeFile(join(consumerSource, "vendor", "composer", "installed.json"), JSON.stringify({ packages: [
  { name: "acme/package", version: "1.0.0+no-version-set" },
  { name: "acme/non-git-package", version: "1.0.0+no-version-set" },
] }, null, 2))
await writeFile(join(consumerSource, "vendor", "composer", "installed.php"), `<?php

return array(
  'versions' => array(
    'acme/package' => array(
      'pretty_version' => '1.0.0+no-version-set',
    ),
    'acme/non-git-package' => array(
      'pretty_version' => '1.0.0+no-version-set',
      'reference' => NULL,
    ),
  ),
);
`)

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
const consumers: PreparedExtraPlugin[] = [{
  source: consumerSource,
  slug: "consumer-plugin",
  target: "/wordpress/wp-content/plugins/consumer-plugin",
  pluginFile: "consumer-plugin.php",
  activate: true,
  loadAs: "plugin",
  cleanupPaths: [],
  provenance: { kind: "local", original: consumerSource },
}]
const dependencyOverlays = await prepareRecipeDependencyOverlays({
  inputs: {
    dependency_overlays: [{
      kind: "composer-package",
      package: "acme/package",
      source: dependencySource,
      consumer: "consumer-plugin",
    }, {
      kind: "composer-package",
      package: "acme/non-git-package",
      source: nonGitDependencySource,
      consumer: "consumer-plugin",
    }],
  },
}, root, consumers)
try {
  assert.equal(overlays.length, 1)
  assert.equal(dependencyOverlays.length, 2)
  assert.equal(await exists(join(overlaySource, "vendor")), false, "overlay source checkout must not be mutated")
  assert.equal(await exists(join(dependencySource, "vendor")), false, "dependency overlay source checkout must not be mutated")
  assert.equal(await exists(join(overlays[0].source, "autoload.php")), true)
  assert.equal(await exists(join(overlays[0].source, "src", "Client.php")), true)
  assert.equal(await exists(join(overlays[0].source, "third-party", "Psr", "Log", "LoggerInterface.php")), true)
  assert.equal(await exists(join(dependencyOverlays[0].source, "vendor", "composer", "installed.json")), true)
  assert.equal(dependencyOverlays[0].target, "/wordpress/wp-content/plugins/consumer-plugin/vendor/acme/package")
  assert.equal(dependencyOverlays[0].reference, dependencyReference.trim(), "clean Git source revision survives Composer staging")
  assert.equal(dependencyOverlays[0].metadata.reference, dependencyReference.trim(), "mounted dependency metadata preserves the source revision")
  assert.equal(recipeRunDependencyOverlay(dependencyOverlays[0]).reference, dependencyReference.trim(), "runtime dependency provenance exposes the source revision")
  assert.equal(dependencyOverlays[1].reference, undefined, "non-Git source has no fabricated revision")
  assert.equal(dependencyOverlays[1].metadata.reference, undefined, "non-Git source metadata omits the revision")
  assert.equal((JSON.parse(await readFile(join(consumerSource, "vendor", "composer", "installed.json"), "utf8")) as { packages: Array<{ source?: unknown }> }).packages[0].source, undefined, "original consumer Composer provenance remains unchanged")
  const runtimeInstalled = JSON.parse(await readFile(join(consumers[0].source, "vendor", "composer", "installed.json"), "utf8")) as { packages: Array<{ name: string, version: string, source?: { reference?: string } }> }
  assert.deepEqual(runtimeInstalled.packages[0], { name: "acme/package", version: "1.0.0+no-version-set", source: { reference: dependencyReference.trim() } }, "runtime Composer dependency provenance includes the immutable source reference")
  assert.deepEqual(runtimeInstalled.packages[1], { name: "acme/non-git-package", version: "1.0.0+no-version-set" }, "runtime Composer provenance omits unresolved source references")
  const { stdout: runtimeInstalledPhp } = await execFile("php", ["-r", "echo json_encode(require $argv[1]);", join(consumers[0].source, "vendor", "composer", "installed.php")])
  const runtimePhpVersions = JSON.parse(runtimeInstalledPhp) as { versions: Record<string, { reference?: string | null }> }
  assert.equal(runtimePhpVersions.versions["acme/package"]?.reference, dependencyReference.trim(), "Composer runtime metadata includes the immutable source reference")
  assert.equal(runtimePhpVersions.versions["acme/non-git-package"]?.reference, null, "Composer runtime metadata leaves unresolved references unchanged")
  const runtimePackageRow = runtimePhpVersions.versions["acme/package"]
  assert.deepEqual(runtimePackageRow, {
    pretty_version: "1.0.0+no-version-set",
    reference: dependencyReference.trim(),
  }, "the final PHP-visible package row exposes the clean Git reference")
  assert.deepEqual(runtimePhpVersions.versions["acme/non-git-package"], {
    pretty_version: "1.0.0+no-version-set",
    reference: null,
  }, "the final PHP-visible package row leaves an unavailable reference unchanged")
  assert.match(await readFile(join(overlays[0].source, "src", "Client.php"), "utf8"), /WordPress\\AiClientDependencies\\Psr\\Log\\LoggerInterface/)
} finally {
  await Promise.all([...overlays, ...dependencyOverlays, ...consumers].flatMap((overlay) => overlay.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })))
  process.env.PATH = originalPath
  if (originalScoper === undefined) {
    delete process.env.WP_CODEBOX_PHP_SCOPER_PHAR
  } else {
    process.env.WP_CODEBOX_PHP_SCOPER_PHAR = originalScoper
  }
  await rm(root, { recursive: true, force: true })
}

console.log("composer-backed-source-hydration-smoke: ok")
