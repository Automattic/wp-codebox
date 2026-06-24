# Performance Observation Contract

WP Codebox captures performance observations for WordPress runtime actions. Observations describe what happened during an action; they are not benchmark scores, and Codebox does not execute benchmark workloads from this contract.

Action observations may include a `performance` object with schema `wp-codebox/performance-observation/v1`:

- `source`: where the observation was captured, such as `in-process`, `server-http`, or `browser`.
- `kind`: what was observed, such as `simulated-page-load`, `server-page-load`, `browser-page-load`, or `rest-request`.
- `timing`: start, finish, and duration in milliseconds when known.
- `memory`: PHP or browser memory counters when the runtime exposes them.
- `database`: query count, total query time, normalized query fingerprints, and repeated-query summaries when `$wpdb->queries` is available.
- `hooks`: hook timing summaries when a runtime provides them.
- `network`: browser request, response, failure, and transfer counters when browser artifacts include them.
- `browser`: browser metrics and admin/page summaries when browser-capable commands capture them.
- `artifactRefs`: references to diagnostics or browser artifacts that hold heavier evidence.
- `capture`: the Codebox-native capture request/report. `capture.requested.queries` records whether the caller requested query capture, and `capture.queries.status` is `captured`, `unavailable`, `partial`, or `uncaptured`.

The public WordPress runtime action helpers normalize observations across `wp_cli`, `php`, `rest_request`, `admin_page`, `page`, `browser`, `browser_probe`, and `editor_open` actions. Fields are omitted when the underlying command cannot provide them without changing command behavior.

`wordpress.run-php` captures `$wpdb` diagnostics by default through the existing command diagnostics artifact path. `wordpress.rest-request` emits an inline `source=in-process` and `kind=rest-request` performance observation in its structured JSON response. Simulated page-load commands emit `source=in-process` and `kind=simulated-page-load`. `wordpress.server-page-load` emits `source=server-http` and `kind=server-page-load`. Browser-capable actions attach browser artifact references and promote available browser summaries into the shared observation shape.

`wordpress.rest-request`, `wordpress.rest-performance-observation`, and simulated page-load commands accept `capture-json={"queries":true}` or `enable-query-capture=true`. Public TypeScript helpers expose the same request as `capture: { queries: true }` or `enableQueryCapture: true`. `wordpress.rest-performance-observation` enables query capture by default because database query summaries are its primary purpose; callers can disable it explicitly with `capture-json={"queries":false}`.

`wordpress.rest-performance-observation` is the public runtime-backed hotspot primitive for one contained WordPress REST request. It runs through the command registry/runtime-playground path and emits a top-level `wp-codebox/performance-observation/v1` envelope rather than a fuzz-suite result. The output includes captured timing and memory, normalized database query fingerprints and repeated-query summaries when query capture is requested and `$wpdb->queries` is available, and bounded hook hotspot samples captured through WordPress's `all` hook.

Limitations:

- Database query fingerprints require an explicit Codebox capture request and `$wpdb->queries`, which normally means the runtime has `SAVEQUERIES` enabled or otherwise populates that property. When not requested, `database.status` is `uncaptured` with `reason: "query_capture_not_requested"`. When requested but unavailable, `database.status` is `unavailable` with `reason: "wpdb_queries_unavailable"`.
- Hook hotspot rows are samples of hook dispatch frequency and first-to-last observed elapsed time during the request. They are useful for hotspot reporting, but they are not callback-level profiler timings.
- The command is product-neutral. Callers provide a REST route and optional parameters; product-specific route selection, assertions, and severity policy belong in downstream orchestration.
- This command is not a benchmark runner and does not claim full production fuzzing coverage.

Page-load commands share the public `wp-codebox/wordpress-page-load-result/v1` result envelope. The top-level `mode` field distinguishes the execution path:

- `mode: "simulated"` is used by `wordpress.simulated-admin-page-load`, `wordpress.simulated-frontend-page-load`, and the backward-compatible `wordpress.admin-page-load` / `wordpress.frontend-page-load` aliases. These synthesize an admin or frontend request inside the WordPress PHP process and can report WordPress identity, redirects, notices, errors, optional `$wpdb` diagnostics, and in-process memory timing.
- `mode: "server-http"` is used by `wordpress.server-page-load`. It requests the runtime preview HTTP server without starting a browser, so the result includes HTTP status/headers and network timing but reports PHP memory, database, and hooks as unsupported.
- `mode: "browser"` is used by `wordpress.browser-page-load`. It wraps the existing browser-probe output with the page-load envelope while preserving browser artifact fields and recording the wrapped probe schema in `browserProbeSchema`.
