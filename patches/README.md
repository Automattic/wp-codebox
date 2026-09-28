# Temporary Playground Overlay

`@wp-playground+cli+3.1.46.patch` makes blueprint worker threads rethrow fatal
`WebAssembly.RuntimeError` rejections originating from `php.wasm` after logging
them. Detection uses the error name because PHP-WASM errors may cross JavaScript
realm boundaries where `instanceof` is false. Other unhandled rejections retain
the released CLI's log-only behavior.
Without this narrow terminalization, a poisoned PHP-WASM worker remains alive
and leaves the parent request pending until the recipe timeout. Remove the patch
after the Playground CLI ships the same worker terminalization behavior.

The manual `build-php-wasm-mysqli-poll-overlay.yml` workflow carries the C-level
`select()` wrapper and Asyncify imports from WordPress Playground PR
[#4170](https://github.com/WordPress/wordpress-playground/pull/4170). It
checksum-verifies the immutable patch and Playground revision
`581c7c172428159eb4e6c5309054a568cd39a97a`, rebuilds the PHP 8.3.32 Node
package, and verifies `mysqli_poll()` against MariaDB before uploading the
package and provenance. Remove the patch, vendored package, and workflow after
a published Playground package contains the same fix.

`runtime-overlays/php-wasm-node-8-4` carries the published `@php-wasm/node-8-4`
3.1.53 JSPI/Asyncify artifacts (Playground revision
`8cd60ace8c3d32c8cb2b569b7471fdd98f88013e`), which include the external-extension
ABI exports from WordPress Playground PR
[#4108](https://github.com/WordPress/wordpress-playground/pull/4108). The overlay
package version stays at 3.1.46 so `@php-wasm/node` 3.1.46 dedupes onto it. Remove
the overlay after the Playground driver and PHP 8.3 overlay move together onto a
release that contains both #4108 and #4170.

`@wp-playground+blueprints+3.1.46.patch` replaces the wp-cli.phar source that
Playground injects whenever a blueprint uses `extraLibraries: ["wp-cli"]`, a
`wp-cli` step, or `enableMultisite`. Upstream hardcodes
`https://playground.wordpress.net/wp-cli.phar` (still true in 3.1.56); that
host returned 403 on 2026-09-28 and blocked every Extra Chill network deploy
(#2537). The patch points at the official wp-cli build pinned by commit —
`wp-cli/builds@d2dd0416` (`phar/wp-cli.phar`, WP-CLI 2.12.0) on
raw.githubusercontent.com, which serves CORS headers for browser Playground —
and honors a `WP_CODEBOX_WP_CLI_PHAR_URL` environment override in Node. Bump
the pin deliberately when upgrading wp-cli. Remove the patch once Playground
lets callers supply the wp-cli resource.
