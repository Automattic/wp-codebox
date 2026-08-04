# Browser Contained-Site Facade

The contained-site facade is the product-facing browser lane for WordPress previews. Consumers create, open, boot, and destroy Codebox contained-site sessions instead of assembling WordPress Playground boot inputs directly.

## Abilities

- `wp-codebox/create-browser-contained-site-session` creates a browser-contained WordPress site session and returns `contained_site`, `preview_boot`, `preview_lease`, `session`, and `startup_diagnostics`.
- `wp-codebox/open-browser-contained-site` opens a stored contained-site handle when a prepared runtime is recoverable.
- `wp-codebox/boot-browser-contained-site-session` returns a product-safe boot descriptor for an existing contained-site handle.
- `wp-codebox/destroy-browser-contained-site-session` releases the preview lease and returns terminal diagnostics.
- `wp-codebox/snapshot-browser-contained-site` returns `wp-codebox/browser-contained-site-snapshot/v1`, a validated preview contract for runtime snapshot capture.
- `wp-codebox/export-browser-contained-site` returns `wp-codebox/browser-contained-site-export/v1`, a validated replay export contract over the snapshot DTO.
- `wp-codebox/plan-browser-contained-site-apply` returns `wp-codebox/browser-contained-site-apply-plan/v1`; default mode is preview-only with `host_mutation=false`.
- `wp-codebox/apply-browser-contained-site-plan` returns `wp-codebox/browser-contained-site-apply-result/v1`; without explicit approved host mutation it only reports a preview result.
- `wp-codebox/browser-contained-site-sync-delegation` returns `wp-codebox/browser-contained-site-sync-delegation/v1`, the public sync descriptor with Codebox-owned routes and ability ids.
- `wp-codebox/browser-contained-site-sync-source-connect`, `wp-codebox/browser-contained-site-sync-manifest`, `wp-codebox/browser-contained-site-sync-export`, `wp-codebox/browser-contained-site-sync-apply-plan-generate`, `wp-codebox/browser-contained-site-sync-apply-plan-validate`, and `wp-codebox/browser-contained-site-sync-apply` are the public source connect, manifest, export, apply-plan, validation, and apply DTO operations.

## Boundary

Consumers open or create the contained site, then call `window.wpCodeboxBrowser.v1.startBrowserPreview(response.preview_boot, { iframe, signal, disposeClient, startupTimeoutMs })`. `preview_boot` is the public descriptor and requires one hydratable `blueprint_ref`; inline blueprint data is not a product response contract. A successful result preserves the existing `client` and result envelope and adds async `dispose()`. Startup has a 30-second readiness deadline by default; provide a positive `startupTimeoutMs` to override it, or `0`, `null`, or `false` to disable it for a caller-owned longer operation. Deadline expiry rejects with the structured `browser_preview_startup_timeout` runtime error. Its `data` is `wp-codebox/browser-preview-startup-timeout/v1` and includes `phase`, `timeout_ms`, `scope`, `session_id`, and completed cleanup evidence. Disposal is idempotent, resets the supplied iframe, and returns `wp-codebox/browser-preview-dispose-result/v1` cleanup evidence; it never removes the caller-owned iframe. `runtime_release_requested` records that iframe reset, while `runtime_terminated` remains false unless `disposeClient(client)` returns `{ runtime_terminated: true }`. `pending_work_cancellation_requested` records that the lifecycle stopped awaiting work; `pending_work_cancelled` remains false because the browser runtime has no cancellation API for an active import or client start. `stale_result_suppression_enabled` records that late callbacks and late client results cannot regain lifecycle ownership. A same-scope replacement terminalizes the old startup with `browser_preview_replaced`; its cleanup continues independently so an uncooperative `disposeClient` cannot delay the replacement. `disposeClient` may return void, a boolean client-release assertion, or `{ client_released?: boolean, runtime_terminated?: boolean }`; the result exposes structured assertions as `client_release_evidence`. Aborting the signal rejects startup with `browser_preview_aborted` and suppresses later Playground lifecycle callbacks.

## Diagnostics

Every facade response includes `startup_diagnostics` with the status, reuse mode, preview lease status, boot-contract validity, and recovery handle. Clients use these diagnostics to distinguish a reusable prepared runtime from a miss or unusable boot contract.

Snapshot/export/apply contracts validate the contained-site `site_id`, `session_id`, preview `scope`, and `source_digest` before returning a usable DTO. Stale source digests, session mismatches, and scope mismatches return structured `success=false` envelopes with `error.code` rather than falling through to host mutation.

## Contained-Site Sync

Consumers request sync through Codebox routes from `wp-codebox/browser-contained-site-sync-delegation`:

```json
{
  "schema": "wp-codebox/browser-contained-site-sync-delegation/v1",
  "routes": {
    "source_connect": "/wp-codebox/v1/browser-contained-site-sync/source-connect",
    "manifest": "/wp-codebox/v1/browser-contained-site-sync/manifest",
    "export": "/wp-codebox/v1/browser-contained-site-sync/export",
    "apply_plan_generate": "/wp-codebox/v1/browser-contained-site-sync/apply-plan/generate",
    "apply_plan_validate": "/wp-codebox/v1/browser-contained-site-sync/apply-plan/validate",
    "apply": "/wp-codebox/v1/browser-contained-site-sync/apply"
  }
}
```

The backend sync implementation remains an internal adapter behind Codebox filters. When no backend is installed, these operations return stable Codebox DTOs with `status: "unavailable"`; apply-plan generation still falls back to the preview-only Codebox apply-plan contract.
