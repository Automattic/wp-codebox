# Example Consumer Boundary Contracts

WP Codebox exposes small public seams for hosts that need to prepare
browser-backed WordPress sandboxes without reading raw task payloads. The seams
are generic runtime contracts. Named products may appear in integration notes as
example consumers, but they are not runtime concepts and must not define schema
fields, package boundaries, or artifact semantics.

## Runtime Profile

`runtime-core` exports `RUNTIME_PROFILE_SCHEMA`, `RuntimeProfile`, and
`runtimeProfile()` from `@automattic/wp-codebox-core` and
`wp-codebox-workspace/core/contracts`.

Shape: `wp-codebox/runtime-profile/v1`.

- `components`: required runtime components.
- `plugins`, `mu_plugins`, `themes`: installable WordPress dependencies.
- `bootstrap`: bootstrap mode, entrypoint, steps, and `blueprint_ref`.
- `overlays`: runtime overlays applied to the sandbox.
- `env`: non-secret environment values.
- `readiness`: readiness status, checks, missing fields, and evidence.
- `provenance`: who generated the profile and from which registry/source.

## Preview Lease

`runtime-core` exports `PREVIEW_LEASE_SCHEMA`, `PreviewLease`, and
`previewLease()`.

Shape: `wp-codebox/preview-lease/v1`.

- `preview_public_url`: reviewer/public preview URL when leased by a host.
- `site_url`: canonical WordPress site URL.
- `local_url`: local browser/Playground URL.
- `lease`: lease id, status, provider, owner, and timestamps.
- `alignment`: evidence that preview, site, and local URLs point at the same
  runtime.

## Browser Session DTOs

The WordPress plugin exposes these helpers for host integrations that need a
bounded browser session handoff:

- `WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session )`
- `WP_Codebox_Browser_Task_Builder::browser_preview_boot_config( $session )`
- `wp_codebox_browser_session_product_dto` filter
- `wp_codebox_browser_preview_boot_config` filter

The DTOs include session identity, task label, target, preview boot config,
preview lease/alignment data, artifact refs, and readiness signals. They
intentionally omit raw `task_payload`, raw blueprint bodies, plugin package data,
runtime source bundles, and secret-like fields.

## Example Consumers

Studio Web, Homeboy, Static Site Importer, hosted services, CI jobs, local tools,
and other callers can consume these seams through their own adapters. Those
adapters own product-specific defaults, queue state, deploy behavior, import
semantics, and review UX. WP Codebox owns the generic runtime profile, preview
lease, browser session DTO, and artifact boundaries.
