# WordPress Runtime Discovery Contract

`wordpress.runtime-discovery` exposes bounded, product-neutral discovery for a live WordPress runtime. It reports registered WordPress surfaces without adding WooCommerce, Gutenberg, Jetpack, or site-specific interpretation.

Output schema: `wp-codebox/wordpress-runtime-discovery/v1`

Accepted args:

- `surface`: comma-separated subset of `rest`, `admin`, `database`, `frontend`, `blocks`. Defaults to all surfaces.

Returned surfaces:

- `rest`: registered REST routes from `rest_get_server()->get_routes()`.
- `admin`: admin menu globals when available in the current request context, plus diagnostics when not loaded.
- `database`: WordPress table inventory from `$wpdb->tables()` with best-effort column metadata.
- `frontend`: home URL, permalink structure, public query vars, and rewrite rules.
- `blocks`: registered block types and generic editor-capable post type targets.

The contract is intentionally descriptive. Consumers should apply product-specific assertions outside WP Codebox.
