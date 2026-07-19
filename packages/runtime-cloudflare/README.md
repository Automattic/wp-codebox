# Cloudflare Runtime Gate

This candidate integration for [wp-codebox#1838](https://github.com/Automattic/wp-codebox/issues/1838) runs WordPress through PHP-WASM and Playground in Cloudflare Workers.

## Runtime Architecture

All normal WordPress, health, and synthetic mutation traffic is forwarded to the named `WordPressStateCoordinator` Durable Object. The object serializes requests and owns one runtime promise. A failed boot clears that promise so the next request can retry; a successful runtime remains available for subsequent requests.

On cold start, the Durable Object reads the current R2 Markdown pointer and rebuilds PHP-WASM's disposable SQLite index from canonical MDI Markdown and JSON files. A missing or incomplete revision materializes the packaged canonical MDI seed and boots one PHP-WASM primary runtime. The build-time PHP CLI generator creates that archive from `wordpress-install-seed.sqlite` through MDI's public `bootstrap_existing_cache()` API, validates its pinned MDI revision and input digest, and never packages SQLite. The runtime updates `siteurl` and `home` through WordPress APIs using the request origin and sets the admin password from `WORDPRESS_ADMIN_PASSWORD`; only WordPress's password hash is canonical.

After each mutating HTTP request, the runtime invokes MDI's explicit request-boundary flush, collects canonical files, stores immutable content-addressed R2 objects and a revision manifest, then advances the current pointer while still serialized by the Durable Object. It does not persist SQLite. Existing manifests are reused when canonical file hashes have not changed.

The bundled MDI source is pinned to immutable commit `1870fb41279e7eb5946e506c9c7406f1f1ea6dc3` from [MDI PR #127](https://github.com/Automattic/markdown-database-integration/pull/127). The bundle generator, worker provenance, and source-contract test use the same revision.

## Verification

1. Run `npm run generate:cloudflare-canonical-mdi-seed` to regenerate the deterministic canonical MDI archive and provenance manifest.
2. Run `npm run test:cloudflare-runtime` for routing, canonical-state, generator reproducibility, filtered archive, source contract, and TypeScript coverage.
3. Run `npm run cloudflare:dry-run` to compile the Worker without creating Cloudflare resources.
4. Run `npm run cloudflare:local-gate` for isolated local workerd evidence. It injects a test admin password and verifies the login form, cookie-authenticated admin redirect, authenticated REST post publication, public rendering, representative frontend/admin assets, PHP diagnostics, and the same login/post checks after a cold restart using the persisted R2/DO state.

This document describes local candidate verification only. It does not claim remote deployment.
