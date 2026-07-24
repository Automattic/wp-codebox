# Temporary Playground Overlay

`@php-wasm+stream-compression+3.1.45.patch` is the built output of
WordPress Playground PR [#4110](https://github.com/WordPress/wordpress-playground/pull/4110)
at commit `afea9c042999c65f5b43bc049ca4b2bea9d8b361`.

WP Codebox needs the repaired bounded Range decoder for the Cloudflare dev rig
and browser asset path before that upstream change can be merged and released.
Remove this patch and the package override after a published Playground package
contains the same change.

`@wp-playground+cli+3.1.46.patch` makes blueprint worker threads rethrow
unhandled runtime rejections after logging them. The released CLI otherwise
keeps a poisoned PHP-WASM worker alive and leaves the parent request pending
until the recipe timeout. Remove the patch after the Playground CLI ships the
same worker terminalization behavior.
