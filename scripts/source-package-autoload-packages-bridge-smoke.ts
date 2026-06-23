import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { prepareRecipeSourcePackageSync } from "../packages/runtime-core/src/recipe-source-packages.js"

const root = mkdtempSync(join(tmpdir(), "wp-codebox-source-package-autoload-packages-"))
const originalPath = process.env.PATH ?? ""

try {
  const bin = join(root, "bin")
  const sourceRoot = join(root, "source")
  const pluginSource = join(sourceRoot, "plugins", "woocommerce")
  const artifactsRoot = join(root, "artifacts")
  mkdirSync(bin, { recursive: true })
  mkdirSync(pluginSource, { recursive: true })

  writeFileSync(join(pluginSource, "composer.json"), `${JSON.stringify({ name: "wp-codebox/source-package-autoload-packages-smoke" }, null, 2)}\n`)
  writeFileSync(join(bin, "composer"), `#!/bin/sh
mkdir -p vendor
printf "%s\n" "<?php // composer autoload" > vendor/autoload.php
printf "%s\n" "<?php" "namespace WpCodeboxSmoke;" "require_once __DIR__ . '/jetpack-autoloader/class-autoloader.php';" "Autoloader::init();" > vendor/autoload_packages.php
mkdir -p vendor/jetpack-autoloader
printf "%s\n" "<?php // package autoloader" > vendor/jetpack-autoloader/class-autoloader.php
mkdir -p vendor/composer packages/email-editor/src/Engine/Renderer packages/email-editor/src
printf "%s\n" '{"packages":[{"name":"woocommerce/email-editor","install-path":"../../packages/email-editor","autoload":{"classmap":["src/"]}}]}' > vendor/composer/installed.json
printf "%s\n" "<?php" "return array(" "    'Automattic\\\\WooCommerce\\\\EmailEditor\\\\Package' => __DIR__ . '/../../packages/email-editor/src/class-package.php'," ");" > vendor/composer/autoload_classmap.php
printf "%s\n" "<?php namespace Automattic\\WooCommerce\\EmailEditor; class Package {}" > packages/email-editor/src/class-package.php
printf "%s\n" "<?php throw new RuntimeException('template files must not be eagerly required');" > packages/email-editor/src/Engine/Renderer/template-canvas.php
`, { mode: 0o755 })

  process.env.PATH = `${bin}${delimiter}${originalPath}`
  const prepared = prepareRecipeSourcePackageSync({
    source: sourceRoot,
    originalSource: sourceRoot,
    sourceSubpath: "plugins/woocommerce",
    slug: "woocommerce",
    artifactsRoot,
    packageRootName: "prepared-plugins",
  })

  const packageAutoloader = join(prepared, "vendor", "autoload_packages.php")
  assert.equal(existsSync(packageAutoloader), true)
  const bridgedPackageAutoloader = readFileSync(packageAutoloader, "utf8")
  assert.match(bridgedPackageAutoloader, /require_once __DIR__ \. '\/autoload\.php';/)
  assert.ok(bridgedPackageAutoloader.indexOf("require_once __DIR__ . '/autoload.php';") < bridgedPackageAutoloader.indexOf("Autoloader::init();"))
  assert.match(bridgedPackageAutoloader, /spl_autoload_register/)
  assert.doesNotMatch(bridgedPackageAutoloader, /template-canvas/)
  assert.equal(existsSync(join(pluginSource, "vendor", "autoload_packages.php")), false, "source checkout must not be mutated")

  console.log("source-package-autoload-packages-bridge-smoke: ok")
} finally {
  process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
}
