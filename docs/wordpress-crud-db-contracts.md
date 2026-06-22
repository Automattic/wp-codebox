# WordPress CRUD and DB Operation Contracts

WP Codebox exposes two generic WordPress operation commands for runtimes that need bounded WordPress state access without product-specific adapters.

## `wordpress.crud-operation`

Input uses `wp-codebox/wordpress-crud-operation/v1` through `operation-json=<json>`.

Supported resource kinds in the Playground backend:

- `post` through `get_post`, `get_posts`, `wp_insert_post`, `wp_update_post`, and `wp_delete_post`.
- `term` through `get_term`, `get_terms`, `wp_insert_term`, `wp_update_term`, and `wp_delete_term`.
- `user` through `get_user_by`, `get_users`, `wp_insert_user`, `wp_update_user`, and `wp_delete_user`.
- `option` through `get_option`, bounded option reads, `add_option`, `update_option`, and `delete_option`.
- `metadata` or `meta` through `get_metadata`, `add_metadata`, `update_metadata`, and `delete_metadata`.

Write guardrails:

- `create`, `update`, and `delete` require `options.allowWrites=true`.
- `options.dryRun=true` validates and returns planned effects without applying writes.
- Missing write approval returns `status=error` with `write-guard-required`.

## `wordpress.db-operation`

Input uses `wp-codebox/wordpress-db-operation/v1` through `operation-json=<json>`.

Foundational supported operations:

- `schema` lists known WordPress table schemas using `SHOW TABLES` and `DESCRIBE`.
- `read` performs bounded reads against known WordPress table base names only, with scalar equality filters and a maximum limit of 100 rows.
- `query-summary` summarizes the current `$wpdb` query count or runs bounded read-only `SELECT`, `SHOW`, `DESCRIBE`, or `EXPLAIN` SQL.

DB write guardrails:

- `write` returns `status=error` with `db-write-unsupported`.
- Generic DB writes are intentionally not implemented; callers should use `wordpress.crud-operation` with explicit write approval for bounded WordPress core API writes.

Both commands return versioned result envelopes and are available from the public core facade.
