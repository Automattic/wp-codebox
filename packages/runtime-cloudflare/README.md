# Cloudflare Runtime Gate

This candidate integration for [wp-codebox#1838](https://github.com/Automattic/wp-codebox/issues/1838) runs WordPress through PHP-WASM and Playground in Cloudflare Workers.

## Runtime Architecture

The entry Worker executes PHP-WASM and WordPress. The named `WordPressStateCoordinator` Durable Object remains lightweight: it serializes a bounded lease and atomically promotes the current canonical R2 pointer with token, base-revision, and version checks. It never imports or instantiates PHP-WASM. State reads query the coordinator directly; every request that can observe canonical WordPress state acquires a lease first.

On cold start, the entry Worker uses the acquired pointer to rebuild PHP-WASM's disposable SQLite index from canonical MDI Markdown and JSON files. A missing pointer materializes the packaged canonical MDI seed and boots one PHP-WASM primary runtime. The build-time PHP CLI generator creates that archive from `wordpress-install-seed.sqlite` through MDI's public `bootstrap_existing_cache()` API, validates its pinned MDI revision and input digest, and never packages SQLite. The runtime updates `siteurl` and `home` through WordPress APIs using the request origin and sets the admin password from `WORDPRESS_ADMIN_PASSWORD`; only WordPress's password hash is canonical. Bootstrap persists and CAS-promotes this mutation before serving the next request.

Canonical browser, health, and mutation boots require the separately managed `WORDPRESS_AUTH_SECRET` Worker secret. The entry Worker derives the eight WordPress auth keys and salts from that secret with a versioned, site-scoped (`default`) SHA-256 domain separator before `wp-load.php`. It never logs, persists, or returns the secret or derived values. Configure it independently from the bootstrap password with `wrangler secret put WORDPRESS_AUTH_SECRET --config packages/runtime-cloudflare/wrangler.jsonc`; rotating `WORDPRESS_ADMIN_PASSWORD` does not rotate authentication salts or invalidate sessions.

After each mutating HTTP request, the entry runtime invokes MDI's explicit request-boundary flush, collects canonical files, stores immutable content-addressed R2 objects and a revision manifest, then commits the new pointer through the held lease. GET, HEAD, and asset requests release without promotion. Failed requests abort their leases; stale leases recover by token/version/expiry checks. The entry isolate can cache one runtime only for the exact acquired pointer revision and exits it after promotion or when another isolate advances the pointer. It does not persist SQLite. Existing manifests are reused when canonical file hashes have not changed.

The Worker forwards browser cookies directly to Playground and disables Playground's internal cookie store, preventing an empty per-isolate store from replacing a valid browser session after cold restart. `?phase=canonical-auth` is a boolean-only diagnostic for the canonical runtime; it reports cookie parsing and verification stages without returning credential, token, hash, or salt material.

The bundled MDI source is pinned to immutable commit `1870fb41279e7eb5946e506c9c7406f1f1ea6dc3` from [MDI PR #127](https://github.com/Automattic/markdown-database-integration/pull/127). The bundle generator, worker provenance, and source-contract test use the same revision.

The WordPress server corpus is a separate deployment artifact, never a Worker-module import. `generate:cloudflare-wordpress-runtime-corpus` uses bounded ZIP Range decoding against the pinned WordPress release, retains only `isWordPressRuntimeFile()` entries, and emits a deterministic ZIP under `artifacts/` plus the checked-in `assets/wordpress-runtime-artifact.json` provenance manifest. The immutable R2 key is derived from the corpus ZIP SHA-256. Cold boot fetches that exact object through `WORDPRESS_STATE_BUCKET`, validates the manifest and archive/file hashes and budgets, then streams it into PHP MEMFS. Static browser assets continue to use lazy exact archive ranges and Worker cache.

## Verification

1. Run `npm run generate:cloudflare-canonical-mdi-seed` and `npm run generate:cloudflare-wordpress-runtime-corpus` to regenerate deterministic runtime artifacts and manifests.
2. Run `npm run provision:cloudflare-wordpress-runtime-corpus -- --local --persist-to <directory>` to verify and upload the exact content-addressed artifact into isolated local R2 storage. Use `--remote` only for an explicit deployment operation.
3. Run `npm run test:cloudflare-runtime` for routing, canonical-state, artifact validation, source contract, and TypeScript coverage.
4. Run `npm run cloudflare:dry-run` to compile the Worker without creating Cloudflare resources.
5. Run `npm run cloudflare:local-gate` for isolated local workerd evidence. It generates and provisions the artifact before workerd starts, then injects stable test-only admin-password and auth-secret values, verifies the login form, cookie-authenticated admin redirect, authenticated REST post publication, public rendering, representative frontend/admin/editor assets, PHP diagnostics, an existing authenticated cookie after cold restart, and a fresh login after restart.

This document describes local candidate verification only. It does not claim remote deployment.
