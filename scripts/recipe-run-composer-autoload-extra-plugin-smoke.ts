import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const artifacts = resolve(root, "artifacts/recipe-run-composer-autoload-extra-plugin-smoke")
const monorepoSource = resolve(artifacts, "source-monorepo")
const pluginSource = resolve(monorepoSource, "plugins", "woocommerce")
const siblingPackageSource = resolve(monorepoSource, "packages", "php", "email-editor")
const secondSiblingPackageSource = resolve(monorepoSource, "packages", "php", "blueprint")
const recipePath = resolve(artifacts, "recipe.json")

rmSync(artifacts, { recursive: true, force: true })
mkdirSync(resolve(pluginSource, "src"), { recursive: true })
mkdirSync(resolve(siblingPackageSource, "src"), { recursive: true })
mkdirSync(resolve(secondSiblingPackageSource, "src"), { recursive: true })

writeFileSync(resolve(pluginSource, "composer.json"), `${JSON.stringify({
  name: "wp-codebox/composer-autoload-smoke",
  autoload: { classmap: ["src/"] },
  repositories: [
    { type: "path", url: "../../packages/php/email-editor", options: { symlink: false } },
    { type: "path", url: "../../packages/php/blueprint", options: { symlink: false } },
  ],
  require: { "composer/installers": "^1.9", "woocommerce/email-editor": "*", "woocommerce/blueprint": "*" },
  config: { "allow-plugins": { "composer/installers": true } },
  extra: { "installer-paths": { "packages/{$name}": ["woocommerce/email-editor", "woocommerce/blueprint"] } },
  "minimum-stability": "dev",
  "prefer-stable": true,
}, null, 2)}\n`)

writeFileSync(resolve(pluginSource, "composer-autoload-smoke.php"), `<?php
/**
 * Plugin Name: WP Codebox Composer Autoload Smoke
 */

defined( 'ABSPATH' ) || exit;

register_activation_hook( __FILE__, static function (): void {
	if ( ! class_exists( \\WpCodeboxComposerSmoke\\Fixture::class ) ) {
		throw new RuntimeException( 'Composer classmap fixture was not autoloaded.' );
	}
	$sibling_package = __DIR__ . '/packages/email-editor/src/class-package.php';
	if ( ! is_file( $sibling_package ) ) {
		throw new RuntimeException( 'Composer path repository WordPress package was not installed.' );
	}
	$second_sibling_package = __DIR__ . '/packages/blueprint/src/Package.php';
	if ( ! is_file( $second_sibling_package ) ) {
		throw new RuntimeException( 'Second Composer path repository WordPress package was not installed.' );
	}
	update_option( 'wp_codebox_composer_smoke_value', \\WpCodeboxComposerSmoke\\Fixture::value() + \\WpCodeboxComposerSmoke\\InternalEmailPackage::value() + \\Automattic\\WooCommerce\\Blueprint\\Package::value() );
} );
`)

writeFileSync(resolve(pluginSource, "src", "Fixture.php"), `<?php

namespace WpCodeboxComposerSmoke;

final class Fixture {
	public static function value(): int {
		return 992;
	}
}
`)

writeFileSync(resolve(pluginSource, "src", "InternalEmailPackage.php"), `<?php

namespace WpCodeboxComposerSmoke;

final class InternalEmailPackage {
	public const VERSION = \\Automattic\\WooCommerce\\EmailEditor\\Package::VERSION;

	public static function value(): int {
		return \\Automattic\\WooCommerce\\EmailEditor\\Package::value();
	}
}
`)

writeFileSync(resolve(siblingPackageSource, "composer.json"), `${JSON.stringify({
  name: "woocommerce/email-editor",
  type: "wordpress-plugin",
  autoload: { classmap: ["src/"] },
  version: "dev-main",
}, null, 2)}\n`)

writeFileSync(resolve(siblingPackageSource, "src", "class-package.php"), `<?php

namespace Automattic\\WooCommerce\\EmailEditor;

final class Package {
	public const VERSION = '0.1.0';

	public static function value(): int {
		return 8;
	}
}
`)

writeFileSync(resolve(secondSiblingPackageSource, "composer.json"), `${JSON.stringify({
  name: "woocommerce/blueprint",
  type: "wordpress-plugin",
  autoload: { "psr-4": { "Automattic\\WooCommerce\\Blueprint\\": "src/" } },
  version: "dev-main",
}, null, 2)}\n`)

writeFileSync(resolve(secondSiblingPackageSource, "src", "Package.php"), `<?php

namespace Automattic\\WooCommerce\\Blueprint;

final class Package {
	public static function value(): int {
		return 4;
	}
}
`)

writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-run-composer-autoload-extra-plugin-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    extra_plugins: [
      {
        source: pluginSource,
        sourceRoot: monorepoSource,
        sourceSubpath: "plugins/woocommerce",
        slug: "composer-autoload-smoke",
        pluginFile: "composer-autoload-smoke/composer-autoload-smoke.php",
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: [
          "code=if (!class_exists('WpCodeboxComposerSmoke\\\\Fixture')) { throw new RuntimeException('autoloaded class missing after plugin boot'); } if (!is_file(WP_PLUGIN_DIR . '/composer-autoload-smoke/packages/email-editor/src/class-package.php')) { throw new RuntimeException('path repository WordPress package missing after plugin boot'); } if (!is_file(WP_PLUGIN_DIR . '/composer-autoload-smoke/packages/blueprint/src/Package.php')) { throw new RuntimeException('second path repository WordPress package missing after plugin boot'); } if (!class_exists('Automattic\\\\WooCommerce\\\\EmailEditor\\\\Package')) { throw new RuntimeException('path repository WordPress package class missing after plugin boot'); } if (!class_exists('Automattic\\\\WooCommerce\\\\Blueprint\\\\Package')) { throw new RuntimeException('second path repository WordPress package class missing after plugin boot'); } echo wp_json_encode(array('value' => get_option('wp_codebox_composer_smoke_value'), 'active' => is_plugin_active('composer-autoload-smoke/composer-autoload-smoke.php')));",
        ],
      },
    ],
  },
}, null, 2)}\n`)

assert.equal(existsSync(resolve(pluginSource, "vendor", "autoload.php")), false, "fixture source should start without Composer vendor/autoload.php")

const result = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  artifacts,
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(result.status, 0, result.stderr || result.stdout)
const output = JSON.parse(result.stdout)
assert.equal(output.success, true)

const workflowExecution = output.executions.find((execution: { command: string; recipePhase?: string }) => execution.command === "wordpress.run-php" && execution.recipePhase === "steps")
assert.ok(workflowExecution)

const workflowResult = JSON.parse(workflowExecution.stdout)
assert.equal(workflowResult.value, "1004")
assert.equal(workflowResult.active, true)
assert.equal(existsSync(resolve(pluginSource, "vendor", "autoload.php")), false, "recipe-run must not mutate the caller plugin checkout")
assert.equal(existsSync(resolve(pluginSource, "composer.lock")), false, "recipe-run must not write Composer lockfiles into the caller plugin checkout")
assert.equal(existsSync(resolve(siblingPackageSource, "vendor")), false, "recipe-run must not mutate sibling package checkouts")
assert.equal(existsSync(resolve(secondSiblingPackageSource, "vendor")), false, "recipe-run must not mutate second sibling package checkouts")

console.log("recipe run Composer autoload extra plugin smoke passed")
