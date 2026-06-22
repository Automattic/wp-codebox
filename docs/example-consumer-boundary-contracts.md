# Example Consumer Boundary Contracts

WP Codebox exposes small public seams for hosts that need to prepare
browser-backed WordPress sandboxes without reading raw task payloads. The seams
are generic runtime contracts. Named products may appear in integration notes as
example consumers, but they are not runtime concepts and must not define schema
fields, package boundaries, or artifact semantics.

## Public/Internal Boundary

Consumers compose WP Codebox APIs. WP Codebox owns the stable contracts and maps
the configured upstream APIs used to run a sandbox into those contracts:

- Host job, artifact, approval queue, and flow concepts map to Codebox run,
  artifact, approval, and session contracts.
- Agents API execution targets and principals map to Codebox task, provider,
  permission, and runtime-session contracts.
- Host workspace lifecycle and source-control workflow details map to
  Codebox source, workspace, evidence, and apply-back contracts.
- WordPress Playground boot, filesystem, preview, and PHP/WP-CLI details map to
  Codebox runtime, mount, command, preview, and browser-session contracts.

Public schema names, top-level DTO fields, package entrypoints, and docs intended
for consumers use Codebox vocabulary. Adapter-specific names may appear only as
opaque values in provenance, metadata, provider identifiers, diagnostics, or
example integration notes.

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
- `wp-codebox/create-browser-contained-site-session`
- `wp-codebox/boot-browser-contained-site-session`
- `wp-codebox/preview-boot-ref`
- `wp-codebox/destroy-browser-contained-site-session`
- `wp_codebox_browser_session_product_dto` filter
- `wp_codebox_browser_preview_boot_config` filter

The DTOs include session identity, task label, target, preview boot config,
preview lease/alignment data, artifact refs, and readiness signals. They
intentionally omit raw `task_payload`, raw blueprint bodies, plugin package data,
`prepared_runtime`, runtime source bundles, low-level Playground boot URLs, and
secret-like fields. Consumers that need an executable blueprint should follow the
returned blueprint hydration ref instead of storing inline Playground internals.

## Example Consumers

Hosted services, CI jobs, local tools, and other callers can consume these seams
through their own adapters. Those adapters own product-specific defaults, queue
state, deploy behavior, import semantics, and review UX. WP Codebox owns the
generic runtime profile, preview lease, browser session DTO, and artifact
boundaries.
