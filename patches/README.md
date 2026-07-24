# Temporary Playground Overlay

`@php-wasm+stream-compression+3.1.45.patch` is the built output of
WordPress Playground PR [#4110](https://github.com/WordPress/wordpress-playground/pull/4110)
at commit `afea9c042999c65f5b43bc049ca4b2bea9d8b361`.

WP Codebox needs the repaired bounded Range decoder for the Cloudflare dev rig
and browser asset path before that upstream change can be merged and released.
Remove this patch and the package override after a published Playground package
contains the same change.

`@wp-playground+cli+3.1.46.patch` makes blueprint worker threads rethrow fatal
`WebAssembly.RuntimeError` rejections originating from `php.wasm` after logging
them. Detection uses the error name because PHP-WASM errors may cross JavaScript
realm boundaries where `instanceof` is false. Other unhandled rejections retain
the released CLI's log-only behavior.
Without this narrow terminalization, a poisoned PHP-WASM worker remains alive
and leaves the parent request pending until the recipe timeout. Remove the patch
after the Playground CLI ships the same worker terminalization behavior.
