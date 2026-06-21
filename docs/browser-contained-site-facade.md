# Browser Contained-Site Facade

The contained-site facade is the product-facing browser lane for WordPress previews. Consumers create, open, boot, and destroy Codebox contained-site sessions instead of assembling WordPress Playground boot inputs directly.

## Abilities

- `wp-codebox/create-browser-contained-site-session` creates a browser-contained WordPress site session and returns `contained_site`, `boot`, `preview_lease`, `session`, and `startup_diagnostics`.
- `wp-codebox/open-browser-contained-site` opens a stored contained-site handle when a prepared runtime is recoverable.
- `wp-codebox/boot-browser-contained-site-session` returns a product-safe boot descriptor for an existing contained-site handle.
- `wp-codebox/destroy-browser-contained-site-session` releases the preview lease and returns terminal diagnostics.

## Boundary

Consumers use `boot` as the public descriptor. It exposes Codebox session identity, preview lease, contained-site handle, and a blueprint ref hydrator. Playground fields such as `clientModuleUrl`, `remoteUrl`, runtime `scope`, and inline `blueprint` data are diagnostics for the runtime adapter; consumer boot inputs are the Codebox descriptor fields.

## Diagnostics

Every facade response includes `startup_diagnostics` with the status, reuse mode, preview lease status, boot-contract validity, and recovery handle. Clients use these diagnostics to distinguish a reusable prepared runtime from a miss or unusable boot contract.
