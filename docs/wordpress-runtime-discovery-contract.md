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

## Fuzzing Inventory Commands

The inventory commands expose narrower public contracts for fuzzing target discovery. They do not crawl browsers or infer product behavior; they return structured WordPress inventory that the runtime can read in-process, with diagnostics when a surface is unavailable in the current request context.

- `wordpress.rest-route-inventory` returns `wp-codebox/wordpress-rest-route-inventory/v1` with registered REST route descriptors and namespaces.
- `wordpress.admin-page-inventory` returns `wp-codebox/wordpress-admin-page-inventory/v1` with already-loaded admin menu descriptors. If admin menu globals are unavailable, `status` remains structured and diagnostics include `admin-menu-not-loaded`.
- `wordpress.frontend-url-inventory` returns `wp-codebox/wordpress-frontend-url-inventory/v1` with home URL, rewrite-rule URL seeds, rewrite rules, and public query vars. This is a seed list, not a crawler result.
