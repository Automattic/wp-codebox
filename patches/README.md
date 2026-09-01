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
