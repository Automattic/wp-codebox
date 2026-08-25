import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { cleanupRecipePreparedSources, materializeComposerPathRepositoryPackages, prepareRecipeExtraPlugins } from "../packages/cli/src/recipe-sources.js"
import { assertWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

const execFile = promisify(execFileCallback)

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

await withTempDir("wp-codebox-composer-metadata-plugin-", async (recipeDirectory) => {
  const source = join(recipeDirectory, "shipped-plugin")
  await mkdir(source, { recursive: true })
  await writeFile(join(source, "composer.json"), `${JSON.stringify({ name: "example/shipped-plugin", require: { "composer/installers": "^2" } }, null, 2)}\n`)
  await writeFile(join(source, "shipped-plugin.php"), "<?php\n/* Plugin Name: Shipped Plugin */\n")

  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: { extra_plugins: [{ source: "shipped-plugin", slug: "shipped-plugin", pluginFile: "shipped-plugin/shipped-plugin.php" }] },
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  }

  assertWorkspaceRecipeJsonSchema(recipe)
  const [plugin] = await prepareRecipeExtraPlugins(recipe, recipeDirectory)
  assert.equal(plugin.source, source, "Composer metadata alone must not stage or prepare the plugin")
  assert.deepEqual(plugin.cleanupPaths, [])
  assert.equal(await pathExists(join(source, "vendor")), false, "the shipped plugin source must remain untouched")
})

