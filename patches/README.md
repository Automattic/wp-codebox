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

`@php-wasm+node+3.1.46.patch`, `@php-wasm+node-8-4+3.1.46.patch`, and the
compressed WASM files in
`playground-node-dns-828a14d84db0048317295443562e82aa94e0be7b/` are the Node
DNS resolver bridge and rebuilt PHP 8.4 artifacts from WordPress Playground PR
[#4172](https://github.com/WordPress/wordpress-playground/pull/4172) at immutable
commit `828a14d84db0048317295443562e82aa94e0be7b`. The lifecycle script verifies
the expanded Asyncify WASM as
`336a287c9e8addf683a42d001640daeedb8be419c3ae95497dcd59401e47ad90` and the
JSPI WASM as
`439bd91ccddfdaba7381bbd915aa17652edb8d50bd7fd2c5c81a25e33cbf8776`
before installing them. The matching loaders are upstream Git blobs
`c87527c4ec9fedfec5541a8107ac6fd7d6f2ec9a` and
`7aaf803af7022b4cc856fad675a8c1ecacb4c1c4`; the Node bundle is built from the
same commit's `packages/php-wasm/node` source.

This overlay repairs WP Codebox's default programmatic PHP 8.4 runtime only.
Explicit PHP 5.2, 7.4, 8.0, 8.1, 8.2, 8.3, and 8.5 selections still use the
released 3.1.46 artifacts and are not claimed as repaired. Remove both patches,
the compressed artifacts, and the lifecycle materialization after a published
Playground package release contains the same Node bridge and PHP 8.4 artifacts.
