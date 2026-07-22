import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareRecipeDependencyOverlays } from "../packages/cli/src/recipe-sources.js"
import type { PreparedExtraPlugin } from "../packages/cli/src/recipe-sources.js"

// Proves the dependency overlay reconciles its on-disk PSR-4 layout to the
// path the consumer's committed autoloader resolves. A repo published as
// `src/` but consumed as `php-transformer/src/` (Blocks Engine's transformer,
// mounted into Static Site Importer) would otherwise land where the consumer
// autoloader never looks, so the override is silently ignored and the pinned
// released version keeps running.

const root = await mkdtemp(join(tmpdir(), "wp-codebox-overlay-autoload-layout-"))

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
await writeFile(join(overrideSource, "composer.json"), JSON.stringify({
  name: "automattic/blocks-engine-php-transformer",
  autoload: { "psr-4": { "Automattic\\BlocksEngine\\PhpTransformer\\": "src/" } },
}, null, 2))
await mkdir(join(overrideSource, "vendor", "composer"), { recursive: true })
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
  // The class must be relocated to the consumer's recorded PSR-4 path so the
  // consumer autoloader resolves it after the vendor-path mount.
  assert.equal(await exists(join(staged, "php-transformer", "src", "ArtifactCompiler", "ArtifactCompiler.php")), true, "override class relocated to consumer PSR-4 layout")
  assert.equal(await exists(join(staged, "src", "ArtifactCompiler", "ArtifactCompiler.php")), false, "override source layout no longer shadows the consumer path")
  assert.equal(dependencyOverlays[0].target, "/wordpress/wp-content/plugins/consumer-plugin/vendor/automattic/blocks-engine-php-transformer")
  // The override checkout itself is never mutated.
  assert.equal(await exists(join(overrideSource, "php-transformer")), false, "override checkout is not restructured in place")
  assert.equal(await exists(join(overrideSource, "src", "ArtifactCompiler", "ArtifactCompiler.php")), true, "override checkout keeps its own layout")
} finally {
  await Promise.all([...dependencyOverlays, ...consumers].flatMap((overlay) => overlay.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })))
  await rm(root, { recursive: true, force: true })
}

console.log("composer-package-overlay-autoload-layout-smoke: ok")