await withTempDir("wp-codebox-explicit-composer-plugin-", async (recipeDirectory) => {
  const source = join(recipeDirectory, "source-plugin")
  const pathPackage = join(source, "path-package")
  const bin = join(recipeDirectory, "bin")
  const pluginExecuted = join(recipeDirectory, "composer-plugin-executed")
  await mkdir(join(pathPackage, "src"), { recursive: true })
  await mkdir(bin, { recursive: true })
  await writeFile(join(source, "composer.json"), `${JSON.stringify({
    name: "example/source-plugin",
    autoload: { classmap: ["src/"] },
    repositories: [{ type: "path", url: "path-package", options: { symlink: false } }],
    require: { "example/runtime-package": "*", "example/malicious-plugin": "*" },
    config: { "allow-plugins": { "example/malicious-plugin": true } },
    extra: { "installer-paths": { "packages/{$name}": ["example/runtime-package"] } },
  }, null, 2)}\n`)
  await writeFile(join(source, "source-plugin.php"), "<?php\n/* Plugin Name: Source Plugin */\n")
  await writeFile(join(pathPackage, "composer.json"), `${JSON.stringify({ name: "example/runtime-package", type: "wordpress-plugin" })}\n`)
  await writeFile(join(pathPackage, "src", "Package.php"), "<?php namespace Example\\RuntimePackage; final class Package {}\n")
  const composer = join(bin, "composer")
  await writeFile(composer, `#!/bin/sh
case " $* " in
  *" --no-plugins "*) ;;
  *) touch ${JSON.stringify(pluginExecuted)}; exit 64 ;;
esac
case " $* " in
  *" --no-scripts "*) ;;
  *) touch ${JSON.stringify(pluginExecuted)}; exit 65 ;;
esac
mkdir -p vendor/composer vendor/example/runtime-package/src
printf '%s\n' '<?php require_once __DIR__ . "/example/runtime-package/src/Package.php";' > vendor/autoload.php
printf '%s\n' '<?php namespace Example\\RuntimePackage; final class Package {}' > vendor/example/runtime-package/src/Package.php
printf '%s\n' '{"name":"example/runtime-package","type":"wordpress-plugin"}' > vendor/example/runtime-package/composer.json
printf '%s\n' '{"packages":[{"name":"example/runtime-package","type":"wordpress-plugin","dist":{"type":"path","url":"path-package"},"install-path":"../example/runtime-package"}]}' > vendor/composer/installed.json
printf '<?php return array();\n' > vendor/composer/autoload_classmap.php
`)
  await chmod(composer, 0o755)

  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: { extra_plugins: [{ source: "source-plugin", slug: "source-plugin", pluginFile: "source-plugin/source-plugin.php", composer: "install" }] },
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  }

  assertWorkspaceRecipeJsonSchema(recipe)
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ""}`
  let plugin: Awaited<ReturnType<typeof prepareRecipeExtraPlugins>>[number] | undefined
  try {
    ;[plugin] = await prepareRecipeExtraPlugins(recipe, recipeDirectory)
  } finally {
    process.env.PATH = originalPath
  }

  assert.ok(plugin)
  assert.notEqual(plugin.source, source, "explicit Composer preparation must use a staged copy")
  assert.equal(await pathExists(join(plugin.source, "vendor", "autoload.php")), true)
  assert.match(await readFile(join(plugin.source, "vendor", "autoload_packages.php"), "utf8"), /require_once __DIR__ \. '\/autoload\.php';/)
  assert.equal(await pathExists(join(plugin.source, "packages", "runtime-package", "src", "Package.php")), true, "Composer must install the WordPress package at its declared runtime path")
  await execFile("php", ["-r", `define('ABSPATH', ${JSON.stringify(`${plugin.source}/`)}); require ${JSON.stringify(join(plugin.source, "vendor", "autoload_packages.php"))}; if (!class_exists('Example\\\\RuntimePackage\\\\Package')) { exit(1); }`])
  assert.equal(await pathExists(pluginExecuted), false, "recipe-authorized Composer plugins must remain disabled during host hydration")
  assert.equal(await pathExists(join(source, "vendor")), false, "explicit preparation must not mutate the caller source")
  assert.equal(plugin.provenance.localPathCategory, "temporary-composer-autoload")
  await cleanupRecipePreparedSources([], [plugin])
})

async function writeMaterializationFixture(root: string, installerPath: string): Promise<string> {
  const plugin = join(root, "plugin")
  const pathPackage = join(plugin, "path-package")
  const installedPackage = join(plugin, "vendor", "example", "runtime-package")
  await mkdir(join(pathPackage, "src"), { recursive: true })
  await mkdir(join(installedPackage, "src"), { recursive: true })
  await mkdir(join(plugin, "vendor", "composer"), { recursive: true })
  await writeFile(join(plugin, "composer.json"), JSON.stringify({
    repositories: [{ type: "path", url: "path-package", options: { symlink: false } }],
    extra: { "installer-paths": { [installerPath]: ["example/runtime-package"] } },
  }))
  const packageMetadata = JSON.stringify({ name: "example/runtime-package", type: "wordpress-plugin" })
  await writeFile(join(pathPackage, "composer.json"), packageMetadata)
  await writeFile(join(pathPackage, "src", "Package.php"), "<?php\n")
  await writeFile(join(installedPackage, "composer.json"), packageMetadata)
  await writeFile(join(installedPackage, "src", "Package.php"), "<?php\n")
  await writeFile(join(plugin, "vendor", "composer", "installed.json"), JSON.stringify({ packages: [{
    name: "example/runtime-package",
    type: "wordpress-plugin",
    dist: { type: "path", url: "path-package" },
    "install-path": "../example/runtime-package",
  }] }))
  return plugin
}

await withTempDir("wp-codebox-composer-parent-destination-", async (root) => {
  const plugin = await writeMaterializationFixture(root, "../escape/{$name}")
  await assert.rejects(() => materializeComposerPathRepositoryPackages(plugin, root), /destination must be a safe relative path/)
  assert.equal(await pathExists(join(root, "escape")), false)
})

await withTempDir("wp-codebox-composer-absolute-destination-", async (root) => {
  const destination = join(root, "escape", "{$name}")
  const plugin = await writeMaterializationFixture(root, destination)
  await assert.rejects(() => materializeComposerPathRepositoryPackages(plugin, root), /destination must be a bounded relative path/)
  assert.equal(await pathExists(join(root, "escape")), false)
})

console.log("recipe extra plugin Composer preparation ok")
