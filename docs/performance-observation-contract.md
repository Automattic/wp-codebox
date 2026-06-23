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

The public WordPress runtime action helpers normalize observations across `wp_cli`, `php`, `rest_request`, `admin_page`, `page`, `browser`, `browser_probe`, and `editor_open` actions. Fields are omitted when the underlying command cannot provide them without changing command behavior.

`wordpress.run-php` captures `$wpdb` diagnostics by default through the existing command diagnostics artifact path. `wordpress.rest-request` emits an inline `source=in-process` and `kind=rest-request` performance observation in its structured JSON response. Simulated page-load commands emit `source=in-process` and `kind=simulated-page-load`. `wordpress.server-page-load` emits `source=server-http` and `kind=server-page-load`. Browser-capable actions attach browser artifact references and promote available browser summaries into the shared observation shape.

Page-load commands share the public `wp-codebox/wordpress-page-load-result/v1` result envelope. The top-level `mode` field distinguishes the execution path:

- `mode: "simulated"` is used by `wordpress.simulated-admin-page-load`, `wordpress.simulated-frontend-page-load`, and the backward-compatible `wordpress.admin-page-load` / `wordpress.frontend-page-load` aliases. These synthesize an admin or frontend request inside the WordPress PHP process and can report WordPress identity, redirects, notices, errors, optional `$wpdb` diagnostics, and in-process memory timing.
- `mode: "server-http"` is used by `wordpress.server-page-load`. It requests the runtime preview HTTP server without starting a browser, so the result includes HTTP status/headers and network timing but reports PHP memory, database, and hooks as unsupported.
- `mode: "browser"` is used by `wordpress.browser-page-load`. It wraps the existing browser-probe output with the page-load envelope while preserving browser artifact fields and recording the wrapped probe schema in `browserProbeSchema`.
