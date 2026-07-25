import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { prepareRecipeDependencyOverlays } from "../packages/cli/src/recipe-sources.js"
import type { PreparedExtraPlugin } from "../packages/cli/src/recipe-sources.js"

// Proves the dependency overlay reconciles its on-disk PSR-4 layout to the
// path the consumer's committed autoloader resolves. A repo published as
// `src/` but consumed as `php-transformer/src/` (Blocks Engine's transformer,
// mounted into Static Site Importer) would otherwise land where the consumer
// autoloader never looks, so the override is silently ignored and the pinned
// released version keeps running.

const root = await mkdtemp(join(tmpdir(), "wp-codebox-overlay-autoload-layout-"))
const execFileAsync = promisify(execFile)

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// Override checkout ships its class under the package-canonical `src/` layout,
// with a prebuilt vendor/ so no Composer hydration is needed.
const overrideSource = join(root, "blocks-engine-php-transformer")
await mkdir(join(overrideSource, "src", "ArtifactCompiler"), { recursive: true })
await writeFile(join(overrideSource, "src", "ArtifactCompiler", "ArtifactCompiler.php"), "<?php\nnamespace Automattic\\BlocksEngine\\PhpTransformer\\ArtifactCompiler;\nfinal class ArtifactCompiler {}\n")
await writeFile(join(overrideSource, "php-transformer.php"), "<?php\nrequire __DIR__ . '/vendor/autoload.php';\nif (!class_exists(Automattic\\BlocksEngine\\PhpTransformer\\ArtifactCompiler\\ArtifactCompiler::class)) { throw new RuntimeException('classmap bootstrap failed'); }\n")
await writeFile(join(overrideSource, "composer.json"), JSON.stringify({
  name: "automattic/blocks-engine-php-transformer",
  autoload: { "psr-4": { "Automattic\\BlocksEngine\\PhpTransformer\\": "src/" } },
}, null, 2))
await mkdir(join(overrideSource, "vendor", "composer"), { recursive: true })
await writeFile(join(overrideSource, "vendor", "autoload.php"), "<?php\nforeach (require __DIR__ . '/composer/autoload_classmap.php' as $path) { require $path; }\n")
await writeFile(join(overrideSource, "vendor", "composer", "autoload_classmap.php"), "<?php\n$vendorDir = dirname(__DIR__);\n$baseDir = dirname($vendorDir);\nreturn ['Automattic\\\\BlocksEngine\\\\PhpTransformer\\\\ArtifactCompiler\\\\ArtifactCompiler' => $baseDir . '/src/ArtifactCompiler/ArtifactCompiler.php'];\n")
await writeFile(join(overrideSource, "vendor", "composer", "installed.json"), JSON.stringify({ packages: [
  { name: "automattic/blocks-engine-php-transformer", autoload: { "psr-4": { "Automattic\\BlocksEngine\\PhpTransformer\\": "src/" } } },
] }, null, 2))

// Consumer records the same package under the repo-relative `php-transformer/src/`
// layout its release zip extracts to.
const consumerSource = join(root, "consumer-plugin")
await mkdir(join(consumerSource, "vendor", "composer"), { recursive: true })
await writeFile(join(consumerSource, "vendor", "composer", "installed.json"), JSON.stringify({ packages: [
  { name: "automattic/blocks-engine-php-transformer", version: "0.4.4", autoload: { "psr-4": { "Automattic\\BlocksEngine\\PhpTransformer\\": "php-transformer/src/" } } },
] }, null, 2))

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
      package: "automattic/blocks-engine-php-transformer",
      source: overrideSource,
      consumer: "consumer-plugin",
    }],
  },
}, root, consumers)

try {
  assert.equal(dependencyOverlays.length, 1)
  const staged = dependencyOverlays[0].source
  // A shared wrapper layout moves the complete hydrated package, keeping its
  // bootstrap, package-local autoloader, and classmap base directory coherent.
  assert.equal(await exists(join(staged, "php-transformer", "src", "ArtifactCompiler", "ArtifactCompiler.php")), true, "override class relocated to consumer PSR-4 layout")
  assert.equal(await exists(join(staged, "php-transformer", "php-transformer.php")), true, "package bootstrap moves with its source")
  assert.equal(await exists(join(staged, "php-transformer", "vendor", "autoload.php")), true, "package-local autoloader moves with its source")
  assert.equal(await exists(join(staged, "php-transformer", "vendor", "composer", "autoload_classmap.php")), true, "package-local classmap moves with its source")
  assert.equal(await exists(join(staged, "src", "ArtifactCompiler", "ArtifactCompiler.php")), false, "override source layout no longer shadows the consumer path")
  assert.equal(await exists(join(staged, "php-transformer.php")), false, "bootstrap is not stranded at the old package root")
  assert.equal(await exists(join(staged, "vendor", "autoload.php")), false, "package-local autoloader is not stranded at the old package root")
  const classmap = await readFile(join(staged, "php-transformer", "vendor", "composer", "autoload_classmap.php"), "utf8")
  assert.match(classmap, /\$baseDir \. '\/src\/ArtifactCompiler\/ArtifactCompiler\.php'/, "classmap remains relative to the relocated complete package")
  await execFileAsync("php", [join(staged, "php-transformer", "php-transformer.php")])
  assert.equal(dependencyOverlays[0].target, "/wordpress/wp-content/plugins/consumer-plugin/vendor/automattic/blocks-engine-php-transformer")
  // The override checkout itself is never mutated.
  assert.equal(await exists(join(overrideSource, "php-transformer")), false, "override checkout is not restructured in place")
  assert.equal(await exists(join(overrideSource, "src", "ArtifactCompiler", "ArtifactCompiler.php")), true, "override checkout keeps its own layout")
  assert.equal(await exists(join(overrideSource, "php-transformer.php")), true, "override checkout keeps its bootstrap")
  assert.equal(await exists(join(overrideSource, "vendor", "autoload.php")), true, "override checkout keeps its package-local autoloader")
} finally {
  await Promise.all([...dependencyOverlays, ...consumers].flatMap((overlay) => overlay.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })))
  await rm(root, { recursive: true, force: true })
}

console.log("composer-package-overlay-autoload-layout-smoke: ok")
