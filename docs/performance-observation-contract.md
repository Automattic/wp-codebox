# Performance Observation Contract

WP Codebox captures performance observations for WordPress runtime actions. Observations describe what happened during an action; they are not benchmark scores, and Codebox does not execute benchmark workloads from this contract.

Action observations may include a `performance` object with schema `wp-codebox/performance-observation/v1`:

- `timing`: start, finish, and duration in milliseconds when known.
- `memory`: PHP or browser memory counters when the runtime exposes them.
- `database`: query count, total query time, normalized query fingerprints, and repeated-query summaries when `$wpdb->queries` is available.
- `hooks`: hook timing summaries when a runtime provides them.
- `network`: browser request, response, failure, and transfer counters when browser artifacts include them.
- `browser`: browser metrics and admin/page summaries when browser-capable commands capture them.
- `artifactRefs`: references to diagnostics or browser artifacts that hold heavier evidence.

The public WordPress runtime action helpers normalize observations across `wp_cli`, `php`, `rest_request`, `admin_page`, `page`, `browser`, `browser_probe`, and `editor_open` actions. Fields are omitted when the underlying command cannot provide them without changing command behavior.

`wordpress.run-php` captures `$wpdb` diagnostics by default through the existing command diagnostics artifact path. `wordpress.rest-request` emits an inline performance observation in its structured JSON response. Browser-capable actions attach browser artifact references and promote available browser summaries into the shared observation shape.
