import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { parseWorkspaceRecipeJson, validateWorkspaceRecipeShape } from "../packages/cli/src/recipe-validation.js"
import { prepareRecipeRuntimeOverlays, resolvePhpScoper } from "../packages/cli/src/recipe-sources.js"
import { loadConfiguredRuntimeOverlayDescriptors, registeredRuntimeOverlayDescriptors, runtimeOverlayDescriptor } from "../packages/cli/src/runtime-overlay-registry.js"
import { discoverRuntimeOverlayDescriptorManifests, runtimeOverlayDescriptorManifest } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

const builtIn = runtimeOverlayDescriptor({ kind: "bundled-library", library: "php-ai-client", strategy: "wordpress-scoped-bundle" })
assert.equal(builtIn?.defaultTarget, "/wordpress/wp-includes/php-ai-client")

await withTempDir("wp-codebox-php-scoper-cache-", async (root) => {
  const previousConfigured = process.env.WP_CODEBOX_PHP_SCOPER_PHAR
  const previousCacheDir = process.env.WP_CODEBOX_PHP_SCOPER_CACHE_DIR
  try {
    process.env.WP_CODEBOX_PHP_SCOPER_PHAR = join(root, "configured-scoper.phar")
    assert.equal(await resolvePhpScoper(root), process.env.WP_CODEBOX_PHP_SCOPER_PHAR)

    delete process.env.WP_CODEBOX_PHP_SCOPER_PHAR
    process.env.WP_CODEBOX_PHP_SCOPER_CACHE_DIR = join(root, "cache")
    const cachedScoper = join(process.env.WP_CODEBOX_PHP_SCOPER_CACHE_DIR, "php-scoper", "0.18.17", "php-scoper.phar")
    await mkdir(join(process.env.WP_CODEBOX_PHP_SCOPER_CACHE_DIR, "php-scoper", "0.18.17"), { recursive: true })
    await writeFile(cachedScoper, "cached scoper")
    assert.equal(await resolvePhpScoper(root), cachedScoper)
  } finally {
    if (previousConfigured === undefined) {
      delete process.env.WP_CODEBOX_PHP_SCOPER_PHAR
    } else {
      process.env.WP_CODEBOX_PHP_SCOPER_PHAR = previousConfigured
    }
    if (previousCacheDir === undefined) {
      delete process.env.WP_CODEBOX_PHP_SCOPER_CACHE_DIR
    } else {
      process.env.WP_CODEBOX_PHP_SCOPER_CACHE_DIR = previousCacheDir
    }
  }
})

await withTempDir("wp-codebox-runtime-overlay-descriptors-", async (root) => {
  const descriptorDirectory = join(root, "descriptors")
  await mkdir(descriptorDirectory)
  await writeFile(join(descriptorDirectory, "wp-codebox-runtime-overlays.json"), JSON.stringify({
    schema: "wp-codebox/runtime-overlay-descriptors/v1",
    descriptors: [{
      kind: "provider-runtime",
      library: "example-provider",
      strategy: "provider-owned-bundle",
      defaultTarget: "/wordpress/wp-content/mu-plugins/example-provider-runtime",
      capabilities: { provided: ["example-provider/runtime", "example-provider/runtime"] },
    }],
  }))

  const discovered = discoverRuntimeOverlayDescriptorManifests({ directories: [descriptorDirectory], availableCapabilities: ["wordpress/runtime-overlay"] })
  assert.equal(discovered.length, 1)
  assert.deepEqual(discovered[0].manifest.descriptors[0].capabilities?.provided, ["example-provider/runtime"])

  loadConfiguredRuntimeOverlayDescriptors(descriptorDirectory)
  assert.ok(registeredRuntimeOverlayDescriptors().some((descriptor) => descriptor.library === "example-provider"))

  await mkdir(join(root, "overlays", "example"), { recursive: true })
  await writeFile(join(root, "overlays", "example", "runtime.php"), "<?php\n")

  const recipe = parseWorkspaceRecipeJson(JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { overlays: [{ kind: "provider-runtime", library: "example-provider", strategy: "provider-owned-bundle", source: "overlays/example" }] },
    workflow: { steps: [{ command: "noop" }] },
  }))
  validateWorkspaceRecipeShape(recipe, join(root, "recipe.json"))
  const [prepared] = await prepareRecipeRuntimeOverlays(recipe, root)
  assert.equal(prepared.source, join(root, "overlays", "example"))
  assert.equal(prepared.target, "/wordpress/wp-content/mu-plugins/example-provider-runtime")
  assert.equal(prepared.mode, "readonly")
  assert.equal(prepared.metadata.preparedPathKind, "local")
  assert.equal(typeof (prepared.metadata.digest as { sha256?: unknown }).sha256, "string")

  await writeFile(join(descriptorDirectory, "wp-codebox-runtime-overlays.json"), JSON.stringify({
    schema: "wp-codebox/runtime-overlay-descriptors/v1",
    descriptors: [{ kind: "bundled-library", library: "php-ai-client", strategy: "wordpress-scoped-bundle", defaultTarget: "/wordpress/wp-includes/php-ai-client" }],
  }))
  loadConfiguredRuntimeOverlayDescriptors(descriptorDirectory)
  assert.equal(typeof runtimeOverlayDescriptor({ kind: "bundled-library", library: "php-ai-client", strategy: "wordpress-scoped-bundle" })?.prepare, "function")
})

assert.throws(() => runtimeOverlayDescriptorManifest({
  schema: "wp-codebox/runtime-overlay-descriptors/v1",
  descriptors: [{
    kind: "provider-runtime",
    library: "missing-capability",
    strategy: "provider-owned-bundle",
    defaultTarget: "/wordpress/wp-content/mu-plugins/missing-capability",
    capabilities: { required: ["missing/runtime-capability"] },
  }],
}, { availableCapabilities: ["wordpress/runtime-overlay"] }), /requires unavailable capabilities/)

await withTempDir("wp-codebox-runtime-overlay-package-descriptors-", async (root) => {
  const packageRoot = join(root, "provider-package")
  await mkdir(join(packageRoot, "codebox"), { recursive: true })
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ wpCodebox: { runtimeOverlayDescriptors: "codebox/runtime-overlays.json" } }))
  await writeFile(join(packageRoot, "codebox", "runtime-overlays.json"), JSON.stringify({
    schema: "wp-codebox/runtime-overlay-descriptors/v1",
    descriptors: [{ kind: "provider-runtime", library: "package-provider", strategy: "provider-owned-bundle", defaultTarget: "/wordpress/wp-content/mu-plugins/package-provider" }],
  }))

  const discovered = discoverRuntimeOverlayDescriptorManifests({ packages: [packageRoot] })
  assert.equal(discovered[0].manifest.descriptors[0].library, "package-provider")
})

console.log("runtime overlay descriptors ok")
